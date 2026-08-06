"""按策略预设自动构建候选池（market_universe.json）。

背景与动机
----------
在此脚本之前，候选池由中枢 LLM 按 prompt 文字手工执行：
  「调 tool_filter，expression=intersect([TURNOVER_RATE > 1, PE_TTM > 0])，limit=120」

这套做法有三个已证实的缺陷：
  1. `limit=120` 是写死的编排层上限。数据源实测可返回 1000+ 只，
     120 纯属人为截断，导致「不管什么策略池子永远 120 只」。
  2. 字段名 `TURNOVER_RATE` 是错的（正确为 `TurnoverRate`），该表达式实测
     返回 0 只 → 活跃池筛选从未真正生效 → 一路回退到低估值池，
     于是「换什么策略选出来的都是同一批银行/保险/基建」。
  3. `presets.py` 的 `universe_filter` 字段没有任何代码消费，纯装饰；
     候选池是否与策略匹配，全看模型当次有没有照着 prompt 做。

本脚本把这一步**脚本化**：候选池条件不再靠 prompt 文字，而是从预设自身的
硬过滤阈值（min_turnover_pct / max_pe_ttm / max_pb）直接推导，与
`strategy/screener.py::passes_hard_filters` 的规则对齐 —— 池子里给出的票，
引擎不会因为估值/换手条件被整批过滤掉。换策略 → 池子自动跟着变。

数据源
------
腾讯自选股选股接口，经内置 westock-tool CLI 直连（与 MCP 连接器同后端）。
走 CLI 而非 MCP 的好处：不受连接器 disconnected 状态影响，可在自动化里
无人值守运行。

用法
----
    python build_universe.py --preset breakout
    python build_universe.py --profile pre_market --limit 600
    python build_universe.py --preset value_defensive --out market_universe.json
    python build_universe.py --preset youzi --dry-run      # 只打印条件不落盘

输出
----
    market_universe.json:
      {"universe": ["603407", ...], "index": "000300", "_meta": {...}}
    `_meta` 供报告溯源用（预设名/表达式/实际条数/数据源/生成时间），
    引擎与 fetch_market_data.py 只读 universe / index 两个键，不受影响。
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import subprocess
import sys

_ROOT = os.path.dirname(os.path.abspath(__file__))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from strategy.presets import STRATEGY_PRESETS, get_preset  # noqa: E402
from timeutil import sh_now  # noqa: E402

# 档位 -> 默认预设（与 stock-pick-hub Skill 的三档路由保持一致）
PROFILE_PRESET = {
    "pre_market": "breakout",
    "intraday": "momentum_chase",
    "post_market": "ma_golden",
}

# 候选池默认上限。600 只 ≈ 3 分钟取数（实测 0.33 秒/只 @workers=16）。
# 不是数据源上限——数据源单次可返回 1000+，这里只是取数耗时与覆盖度的折中。
DEFAULT_LIMIT = 600

# 池子过小时触发渐进放宽的下限
MIN_POOL = 40

# 允许进入候选池的代码前缀（沪深主板/科创/创业）。
# 排除北交所(4/8 开头)与 B 股(sh 900/sz 200)——K 线源覆盖不稳，
# 且引擎 board 判定不包含这些板块。
_ALLOWED_PREFIX = ("600", "601", "603", "605", "688", "000", "001", "002", "003", "300", "301")


# ————————————————————————— 数据源定位 —————————————————————————


def _resolve_node() -> str:
    """定位 node 可执行文件：环境变量 > 托管版本 > PATH。"""
    env = os.environ.get("NODE_BIN")
    if env and os.path.exists(env):
        return env
    managed = glob.glob(
        os.path.expanduser("~/.workbuddy/binaries/node/versions/*/node.exe")
    ) or glob.glob(os.path.expanduser("~/.workbuddy/binaries/node/versions/*/bin/node"))
    if managed:
        return sorted(managed)[-1]
    return "node"


def _resolve_westock_cli() -> str:
    """定位 westock-tool 的 scripts/index.js。"""
    env = os.environ.get("WESTOCK_TOOL_JS")
    if env and os.path.exists(env):
        return env
    candidates = [
        os.path.expandvars(
            r"%LOCALAPPDATA%\Programs\WorkBuddy\resources\app.asar.unpacked"
            r"\resources\builtin-skills\westock-tool\scripts\index.js"
        ),
    ]
    for c in candidates:
        if os.path.exists(c):
            return c
    # 兜底：在 WorkBuddy 安装目录下搜
    for pat in (
        os.path.expandvars(r"%LOCALAPPDATA%\Programs\WorkBuddy\**\westock-tool\scripts\index.js"),
        os.path.expanduser("~/.workbuddy/**/westock-tool/scripts/index.js"),
    ):
        hits = glob.glob(pat, recursive=True)
        if hits:
            return hits[0]
    raise SystemExit(
        "找不到 westock-tool CLI。请设置环境变量 WESTOCK_TOOL_JS 指向 scripts/index.js"
    )


# ————————————————————————— 条件推导 —————————————————————————


def build_conditions(preset_name: str, preset: dict) -> tuple[list[str], tuple[str, bool], str]:
    """由预设的硬过滤阈值推导候选池筛选条件。

    返回 (条件列表, (排序字段, 是否升序), 池型标签)。

    对齐 screener.passes_hard_filters：
      - 引擎要求 pe > 0 且 pb > 0（含激进预设），故池子恒带 PE_TTM > 0 / PB > 0，
        避免把名额浪费在引擎必然剔除的亏损股上。
      - 换手门槛取策略门槛的 0.8 倍：池子筛的是当下实时换手，引擎打分时
        换手会漂移，留 20% 缓冲，免得刚好卡在门槛上把边缘票全丢掉。

    ⚠️ 池型由「预设主导因子」决定（而非仅 universe_filter 二选一）。这是修复
    「换不同策略选出同一批票」的关键：13 个预设里曾有 6 个都落到同一个
    「活跃换手降序」池，于是无论选 breakout / macd_cross / youzi 都拿到同一批
    热门票。改为按各预设因子的**主导项**推导池型后，每个预设得到风格匹配的
    输入池，再叠加 run_hub 的差异化打分，选出结果自然分化。

    池型（排序方向决定池子性质，满足硬条件的票通常 3000+ 远超 limit）：
      - reversal → Chg20D 升序 + 要求 20 日为跌（RSI 反向策略，取跌得最狠的）
      - low_pe   → PE 升序（value/quality 主导：价值/红利/质量策略）
      - trend    → Chg60D 降序 + 要求为涨（trend 主导：均线多头/金叉）
      - macd     → Chg20D 降序 + 要求为涨（macd 主导：动能金叉类）
      - strong   → 自身动量窗口对应区间涨幅降序（momentum 主导：追涨/游资/突破）
      - active   → 换手降序（liquidity 主导：纯活跃量能策略）

    排序方向一旦搞反会静默失效（例：超跌策略若按换手降序取，拿到最热门追高票，
    与「超跌」意图完全相反），故 reversal 必须 Chg20D 升序且 Chg20D<0。
    """
    ov = preset.get("overrides", {})
    uf = preset.get("universe_filter", "active")
    is_reversal = ov.get("rsi_direction") == "reversal"

    conds = ["PE_TTM > 0", "PB > 0"]

    pe_max = ov.get("max_pe_ttm")
    # 10000/500 这类「放开估值」的哨兵值不必下推给数据源，徒增条件无实义
    if pe_max and pe_max < 200:
        conds.append(f"PE_TTM < {pe_max}")
    pb_max = ov.get("max_pb")
    if pb_max and pb_max < 20:
        conds.append(f"PB < {pb_max}")

    turn = ov.get("min_turnover_pct")
    gate = round(max(0.3, (turn or 0.5) * 0.8), 2)

    # 池型由「预设主导因子」决定（而非仅 universe_filter 二选一），让每个预设
    # 拿到与其风格匹配的候选池，避免「换策略选出同一批票」。
    # 因子权重与 screener.py 对齐——池子只决定「输入哪批票」，真正排序仍由
    # run_hub 按预设权重打分，这里只保证输入池风格正确。
    factors = {
        "momentum": ov.get("w_momentum") or 0.0,
        "trend": ov.get("w_trend") or 0.0,
        "macd": ov.get("w_macd") or 0.0,
        "liquidity": ov.get("w_liquidity") or 0.0,
        "rsi": ov.get("w_rsi") or 0.0,
        "value": ov.get("w_value") or 0.0,
        "quality": ov.get("w_quality") or 0.0,
    }
    dominant = max(factors, key=factors.get)

    if is_reversal:
        # 超跌池：近 20 日下跌，按跌幅从大到小取（RSI 反向策略）
        conds.append(f"TurnoverRate > {gate}")
        conds.append("Chg20D < 0")
        orderby = ("Chg20D", True)
        pool_type = "reversal"
    elif uf == "low_pe" or dominant in ("value", "quality"):
        # 低估值 / 质量池：按 PE 升序取最便宜（或质量最高）的一批
        if turn:
            conds.append(f"TurnoverRate > {round(max(0.1, turn * 0.8), 2)}")
        orderby = ("PE_TTM", True)
        pool_type = "low_pe"
    elif dominant == "trend":
        # 趋势池：中期(60日)涨幅降序，要求为涨（均线多头/金叉类）
        conds.append(f"TurnoverRate > {gate}")
        conds.append("Chg60D > 0")
        orderby = ("Chg60D", False)
        pool_type = "trend"
    elif dominant == "macd":
        # MACD 池：近期动量向上（Chg20D>0）降序，MACD 类策略的近似输入
        conds.append(f"TurnoverRate > {gate}")
        conds.append("Chg20D > 0")
        orderby = ("Chg20D", False)
        pool_type = "macd"
    elif dominant == "momentum":
        # 强势池：按自身动量窗口对应的区间涨幅降序（追涨/游资/突破类）
        conds.append(f"TurnoverRate > {gate}")
        orderby = (_chg_field(ov.get("momentum_window", 20)), False)
        pool_type = "strong"
    else:
        # 活跃池：换手降序，取最活跃的一批（流动性主导策略）
        conds.append(f"TurnoverRate > {gate}")
        orderby = ("TurnoverRate", False)
        pool_type = "active"

    return conds, orderby, pool_type


def _chg_field(window: int) -> str:
    """把策略的动量窗口映射到数据源最接近的区间涨幅字段。"""
    if window <= 7:
        return "Chg5D"
    if window <= 14:
        return "Chg10D"
    if window <= 35:
        return "Chg20D"
    return "Chg60D"


def to_expression(conds: list[str]) -> str:
    if len(conds) == 1:
        return conds[0]
    return "intersect([%s])" % ", ".join(conds)


# ————————————————————————— 拉取 —————————————————————————


def run_filter(node: str, cli: str, expression: str, limit: int,
               orderby: tuple[str, bool] | None) -> list[dict]:
    cmd = [node, cli, "filter", expression, "--limit", str(limit), "--raw"]
    if orderby:
        field, asc = orderby
        cmd += ["--orderby", field, "--asc" if asc else "--desc"]
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
    if proc.returncode != 0:
        raise RuntimeError(f"westock-tool 调用失败 rc={proc.returncode}: {proc.stderr[:300]}")
    out = (proc.stdout or "").strip()
    if not out:
        return []
    try:
        data = json.loads(out)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"westock-tool 返回非 JSON: {out[:300]}") from e
    if isinstance(data, dict):
        data = data.get("data", {}).get("stocks") or data.get("stocks") or []
    return data if isinstance(data, list) else []


def normalize_codes(rows: list[dict]) -> list[str]:
    """提取纯数字代码，剔除北交所/B股，保序去重。"""
    codes: list[str] = []
    seen: set[str] = set()
    for row in rows:
        raw = str(row.get("code") or row.get("Code") or "").strip().lower()
        num = raw[2:] if raw[:2] in ("sh", "sz", "bj") else raw
        if not num.isdigit() or len(num) != 6:
            continue
        if not num.startswith(_ALLOWED_PREFIX):
            continue
        if num in seen:
            continue
        seen.add(num)
        codes.append(num)
    return codes


def fetch_pool(node: str, cli: str, conds: list[str], orderby, limit: int,
               verbose: bool = True) -> tuple[list[str], str, list[str]]:
    """拉取候选池，池子过小时渐进放宽。

    返回 (codes, 最终生效表达式, 放宽记录)。
    """
    relaxations: list[str] = []
    attempts: list[list[str]] = [list(conds)]

    # 放宽阶梯 1：去掉估值上限（保留 PE_TTM > 0 / PB > 0 这两条引擎必需项）
    loosened = [c for c in conds if not (c.startswith("PE_TTM <") or c.startswith("PB <"))]
    if loosened != conds:
        attempts.append(loosened)
    # 放宽阶梯 2：再把换手门槛砍半
    halved = []
    for c in loosened:
        if c.startswith("TurnoverRate >"):
            val = float(c.split(">")[1])
            halved.append(f"TurnoverRate > {round(val / 2, 2)}")
        else:
            halved.append(c)
    if halved != loosened:
        attempts.append(halved)
    # 放宽阶梯 3：只留引擎必需项
    attempts.append(["PE_TTM > 0", "PB > 0"])

    last_expr = to_expression(conds)
    for i, cond_set in enumerate(attempts):
        expr = to_expression(cond_set)
        rows = run_filter(node, cli, expr, limit, orderby)
        codes = normalize_codes(rows)
        if verbose:
            print(f"  尝试{i + 1}: {expr}")
            print(f"        原始 {len(rows)} 条 → 有效代码 {len(codes)} 只")
        last_expr = expr
        if len(codes) >= MIN_POOL or i == len(attempts) - 1:
            if i > 0:
                relaxations.append(f"条件已放宽 {i} 级（原条件命中不足 {MIN_POOL} 只）")
            return codes, expr, relaxations
    return [], last_expr, relaxations


# ————————————————————————— 入口 —————————————————————————


def main() -> int:
    ap = argparse.ArgumentParser(description="按策略预设构建候选池 market_universe.json")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--preset", help=f"策略预设名，可选：{', '.join(STRATEGY_PRESETS)}")
    g.add_argument("--profile", choices=sorted(PROFILE_PRESET),
                   help="档位，按默认映射取预设：" +
                        ", ".join(f"{k}->{v}" for k, v in PROFILE_PRESET.items()))
    ap.add_argument("--limit", type=int, default=DEFAULT_LIMIT,
                    help=f"候选池上限，默认 {DEFAULT_LIMIT}（数据源单次可返回 1000+，"
                         f"上限主要受取数耗时约束：约 0.33 秒/只）")
    ap.add_argument("--out", default="market_universe.json")
    ap.add_argument("--index", default="000300", help="牛熊判定用指数")
    ap.add_argument("--dry-run", action="store_true", help="只打印筛选条件，不请求、不落盘")
    args = ap.parse_args()

    preset_name = args.preset or PROFILE_PRESET[args.profile]
    preset = get_preset(preset_name)
    if not preset:
        print(f"未知预设 {preset_name}；可选：{', '.join(STRATEGY_PRESETS)}")
        return 2

    conds, orderby, pool_type = build_conditions(preset_name, preset)
    uf = preset.get("universe_filter", "active")
    print(f"预设: {preset_name}（{preset.get('label')}｜{preset.get('risk')}）")
    print(f"池型: {pool_type}（universe_filter={uf}）   排序: {orderby[0]} {'升序' if orderby[1] else '降序'}   上限: {args.limit}")
    print(f"条件: {to_expression(conds)}")

    if args.dry_run:
        print("（dry-run，未请求数据源）")
        return 0

    node = _resolve_node()
    cli = _resolve_westock_cli()
    codes, expr, relaxations = fetch_pool(node, cli, conds, orderby, args.limit)

    if not codes:
        print("候选池为空——数据源无返回。上游异常时请回退 watchlist.json。")
        return 1

    codes = codes[: args.limit]
    payload = {
        "universe": codes,
        "index": args.index,
        "_meta": {
            "preset": preset_name,
            "preset_label": preset.get("label"),
            "universe_filter": uf,
            "pool_type": pool_type,
            "expression": expr,
            "orderby": f"{orderby[0]} {'asc' if orderby[1] else 'desc'}",
            "limit": args.limit,
            "count": len(codes),
            "source": "腾讯自选股 westock-tool filter (CLI 直连)",
            "relaxations": relaxations,
            "generated_at": sh_now().isoformat(timespec="seconds"),
        },
    }
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

    for note in relaxations:
        print(f"  ⚠️ {note}")
    print(f"已写出 {args.out}：候选池 {len(codes)} 只")
    print(f"  前 5：{codes[:5]}")
    print(f"  后 5：{codes[-5:]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
