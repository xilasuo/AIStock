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


def passes_hard_filters(cfg: config.AppConfig, quote: dict, code: str) -> bool:
    """硬性过滤：流动性 / 估值 / 板块 / ST / 流通市值。

    与 screen() 内部使用的过滤条件**完全一致**（同一份规则），
    供 backtest/walk_forward.py 预先裁剪候选池复用，避免规则漂移。
    任何字段缺失时按旧行为处理（or 0 → 通常被过滤，与 screen 一致）。
    """
    sc = cfg.screener
    turnover = quote.get("turnover_pct") or 0
    if turnover < sc.min_turnover_pct:
        return False
    pe = quote.get("pe_ttm") or 0
    if pe <= 0 or pe > sc.max_pe_ttm:
        return False
    pb = quote.get("pb") or 0
    if pb <= 0 or pb > sc.max_pb:
        return False

    name = quote.get("name") or code
    _board = _guess_board(code, name)
    if sc.boards and _board not in sc.boards:
        return False
    is_st = "ST" in name.upper() or "*" in name or "退" in name
    if sc.st_filter == "exclude_st" and is_st:
        return False
    if sc.st_filter in ("only_st", "include_st") and not is_st:
        return False
    mcap_yi = quote.get("mcap_yi") or 0.0
    if sc.mcap_min > 0 and mcap_yi < sc.mcap_min:
        return False
    if sc.mcap_max > 0 and mcap_yi > sc.mcap_max:
        return False
    return True


# ——— 策略专属硬过滤（需 K 线/日线数据，由 strategy_filter 触发） ———


def strategy_hard_filter(
    sf: str,
    code: str,
    closes: list[float],
    volumes: list[float],
    board: str,
    quote: dict,
    kline: list[dict] | None = None,
) -> bool:
    """按策略名执行 K 线级硬过滤；任一条件不满足返回 False 剔除该票。

    Args:
        sf: 策略名（ma_momentum | oversold | dszn | limit_up | volume_breakout | gann_142857）
        code: 股票代码
        closes: 日线收盘价序列（已从 kline 中提取，旧→新）
        volumes: 日线成交量序列（已从 kline 中提取，旧→新）
        board: 板块（main/cyb/kc/bj）
        quote: 行情快照
        kline: 完整日线 K 线序列（含 high/low，供需要真实高低点的策略使用；可选）
    """
    if sf == "ma_momentum":
        return _filter_ma_momentum(closes)
    elif sf == "oversold":
        return _filter_oversold(closes)
    elif sf == "dszn":
        return _filter_dszn(closes, volumes)
    elif sf == "limit_up":
        return _filter_limit_up(closes, volumes, board)
    elif sf == "volume_breakout":
        return _filter_volume_breakout(closes, volumes)
    elif sf == "gann_142857":
        return _filter_gann_142857(closes, volumes, kline or [])
    else:
        # 未知或无策略过滤 → 放行
        return True


def _filter_ma_momentum(closes: list[float]) -> bool:
    """均线多头排列：MA5>MA10>MA20>MA60，MACD 金叉或红柱放大，价站上 MA20。"""
    need = 60
    if len(closes) < need:
        return False
    ma5 = indicators.ma(closes, 5)
    ma10 = indicators.ma(closes, 10)
    ma20 = indicators.ma(closes, 20)
    ma60 = indicators.ma(closes, 60)
    if any(m is None for m in (ma5, ma10, ma20, ma60)):
        return False
    if not (ma5 > ma10 > ma20 > ma60):  # type: ignore[operator]
        return False
    # MACD 金叉或红柱放大
    macd_status = indicators.macd_cross_status(closes)
    if macd_status not in ("golden", "red_expand"):
        return False
    # 价在 MA20 上方
    if closes[-1] <= ma20:  # type: ignore[operator]
        return False
    return True


def _filter_oversold(closes: list[float]) -> bool:
    """超跌反弹：RSI(14)<30，股价触及布林带下轨。"""
    need = 20
    if len(closes) < need:
        return False
    rsi_val = indicators.rsi(closes, 14)
    if rsi_val >= 30:
        return False
    _, _, lower = indicators.bollinger_band(closes, 20, 2.0)
    if lower is None:
        return False
    # 触及下轨：最新收盘价在 lower 上方 3% 以内（允许小幅脱离下轨）
    if closes[-1] > lower * 1.03:
        return False
    return True


