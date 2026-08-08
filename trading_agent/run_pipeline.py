"""选股中枢 · 单脚本编排（方案 A：把 10 步 LLM 流水线压缩为 1 次脚本调用）。

背景
----
stock-pick-hub Skill 的完整中枢是 10 步 LLM 编排（读 .env -> MCP 扫池 -> 写
universe -> 取数 -> 校验 -> 补齐 -> 引擎 -> 拼报告 -> 推送核对），每步之间
都有「模型推理 + 工具往返」的固定延迟，累计 3~8 分钟，用户手动触发时体感
「很慢很慢很慢」。

本脚本把 **步骤 4（取数）→ 4d（完整性校验）→ 4e（当日补齐）→ 6（引擎）
→ 7（合并报告）** 合并为一次进程内执行，LLM 只需：
  1. 调 MCP tool_filter 生成 market_universe.json（唯一无法脚本化的环节——
     本机无 westock-tool CLI、MCP 代理需授权，候选池只能走连接器）；
  2. 执行 `python dev/run_pipeline.py --profile <档位>`；
  3. 读取脚本打印的「结论块」收尾。

复用既定脚本（dev/fetch_market_data.py / run_hub.py / patch_klines_tencent.py /
dev/_patch_today_bar.py），**不修改任何引擎源码**。

用法
----
    PY dev/run_pipeline.py --profile pre_market                 # 盘前（默认）
    PY dev/run_pipeline.py --profile intraday                   # 盘中
    PY dev/run_pipeline.py --profile post_market                # 盘后（收盘后跑，自动 4e 补齐当日 bar）
    PY dev/run_pipeline.py --profile post_market --mode swing   # 指定操作模式
    PY dev/run_pipeline.py --profile pre_market --universe TA/market_universe.json  # 显式指定候选池
    PY dev/run_pipeline.py --profile pre_market --dry-run       # 只打印将执行的命令

退出码
------
    0 成功（报告已写出，企微推送状态见结论块）
    2 候选池不可用（需先用 MCP tool_filter 生成 market_universe.json，或 --universe）
    3 取数/补齐失败（详见日志）
    4 引擎运行失败（详见日志）
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.request

_ROOT = os.path.dirname(os.path.abspath(__file__))  # trading_agent/（脚本位于根目录）
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

# —— 环境约定（与 stock-pick-hub Skill 一致）——
PY = os.environ.get(
    "STOCK_PY",
    r"C:/Users/xilasuo/.workbuddy/binaries/python/versions/3.13.12/python.exe",
)
if not os.path.exists(PY):
    PY = "python3"  # 回退
TA = _ROOT
ENV_FILE = os.path.join(os.path.dirname(_ROOT), ".env")  # D:/code/AICode/AIStock/.env

PROFILE_PRESET = {
    "pre_market": "breakout",
    "intraday": "momentum_chase",
    "post_market": "ma_golden",
}

# 收盘后（>=15:00 上海时间）运行盘后/盘中档时，需要补当日 bar（上游日线结算延迟）
_PM_PATCH_AFTER = 15 * 60


def log(msg: str):
    print(f"[pipeline] {msg}", flush=True)


def _load_env() -> dict[str, str]:
    """解析 .env 的 KEY=VALUE 行，返回环境变量覆盖。"""
    env = dict(os.environ)
    if not os.path.exists(ENV_FILE):
        return env
    with open(ENV_FILE, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            env[k.strip()] = v.strip()
    return env


def _run(cmd: list[str], cwd: str = TA, env: dict | None = None,
         timeout: int | None = 900) -> subprocess.CompletedProcess:
    """执行子进程并透传输出；非零退出码抛出 RuntimeError。"""
    log("$ " + " ".join(cmd))
    t0 = time.time()
    proc = subprocess.run(
        cmd, cwd=cwd, env=env, text=True, encoding="utf-8",
        errors="replace", timeout=timeout,
    )
    log(f"退出码 {proc.returncode}，耗时 {time.time() - t0:.1f}s")
    if proc.returncode != 0:
        raise RuntimeError(f"命令失败 rc={proc.returncode}: {' '.join(cmd)}")
    return proc


def _shanghai_hm() -> tuple[int, int]:
    """上海时间 h/m。"""
    import datetime as _dt
    now = _dt.datetime.now(_dt.timezone(_dt.timedelta(hours=8)))
    return now.hour, now.minute


def _is_today(date_str: str | None) -> bool:
    import datetime as _dt
    if not date_str:
        return False
    return date_str[:10] == _dt.datetime.now(_dt.timezone(_dt.timedelta(hours=8))).strftime("%Y-%m-%d")


# ————————————————————————— 步骤 4：取数 —————————————————————————


def step_fetch(universe_file: str, out: str, env: dict, dry: bool) -> None:
    """fetch_market_data.py 全量取数。"""
    log("步骤 4 · 批量取数（600 只 K线+估值，缓存命中约 20~30s / 冷跑 2~5min）")
    if dry:
        log("  [dry-run] " + f"{PY} dev/fetch_market_data.py {os.path.relpath(universe_file, TA)} --out {os.path.relpath(out, TA)}")
        return
    _run([
        PY, "dev/fetch_market_data.py",
        os.path.relpath(universe_file, TA),
        "--out", os.path.relpath(out, TA),
    ], env=env)


# ————————————————————————— 步骤 4d：完整性校验 + 腾讯补齐 —————————————————————————


def check_kline_completeness(prefetched: str) -> tuple[int, int, int]:
    """返回 (有K线数, universe总数, 指数K线数)。"""
    with open(prefetched, encoding="utf-8") as f:
        d = json.load(f)
    kl = d.get("klines", {})
    u = d.get("universe", [])
    ok = sum(1 for c in u if kl.get(c))
    idx = len(kl.get("000300") or [])
    return ok, len(u), idx


def step_verify_and_patch(prefetched: str, env: dict, dry: bool) -> None:
    """4d：清毒化空缓存 + 腾讯补齐缺失 K 线（含指数）。"""
    log("步骤 4d · K线完整性校验")
    if dry:
        log("  [dry-run] 校验 + 腾讯补齐（patch_klines_tencent.py）")
        return

    ok, total, idx = check_kline_completeness(prefetched)
    log(f"  校验：有K线 {ok}/{total}，指数K线 {idx}")
    if ok == total and idx >= 60:
        log("  完整性 OK，无需补齐")
        return

    # ① 清毒化空缓存（内容为 "[]" 的 2 字节文件）
    cache_dir = os.path.join(TA, "cache")
    purged = 0
    if os.path.isdir(cache_dir):
        for fn in os.listdir(cache_dir):
            if fn.startswith("kline_") and fn.endswith(".json"):
                p = os.path.join(cache_dir, fn)
                try:
                    if os.path.getsize(p) < 3:
                        os.remove(p)
                        purged += 1
                except OSError:
                    pass
    if purged:
        log(f"  已清理毒化空缓存 {purged} 个，将回源重取")

    # ② 用腾讯 proxy.finance.qq.com 补齐（0.3s/只；与 westock 同后端）
    patch_script = os.path.join(os.path.dirname(TA), "..", "..", "WorkBuddy", "Claw", "patch_klines_tencent.py")
    # 优先使用已记录的绝对路径
    patch_candidates = [
        os.path.expandvars(r"C:\Users\xilasuo\WorkBuddy\Claw\patch_klines_tencent.py"),
        patch_script,
    ]
    patch = next((p for p in patch_candidates if os.path.exists(p)), None)
    if not patch:
        log("  ⚠️ 未找到腾讯补齐脚本 patch_klines_tencent.py，跳过补齐（结果可能不完整）")
        return
    _run([PY, patch, prefetched, "--index", "000300", "--workers", "8"], env=env)

    ok, total, idx = check_kline_completeness(prefetched)
    log(f"  补齐后复检：有K线 {ok}/{total}，指数K线 {idx}")
    if ok != total:
        log("  ⚠️ 仍有缺失 K 线（次新股上市天数不足属正常），引擎将仅对有K线的票打分")


# ————————————————————————— 步骤 4e：收盘后补当日 bar —————————————————————————


def step_patch_today(prefetched: str, env: dict, dry: bool) -> None:
    """4e：盘后/盘中档运行于收盘后时，补当日 K 线（个股快照合成 + 指数 qt.gtimg 合成）。"""
    log("步骤 4e · 收盘后补当日 bar")
    if dry:
        log("  [dry-run] 用实时快照补当日 bar（_patch_today_bar.py）")
        return

    ok, _, idx = check_kline_completeness(prefetched)
    if idx == 0:
        log("  ⚠️ 指数 K 线缺失，跳过 4e（引擎牛熊判定将失真）")
        return

    # 判断指数末根 bar 是否当天
    with open(prefetched, encoding="utf-8") as f:
        d = json.load(f)
    idx_bars = d.get("klines", {}).get("000300") or []
    if idx_bars and _is_today(idx_bars[-1].get("date")):
        log("  指数已含当日 bar，无需补齐")
        return

    # 指数当日 bar 由 qt.gtimg 快照合成（vals[3]=收盘/新价, [5]=今开, [33]=最高,
    # [34]=最低, [37]=成交额万元→×10000 得 amount; volume=round(amount/avg(高,低,收))）
    import datetime as _dt
    today = _dt.datetime.now(_dt.timezone(_dt.timedelta(hours=8))).strftime("%Y-%m-%d")
    index_bar = None
    try:
        url = "https://qt.gtimg.cn/q=sh000300"
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=10) as r:
            raw = r.read().decode("gbk", errors="replace")
        v = raw.split('"')[1].split("~")
        close = float(v[3]); op = float(v[5]); hi = float(v[33]); lo = float(v[34])
        amt = float(v[37]) * 10000.0
        avg = (hi + lo + close) / 3.0
        vol = int(round(amt / avg)) if avg > 0 else 0
        index_bar = {"open": op, "high": hi, "low": lo, "close": close,
                     "volume": vol, "amount": amt}
    except Exception as e:  # noqa: BLE001
        log(f"  ⚠️ 合成指数当日 bar 失败：{e}，跳过 4e")

    script = os.path.join(TA, "dev", "_patch_today_bar.py")
    cmd = [PY, "dev/_patch_today_bar.py", os.path.relpath(prefetched, TA),
           "--date", today]
    if index_bar:
        cmd += ["--index-bar", json.dumps(index_bar, ensure_ascii=False)]
    _run(cmd, env=env)
    log("  当日 bar 已补齐，引擎将基于含当日数据打分")


# ————————————————————————— 步骤 6：引擎 —————————————————————————


def step_engine(prefetched: str, profile: str, mode: str | None, env: dict, dry: bool) -> None:
    """run_hub.py：云端配置 + 打分 + 回写 + 企微双推（脚本内自动完成）。"""
    log("步骤 6 · 运行引擎（云端配置 + 打分 + 回写 + 企微双推）")
    cmd = [PY, "run_hub.py", "--prefetched", os.path.relpath(prefetched, TA),
           "--profile", profile]
    if mode:
        cmd += ["--mode", mode]
    if dry:
        log("  [dry-run] " + " ".join(cmd))
        return
    _run(cmd, env=env)


# ————————————————————————— 步骤 7：合并报告 —————————————————————————


def _read_json(path: str) -> dict:
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:  # noqa: BLE001
        return {}


def build_report(profile: str) -> str:
    """读 scan_summary / strategy_snapshot / cloud_strategy_receipt / universe._meta，
    生成一份「策略+结果+溯源」合并 Markdown（供 LLM 收尾直接引用，也可推送）。"""
    summary = _read_json(os.path.join(TA, "scan_summary.json"))
    snapshot = _read_json(os.path.join(TA, "strategy_snapshot.json"))
    receipt = _read_json(os.path.join(TA, "cloud_strategy_receipt.json"))
    universe = _read_json(os.path.join(TA, "market_universe.json"))
    meta = universe.get("_meta", {}) if isinstance(universe, dict) else {}

    lines: list[str] = []
    profile_cn = {"pre_market": "盘前", "intraday": "盘中", "post_market": "盘后"}.get(profile, profile)
    lines.append(f"# 选股中枢 · {profile_cn} {profile}")
    lines.append("")

    # 一、策略快照
    scr = snapshot.get("screener", {}) or {}
    mkt = snapshot.get("market", {}) or {}
    sig = snapshot.get("signal", {}) or {}
    lines.append("## 一、策略快照")
    lines.append("")
    lines.append(f"| 项 | 值 |")
    lines.append(f"|---|---|")
    lines.append(f"| profile | {snapshot.get('profile', profile)} |")
    lines.append(f"| 来源 | {snapshot.get('source', '—')} |")
    sha = snapshot.get("config_sha256_8") or snapshot.get("config_sha256", "")
    lines.append(f"| 配置 SHA 指纹 | `{sha}` |")
    lines.append(f"| top_n / max_per_sector | {scr.get('top_n', '—')} / {scr.get('max_per_sector', '—')} |")
    weights = {k: v for k, v in scr.items() if k.startswith("w_") and isinstance(v, (int, float))}
    if weights:
        wstr = " · ".join(f"{k.replace('w_', '')} {v:.2f}" for k, v in sorted(weights.items()))
        lines.append(f"| 因子权重 | {wstr} |")
    if mkt.get("enable") is not None:
        lines.append(f"| 市场状态判定 | {'已启用' if mkt.get('enable') else '未启用'}（index {mkt.get('index_code', '—')}，ma_window {mkt.get('ma_window', '—')}） |")
    lines.append(f"| 止损 / 最大持仓 | {sig.get('stop_loss_pct', '—')}% / {sig.get('max_positions', '—')} |")
    lines.append("")

    # 二、入选结果
    selected = summary.get("selected", []) or []
    lines.append("## 二、入选结果")
    lines.append("")
    lines.append(f"候选池 {summary.get('universeSize', '—')} 只 → 入选 {summary.get('selectedCount', len(selected))} 只")
    if summary.get("marketState"):
        ms = summary["marketState"]
        lines.append(f"市场状态：{ms.get('state', '—')}（仓位系数 {ms.get('positionFactor', '—')}）")
    lines.append("")
    if selected:
        lines.append("| 代码 | 名称 | 得分 | 动量% | PE | PB | 换手% |")
        lines.append("|---|---|---|---|---|---|---|")
        for r in selected:
            lines.append(
                f"| {r.get('code', '')} | {r.get('name', '')} | "
                f"{r.get('score', 0):.2f} | {r.get('momentum', 0) * 100:.1f} | "
                f"{r.get('peTtm', '—')} | {r.get('pb', '—')} | "
                f"{r.get('turnover', '—')} |"
            )
        lines.append("")
    bm = summary.get("backtest", {}).get("baseMetrics", {}) or {}
    if bm:
        lines.append(f"基准回测：交易 {bm.get('trades', '—')} 笔 ｜ 总收益 "
                     f"{(bm.get('totalReturn', 0) * 100):.2f}% ｜ 夏普 {bm.get('sharpe', '—')} ｜ "
                     f"最大回撤 {(bm.get('maxDrawdown', 0) * 100):.2f}%")
        lines.append("")

    # 三、候选池溯源
    if meta:
        lines.append("## 三、候选池溯源")
        lines.append("")
        lines.append(f"- 数据源：{meta.get('source', '—')}")
        lines.append(f"- 预设 / 池型：{meta.get('preset', '—')} / {meta.get('pool_type', '—')}")
        lines.append(f"- 表达式：`{meta.get('expression', '—')}`")
        lines.append(f"- 排序：{meta.get('orderby', '—')} ｜ limit {meta.get('limit', '—')} ｜ count {meta.get('count', '—')}")
        relax = meta.get("relaxations") or []
        if relax:
            for note in relax:
                lines.append(f"- ⚠️ {note}")
        lines.append("")

    # 四、策略溯源凭证
    if receipt:
        lines.append("## 四、策略溯源凭证")
        lines.append("")
        lines.append(f"- source={receipt.get('source', '—')}")
        lines.append(f"- endpoint={receipt.get('endpoint', '—')}")
        lines.append(f"- fetched_at={receipt.get('fetched_at', '—')} ｜ http_status={receipt.get('http_status', '—')} ｜ login_ok={receipt.get('login_ok', '—')}")
        lines.append(f"- config_sha256={receipt.get('config_sha256', '—')}")
        if receipt.get("source") == "local-fallback":
            lines.append(f"- ⚠️ 本次策略未来自云端，已回退本地配置（{receipt.get('note', '')}）")
        lines.append("")

    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser(description="选股中枢单脚本编排（方案 A）")
    ap.add_argument("--profile", choices=sorted(PROFILE_PRESET), default="pre_market",
                    help=f"时段档位，默认 pre_market（预设映射 {PROFILE_PRESET}）")
    ap.add_argument("--mode", default=None, choices=["ultra_short", "short", "swing", "long"],
                    help="操作模式角色卡（可选，缺省走 prefetched/env/默认）")
    ap.add_argument("--universe", default=os.path.join(TA, "market_universe.json"),
                    help="候选池文件（默认 TA/market_universe.json，须已由 MCP tool_filter 生成）")
    ap.add_argument("--prefetched", default=os.path.join(TA, "prefetched.json"),
                    help="取数输出（默认 TA/prefetched.json）")
    ap.add_argument("--dry-run", action="store_true", help="只打印将执行的命令")
    args = ap.parse_args()

    t_start = time.time()
    log(f"选股中枢单脚本编排开始 profile={args.profile} mode={args.mode or 'auto'}")
    env = _load_env()

    # ——— 候选池检查（步骤 1+2 由 LLM 经 MCP 完成，此处只校验） ———
    if not os.path.exists(args.universe):
        log(f"❌ 候选池文件不存在：{args.universe}")
        log("   请先用 MCP tool_filter 生成（按当前档位 expression/orderby，limit=600），"
            "再重跑本脚本；或 --universe 指定已有文件。")
        return 2
    with open(args.universe, encoding="utf-8") as f:
        u = json.load(f)
    codes = u.get("universe") or []
    if not codes:
        log("❌ 候选池 universe 为空")
        return 2
    meta = u.get("_meta", {})
    log(f"候选池 {len(codes)} 只（preset={meta.get('preset', '?')}，"
        f"pool_type={meta.get('pool_type', '?')}，generated_at={meta.get('generated_at', '?')}）")

    # ——— 步骤 4/4d/4e/6/7 ———
    try:
        step_fetch(args.universe, args.prefetched, env, args.dry_run)
        if not args.dry_run:
            step_verify_and_patch(args.prefetched, env, args.dry_run)
            # 收盘后（>=15:00 上海时间）运行盘后/盘中档 → 补当日 bar
            h, m = _shanghai_hm()
            if (h * 60 + m) >= _PM_PATCH_AFTER and args.profile in ("post_market", "intraday"):
                step_patch_today(args.prefetched, env, args.dry_run)
        step_engine(args.prefetched, args.profile, args.mode, env, args.dry_run)
    except RuntimeError as e:
        log(f"❌ 流水线失败：{e}")
        return 3

    # ——— 合并报告 ———
    if not args.dry_run:
        report = build_report(args.profile)
        report_path = os.path.join(TA, "reports", f"pipeline_report_{args.profile}.md")
        os.makedirs(os.path.dirname(report_path), exist_ok=True)
        with open(report_path, "w", encoding="utf-8") as f:
            f.write(report)
        log(f"合并报告已写出：{report_path}")
    else:
        report = "（dry-run，未生成报告）"

    log(f"✅ 流水线完成，总耗时 {time.time() - t_start:.1f}s")
    print("\n" + "=" * 60)
    print("【结论块 · 供收尾直接引用】")
    print("=" * 60)
    print(report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
