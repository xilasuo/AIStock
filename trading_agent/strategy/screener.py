"""选票（选股）模块

多因子打分从候选池中选出 top_n 只标的。因子分两大类：

  技术面（由日线收盘价计算）：
    - 风险调整动量：近 momentum_window 日收益 ÷ 年化波动率（杜绝高波动假强势）
    - RSI(14)：偏好 50~70 健康强势，超买(>70)递减，弱势(<50)偏低
    - MACD 动能：MACD 柱为正且相对价格放大
    - 趋势强度：现价相对长期均线的位置（±20% 映射到 0~1）
  基本面 / 市场面（由行情快照计算）：
    - 估值复合：1/PE 与 1/PB 各半（越便宜越高分）
    - 流动性：最新换手率
    - 规模：总市值对数（越大越稳）
    - 质量（可选）：ROE + 股息率 —— 仅当 quote 提供时启用，缺失自动跳过
    - 资金流（可选）：主力净流入占流通市值比 —— 仅当 quote 提供 fund_flow 时启用，
      缺失自动跳过。资金流与动量是**两个独立维度**：动量看「价格涨跌」，
      资金流看「主力资金净进出」，避免只选出「涨得好但主力在出货」的票。

因子在候选池内做稳健 z-score 归一化（截断 ±3σ）再 min-max 到 [0,1]，
按 config 权重加权求和；权重在运行时根据"实际可用的因子"重新归一化，
因此缺失因子（如无可比市值、无质量数据）不会破坏打分。

打分排序后施加「行业分散约束」（config.max_per_sector）：贪心选取，
单一行业最多入选 max_per_sector 只，避免一次选出 top_n 只同属一个板块。
行业取自行情快照的 sector 字段，缺失时回退 data.sectors 静态映射表。
约束生效后实际入选数可能少于 top_n；设 max_per_sector >= top_n 即关闭约束。
"""
from __future__ import annotations

import math

import config
from data import provider
from data import sectors
from . import indicators


def _guess_board(code: str, name: str) -> str:
    """根据代码前缀推断所属板块。

    Returns:
        "main"(主板), "cyb"(创业板), "kc"(科创板), "bj"(北交所)
    """
    # 科创板（688 开头，以及 68 开头的极少见变体）必须最先判断，
    # 否则会被下面的 "6" 主板分支提前拦截。
    if code.startswith("688") or code.startswith("68"):
        return "kc"
    if code.startswith("3"):
        return "cyb"
    if code.startswith(("8", "4")):
        return "bj"
    if code.startswith(("6", "0", "9")):
        return "main"
    # 名称兜底：含"科创"→kc，含"北交"→bj
    if "科创" in name:
        return "kc"
    if "北交" in name or "BJ" in code.upper():
        return "bj"
    return "main"


def _robust_normalize(vals: list[float]) -> list[float]:
    """稳健 z-score（截断 ±3σ）后 min-max 到 [0,1]。

    恒等分布（标准差≈0）时返回全 0.5，避免除零与极端权重。
    """
    if not vals:
        return []
    n = len(vals)
    mean = sum(vals) / n
    var = sum((x - mean) ** 2 for x in vals) / n
    std = math.sqrt(var)
    if std < 1e-12:
        return [0.5 for _ in vals]
    zs = [max(-3.0, min(3.0, (x - mean) / std)) for x in vals]
    lo, hi = min(zs), max(zs)
    if hi - lo < 1e-12:
        return [0.5 for _ in vals]
    return [(z - lo) / (hi - lo) for z in zs]


def _rsi_factor(rsi_val: float) -> float:
    """把 RSI(0~100) 映射为 0~1 选股偏好：偏好 50~70 健康强势，
    超买(>70)线性衰减，弱势(<50)线性偏低。"""
    r = rsi_val
    if r <= 50:
        return 0.6 * (r / 50.0)
    if r <= 70:
        return 0.6 + 0.4 * ((r - 50) / 20.0)
    return max(0.5, 1.0 - 0.5 * ((r - 70) / 30.0))


def _median(xs: list[float]) -> float:
    if not xs:
        return 0.0
    s = sorted(xs)
    m = len(s) // 2
    return s[m] if len(s) % 2 else (s[m - 1] + s[m]) / 2.0