def _filter_dszn(closes: list[float], volumes: list[float]) -> bool:
    """DSZN 量价模型 C/D/E 阶段：MA20 向上，缩量回踩或放量突破形态。"""
    need = 60
    if len(closes) < need or len(volumes) < need:
        return False
    ma20_latest = indicators.ma(closes, 20)
    ma20_5ago = sum(closes[-(20 + 5):-5]) / 20 if len(closes) >= 25 else None
    if ma20_latest is None or ma20_5ago is None:
        return False
    # MA20 方向向上
    if ma20_latest <= ma20_5ago:
        return False
    # 量能形态：找到 60 天内最高成交量日（作为试盘/突破高量参照点）
    vol_window = volumes[-60:]
    if not vol_window:
        return False
    max_vol = max(vol_window)
    if max_vol <= 0:
        return False
    latest_vol = volumes[-1]
    # C/D 阶段：当前量 ≤ 60% 试盘量 → 缩量回踩/横盘蓄力
    if latest_vol <= max_vol * 0.60 and latest_vol > 0:
        return True
    # E 阶段：当前量 ≥ 1.5× 近 20 日均量 → 放量突破
    vol_ratio = indicators.volume_ratio(volumes, 20)
    if vol_ratio >= 1.5:
        return True
    return False


def _filter_limit_up(closes: list[float], volumes: list[float], board: str) -> bool:
    """涨停中继：近 2~5 天有涨停板，整理缩量 < 涨停量 50%，均线完全多头。"""
    need = 250
    if len(closes) < need:
        return False
    # 检测涨停（近 5 天）
    lu_day = indicators.detect_limit_up(closes, board, 5)
    if lu_day < 2 or lu_day > 5:
        return False
    # 涨停日成交量
    lu_vol_idx = -(lu_day + 1)  # 涨停日的 kline 索引（负数）
    if abs(lu_vol_idx) > len(volumes):
        return False
    lu_volume = volumes[lu_vol_idx]
    if lu_volume <= 0:
        return False
    latest_volume = volumes[-1]
    # 当前量 < 涨停日 50%（缩量整理）
    if latest_volume >= lu_volume * 0.50:
        return False
    # 均线完全多头：MA5>MA10>MA20>MA60>MA250
    ma5 = indicators.ma(closes, 5)
    ma10 = indicators.ma(closes, 10)
    ma20 = indicators.ma(closes, 20)
    ma60 = indicators.ma(closes, 60)
    ma250 = indicators.ma(closes, 250)
    if any(m is None for m in (ma5, ma10, ma20, ma60, ma250)):
        return False
    if not (ma5 > ma10 > ma20 > ma60 > ma250):  # type: ignore[operator]
        return False
    return True


def _filter_volume_breakout(closes: list[float], volumes: list[float]) -> bool:
    """倍量突破：量 ≥ 2× 近 20 日均量，价突破 20 日最高价，MACD 金叉或红柱放大。"""
    need = 20
    if len(closes) < need or len(volumes) < need + 1:
        return False
    # 成交量 ≥ 2 倍近 20 日均量
    if indicators.volume_ratio(volumes, 20) < 2.0:
        return False
    # 价格突破近 20 日最高价
    high_20 = max(closes[-21:-1]) if len(closes) >= 21 else max(closes[:-1])
    if closes[-1] < high_20:
        return False
    # MACD 金叉或红柱放大
    macd_status = indicators.macd_cross_status(closes)
    if macd_status not in ("golden", "red_expand"):
        return False
    return True


def _filter_gann_142857(closes: list[float], volumes: list[float], kline: list[dict]) -> bool:
    """江恩 142857 回调支撑：上涨波段回踩 14.28%/28.57%/42.85% 关键档位企稳。

    142857 是 1/7 的循环小数（1÷7=0.142857 142857…），其各位数字
    14.28% / 28.57% / 42.85% / 57.14% / 71.42% / 85.71% 被江恩理论用作
    价格波动的关键支撑/阻力比例。本策略取近期上涨波段的真实高低点，按前
    三档（浅/中/深回调）计算支撑位，捕捉「上升趋势中回踩档位企稳」的低吸买点。
    """
    need = 60
    if len(closes) < need or len(volumes) < need or len(kline) < need:
        return False

    # 1) 取近 60 日真实高低点（用 kline 的 high/low，比收盘价更准）
    window_kl = kline[-need:]
    highs = [float(b.get("high") or b.get("close") or 0) for b in window_kl]
    lows = [float(b.get("low") or b.get("close") or 0) for b in window_kl]
    H = max(highs)
    L = min(lows)
    h_idx = highs.index(H)
    l_idx = lows.index(L)
    # 波段必须有足够空间（涨幅 ≥10%），且高点在低点之后（上涨波段而非下跌中继）
    if H < L * 1.10 or h_idx <= l_idx:
        return False

    span = H - L
    # 2) 142857 前三档回调支撑位（从高点 H 向下回撤）
    levels = [H - span * r for r in (0.1428, 0.2857, 0.4285)]
    price = closes[-1]
    # 当前价在某档 ±2.5% 容差内 = 回踩企稳
    if not any(lv > 0 and abs(price - lv) / lv <= 0.025 for lv in levels):
        return False

    # 3) 缩量企稳：近 3 日均量 < 近 20 日均量的 80%（抛压减轻）
    recent_vol = sum(volumes[-3:]) / 3.0
    avg_vol_20 = sum(volumes[-20:]) / 20.0
    if avg_vol_20 <= 0 or recent_vol >= avg_vol_20 * 0.80:
        return False

    # 4) 趋势向上：MA20 今 > MA20 5 日前，且价在 MA60 上方（确保是上升趋势的回调）
    ma20_now = indicators.ma(closes, 20)
    ma20_5ago = sum(closes[-25:-5]) / 20.0 if len(closes) >= 25 else None
    ma60 = indicators.ma(closes, 60)
    if ma20_now is None or ma20_5ago is None or ma60 is None:
        return False
    if ma20_now <= ma20_5ago or closes[-1] <= ma60:
        return False
    return True


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


def _rsi_factor(rsi_val: float, direction: str = "normal") -> float:
    """把 RSI(0~100) 映射为 0~1 选股偏好。

    direction="normal"（默认，强势偏好）：偏好 50~70 健康强势，
    超买(>70)线性衰减，弱势(<50)线性偏低。
    direction="reversal"（超跌反转）：偏好 30~50 超跌区域，
    越低越接近反弹买点，>50 线性衰减，避免追高。供
    bottom_reversal / divergence_reversal 等超跌类预设使用。
    """
    if direction == "reversal":
        r = rsi_val
        if r <= 30:
            return 0.4 + 0.4 * (r / 30.0)  # 0~30：从 0.4 升到 0.8（极超跌偏谨慎，避免接飞刀）
        if r <= 50:
            return 0.8 + 0.2 * ((50 - r) / 20.0)  # 30~50：0.8~1.0（最佳反弹区）
        if r <= 70:
            return 0.6 * ((70 - r) / 20.0)  # 50~70：0.6~0（越强分越低）
        return 0.0  # >70 超买，超跌策略不碰
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
        # 硬性过滤优先（quote 独立于 K 线）：不满足的票直接跳过，
        # 省去无效票的 K 线拉取/拷贝与长度检查。过滤条件与旧实现逐条一致。
        try:
            quote = dp.fetch_quote(code)
        except Exception:
            continue
        if not quote or not passes_hard_filters(cfg, quote, code):
            continue

        try:
            kline = dp.fetch_kline(code, cfg.beg, cfg.end)
        except Exception:
            continue
        if not kline or len(kline) < sc.momentum_window + 2:
            continue

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

        # 前置条件过滤依赖的展示字段（板块 / ST / 流通市值）已在
        # passes_hard_filters 中判定；此处仅保留展示所需变量。
        name = quote.get("name") or code
        mcap_yi = quote.get("mcap_yi") or 0.0
        # 硬过滤已保证 pe>0、pb>0、turnover>=min，此处取值供因子与展示使用
        pe = quote.get("pe_ttm") or 0
        pb = quote.get("pb") or 0
        turnover = quote.get("turnover_pct") or 0

        closes = [float(b["close"]) for b in kline if b.get("close") is not None]
        if len(closes) < sc.momentum_window + 2:
            continue

        # —— 策略专属硬过滤（需 K 线数据，由 presets 设置 strategy_filter 触发）——
        if sc.strategy_filter:
            volumes = [float(b.get("volume", b.get("vol", 0)) or 0) for b in kline]
            _board = _guess_board(code, name)
            if not strategy_hard_filter(sc.strategy_filter, code, closes, volumes, _board, quote, kline):
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
    rsi_n = _robust_normalize([_rsi_factor(r["rsi"], sc.rsi_direction) for r in rows])
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
            contrib[k] = round(v, 3)
            score += (w / total_w) * v
        r["score"] = score  # 全精度用于排序，输出时统一 3 位
        r["factor_scores"] = contrib
        r["rationale"] = _build_rationale(r)

    rows.sort(key=lambda r: r["score"], reverse=True)
    for r in rows:
        r["score"] = round(r["score"], 3)

    # —— 实际生效权重 meta（预设失真透明化）——
    # 某些因子因数据缺失被运行时剔除，其权重会按比例分摊到其余因子。
    # 这里把「配置权重」与「实际生效权重」都暴露出去，供前端/邮件如实展示，
    # 避免用户套用预设后误以为 quality/size/fund_flow 真的参与了打分。
    _configured = {
        "momentum": sc.w_momentum, "rsi": sc.w_rsi, "macd": sc.w_macd,
        "trend": sc.w_trend, "value": sc.w_value, "liquidity": sc.w_liquidity,
        "size": sc.w_size, "quality": sc.w_quality, "fund_flow": sc.w_fund_flow,
    }
    _applied = {k: round(w / total_w, 3) if w > 0 else 0.0 for k, w in weights.items()}
    meta = {
        "configured": {k: round(v, 3) for k, v in _configured.items()},
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