# —— 入选理由（解释性）——
# 把归一化因子贡献翻译成一句人话，让用户一眼看懂「为什么选它」。
# 与前端「为什么选这些票」卡片配套；缺失/异常时优雅降级为评分句。
_FACTOR_PHRASE_FN = {
    "momentum": lambda r: (lambda m: (
        f"动量强劲（{m * 100:.1f}%）" if m > 0.08 else
        f"动量温和（{m * 100:.1f}%）" if m > 0.03 else
        f"动量偏弱（{m * 100:.1f}%）" if m > 0 else
        f"动量走弱（{m * 100:.1f}%）"
    ))(r.get("momentum") or 0),
    "rsi": lambda r: (lambda v: (
        f"RSI超卖（{v:.0f}）" if v <= 35 else
        f"RSI超买（{v:.0f}）" if v >= 70 else
        f"RSI中性（{v:.0f}）"
    ))(r.get("rsi") or 50),
    "macd": lambda r: (lambda v: (
        "MACD金叉" if v >= 0.6 else "MACD走弱" if v <= 0.4 else "MACD平稳"
    ))(r.get("macd") or 0.5),
    "trend": lambda r: (lambda v: (
        "站上均线（趋势向上）" if v >= 0.6 else "跌破均线" if v <= 0.4 else "均线缠绕"
    ))(r.get("trend") or 0.5),
    "value": lambda r: (
        f"估值偏低（PE {r.get('pe_ttm') or 0:.1f}/PB {r.get('pb') or 0:.1f}）"
        if r.get("pe_ttm") and r.get("pb") else "估值合理"
    ),
    "liquidity": lambda r: f"成交活跃（换手 {(r.get('turnover') or 0):.1f}%）",
    "fund_flow": lambda r: (
        (f"主力净流入（{r['fund_flow_pct']:.1f}‰）" if r["fund_flow_pct"] > 0
         else f"主力净流出（{r['fund_flow_pct']:.1f}‰）")
        if r.get("fund_flow_pct") is not None else None
    ),
    "quality": lambda r: (
        f"盈利质量高（ROE {r['roe']:.1f}%）" if r.get("roe") is not None else
        f"高股息（{r['dividend_yield']:.1f}%）" if r.get("dividend_yield") is not None else
        None
    ),
    "size": lambda r: None,  # 规模中性，不单列
}


def _build_rationale(r):
    """根据归一化因子贡献生成一句话入选理由。"""
    contrib = r.get("factor_scores") or {}
    if not contrib:
        return ""
    ranked = sorted(contrib.items(), key=lambda kv: kv[1], reverse=True)
    # 取贡献分 >= 0.5 的因子；不足 2 个则退而取前 2 名（相对最强项）
    top = [k for k, v in ranked if v >= 0.5]
    if len(top) < 2:
        top = [k for k, _ in ranked[:2]]
    phrases = []
    for k in top:
        fn = _FACTOR_PHRASE_FN.get(k)
        if not fn:
            continue
        p = fn(r)
        if p:
            phrases.append(p)
    if not phrases:
        return f"多因子综合评分 {r.get('score', 0):.2f}"
    return " + ".join(phrases) + f"｜综合评分 {r.get('score', 0):.2f}"


def screen(cfg: config.AppConfig, codes: list[str], dp=None, top_n_override: int | None = None) -> list[dict]:
    """返回按综合得分降序排列的候选标的列表（含因子明细）。

    dp: DataProvider（可注入）。None 时回退默认数据源（腾讯/东财直连）。
    top_n_override: 可选，覆盖 cfg.screener.top_n（用于市场状态缩放选股数，
                    如熊市降至 0=空仓）。None 时用配置值。
    """
    sc = cfg.screener
    dp = dp or provider.default_provider()
    rows: list[dict] = []

    for code in codes:
        try:
            kline = dp.fetch_kline(code, cfg.beg, cfg.end)
            quote = dp.fetch_quote(code)
        except Exception:
            continue
        if not kline or len(kline) < sc.momentum_window + 2:
            continue

        pe = quote.get("pe_ttm") or 0
        pb = quote.get("pb") or 0
        turnover = quote.get("turnover_pct") or 0
        # 资金流：主力净流入（元）。若数据源提供了才纳入；与流通市值归一化后作为因子
        fund_flow_raw = quote.get("fund_flow")  # 主力净流入额（元），可能为 None
        float_mcap_yi = quote.get("float_mcap_yi") or 0.0
        fund_flow_pct = None
        if fund_flow_raw is not None and float_mcap_yi > 0:
            try:
                # 净流入占流通市值比例（千分比，正值=主力净流入、负值=净流出）
                fund_flow_pct = (float(fund_flow_raw) / (float_mcap_yi * 1e8)) * 1000.0
            except (TypeError, ValueError):
                fund_flow_pct = None
        # 硬性过滤：流动性差 / 估值过高 / 估值无效
        if turnover < sc.min_turnover_pct:
            continue
        if pe <= 0 or pe > sc.max_pe_ttm:
            continue
        if pb <= 0 or pb > sc.max_pb:
            continue

        # 前置条件过滤：板块 / ST / 流通市值
        name = quote.get("name") or code
        # 板块过滤（基于代码前缀或名称）
        _board = _guess_board(code, name)
        if sc.boards and _board not in sc.boards:
            continue
        # ST 过滤
        is_st = "ST" in name.upper() or "*" in name or "退" in name
        if sc.st_filter == "exclude_st" and is_st:
            continue
        # 兼容文档约定的 "include_st" 与代码旧名 "only_st"（二者均表示「仅选 ST」）
        if sc.st_filter in ("only_st", "include_st") and not is_st:
            continue
        # 流通市值过滤（亿元）
        mcap_yi = quote.get("mcap_yi") or 0.0
        if sc.mcap_min > 0 and mcap_yi < sc.mcap_min:
            continue
        if sc.mcap_max > 0 and mcap_yi > sc.mcap_max:
            continue

        closes = [float(b["close"]) for b in kline if b.get("close") is not None]
        if len(closes) < sc.momentum_window + 2:
            continue

        # —— 原始因子计算 ——
        mom = closes[-1] / closes[-(sc.momentum_window + 1)] - 1.0
        vol = indicators.rolling_vol(closes, sc.vol_window)
        risk_adj_mom = (mom / vol) if vol > 1e-9 else 0.0
        rsi_val = indicators.rsi(closes, sc.rsi_window)
        _, _, hist = indicators.macd(closes, sc.macd_fast, sc.macd_slow, sc.macd_signal)
        macd_raw = (
            0.5 + 0.5 * max(-1.0, min(1.0, hist / (0.03 * closes[-1])))
            if closes[-1]
            else 0.5
        )
        slow_ma = sum(closes[-sc.momentum_window:]) / sc.momentum_window
        trend_raw = (
            0.5 + 0.5 * max(-1.0, min(1.0, (closes[-1] / slow_ma - 1.0) / 0.2))
            if slow_ma
            else 0.5
        )
        ey = 1.0 / pe if pe > 0 else 0.0
        pb_inv = 1.0 / pb if pb > 0 else 0.0
        mcap = quote.get("mcap_yi") or quote.get("float_mcap_yi") or 0.0
        size_raw = math.log(mcap) if mcap > 0 else None
        roe = quote.get("roe")
        dy = quote.get("dividend_yield")
        quality_raw = None
        # 质量因子：ROE 或 股息率 任一存在即启用（数据源可能只给其一）
        if roe is not None or dy is not None:
            try:
                r = float(roe) if roe is not None else 0.0
                d = float(dy) if dy is not None else 0.0
                quality_raw = r / 100.0 + d / 100.0
            except (TypeError, ValueError):
                quality_raw = None

        # 行业：优先行情快照提供的 sector，缺失回退静态映射（覆盖蓝筹池）。
        # 注意：静态表只覆盖有限蓝筹池，全市场扫描时大量个股回退为 '其他'，
        # 若直接归桶会让 max_per_sector 把所有"其他"票当成同一行业一刀切。
        # 因此未知行业在内部按代码各自独立，只让"真实行业"受分散约束；
        # 对外展示仍保留"其他"，避免把股票代码误当成行业名称。
        _sector_raw = quote.get("sector") or sectors.industry_of(code)
        _sector = "其他" if (_sector_raw in (None, "", "其他")) else _sector_raw

        rows.append({
            "code": code,
            "name": quote.get("name", code),
            "sector": _sector,
            "momentum": mom,
            "risk_adj_momentum": risk_adj_mom,
            "rsi": rsi_val,
            "macd": macd_raw,
            "trend": trend_raw,
            "earnings_yield": ey,
            "pb_inverse": pb_inv,
            "turnover": turnover,
            "size": size_raw,
            "quality": quality_raw,
            "pe_ttm": pe,
            "pb": pb,
            "mcap_yi": mcap,
            # 基本面（质量因子来源；缺省为 None，供 payload 透传展示）
            "roe": quote.get("roe"),
            "dividend_yield": quote.get("dividend_yield"),
            # 资金流（主力净流入占流通市值千分比；数据源未提供则为 None）
            "fund_flow_pct": fund_flow_pct,
        })

    if not rows:
        return {"rows": [], "meta": {
            "configured": {}, "applied": {}, "skipped": [],
        }}
    mom_n = _robust_normalize([r["risk_adj_momentum"] for r in rows])
    rsi_n = _robust_normalize([_rsi_factor(r["rsi"]) for r in rows])
    macd_n = _robust_normalize([r["macd"] for r in rows])
    trend_n = _robust_normalize([r["trend"] for r in rows])
    ey_n = _robust_normalize([r["earnings_yield"] for r in rows])
    pb_n = _robust_normalize([r["pb_inverse"] for r in rows])
    liq_n = _robust_normalize([r["turnover"] for r in rows])

    # 规模因子：全部缺失则跳过；部分缺失用中位数填充
    size_present = [r["size"] for r in rows if r["size"] is not None]
    if size_present:
        med = _median(size_present)
        size_n = _robust_normalize(
            [r["size"] if r["size"] is not None else med for r in rows]
        )
    else:
        size_n = None

    # 质量因子：仅当行情快照提供 ROE/股息率时启用
    quality_present = [r["quality"] for r in rows if r["quality"] is not None]
    if quality_present:
        med = _median(quality_present)
        quality_n = _robust_normalize(
            [r["quality"] if r["quality"] is not None else med for r in rows]
        )
    else:
        quality_n = None

    # 资金流因子：仅当行情快照提供主力资金流时启用（缺失自动跳过，权重归零）
    fund_present = [r["fund_flow_pct"] for r in rows if r["fund_flow_pct"] is not None]
    if fund_present:
        med = _median(fund_present)
        fund_n = _robust_normalize(
            [r["fund_flow_pct"] if r["fund_flow_pct"] is not None else med for r in rows]
        )
    else:
        fund_n = None

    # 估值复合 = 0.5×PE 便宜度 + 0.5×PB 便宜度
    value_n = [0.5 * a + 0.5 * b for a, b in zip(ey_n, pb_n)]

    # —— 权重：运行时剔除缺失因子后归一化 ——
    weights = {
        "momentum": sc.w_momentum,
        "rsi": sc.w_rsi,
        "macd": sc.w_macd,
        "trend": sc.w_trend,
        "value": sc.w_value,
        "liquidity": sc.w_liquidity,
        "size": sc.w_size if size_n is not None else 0.0,
        "quality": sc.w_quality if quality_n is not None else 0.0,
        "fund_flow": sc.w_fund_flow if fund_n is not None else 0.0,
    }
    total_w = sum(weights.values())
    if total_w <= 0:
        total_w = 1.0

    norm_map = {
        "momentum": mom_n,
        "rsi": rsi_n,
        "macd": macd_n,
        "trend": trend_n,
        "value": value_n,
        "liquidity": liq_n,
        "size": size_n or [0.0] * len(rows),
        "quality": quality_n or [0.0] * len(rows),
        "fund_flow": fund_n or [0.0] * len(rows),
    }

    for i, r in enumerate(rows):
        score = 0.0
        contrib: dict[str, float] = {}
        for k, w in weights.items():
            if w <= 0:
                continue
            v = norm_map[k][i]
            contrib[k] = round(v, 4)
            score += (w / total_w) * v
        r["score"] = round(score, 6)
        r["factor_scores"] = contrib
        r["rationale"] = _build_rationale(r)

    rows.sort(key=lambda r: r["score"], reverse=True)

    # —— 实际生效权重 meta（预设失真透明化）——
    # 某些因子因数据缺失被运行时剔除，其权重会按比例分摊到其余因子。
    # 这里把「配置权重」与「实际生效权重」都暴露出去，供前端/邮件如实展示，
    # 避免用户套用预设后误以为 quality/size/fund_flow 真的参与了打分。
    _configured = {
        "momentum": sc.w_momentum, "rsi": sc.w_rsi, "macd": sc.w_macd,
        "trend": sc.w_trend, "value": sc.w_value, "liquidity": sc.w_liquidity,
        "size": sc.w_size, "quality": sc.w_quality, "fund_flow": sc.w_fund_flow,
    }
    _applied = {k: round(w / total_w, 4) if w > 0 else 0.0 for k, w in weights.items()}
    meta = {
        "configured": {k: round(v, 4) for k, v in _configured.items()},
        "applied": _applied,
        "skipped": sorted(k for k, w in weights.items() if w <= 0),
    }

    # 实际选股数：优先用覆盖值（市场状态缩放），否则用配置 top_n
    eff_top_n = top_n_override if top_n_override is not None else sc.top_n

    # —— 行业分散约束：贪心选取，单行业不超过 max_per_sector ——
    # 按得分降序遍历，某行业已达上限则跳过该票继续看下一名，
    # 直到填满 top_n 或无票可选。约束生效后实际入选数可能 < top_n。
    cap = sc.max_per_sector
    if cap is not None and cap >= eff_top_n:
        # 上限不小于目标数，约束无效，直接取前 eff_top_n
        return {"rows": rows[: eff_top_n], "meta": meta}

    selected: list[dict] = []
    sector_count: dict[str, int] = {}
    for r in rows:
        # 未知行业在内部按代码各自独立，避免"其他"桶被一刀切
        sec = r["sector"] if r["sector"] != "其他" else r["code"]
        if sector_count.get(sec, 0) < cap:
            selected.append(r)
            sector_count[sec] = sector_count.get(sec, 0) + 1
        if len(selected) >= eff_top_n:
            break
    return {"rows": selected, "meta": meta}
