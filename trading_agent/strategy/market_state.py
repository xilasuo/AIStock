"""市场状态检测（选股策略 · 风控前置）

用宽基指数（默认沪深300 000300）的日线判断当下市场处于
「牛市 / 中性 / 熊市」三种状态之一，并给出对应的「仓位系数」：

  - 牛市 bull    → position_factor = 1.0（满仓选股）
  - 中性 neutral → position_factor = 0.5（半仓，降低暴露）
  - 熊市 bear    → position_factor = 0.0（空仓，不选股）

判定依据（轻量、无需另接数据源，复用 fetch_kline 的指数行情）：
  1) 长期均线位置：最新价 vs MA(ma_window) 的偏离（价格站在长均线上方=偏多）
  2) 中期动量：最近 mom_window 日收益（中期趋势方向）

两者同向强化时给出明确状态；相悖或信号弱时判为中性。
缺数据（指数K线不足 / 未提供）时返回 unknown，按中性处理（position=1），
不强行空仓，避免无谓踏空。
"""
from __future__ import annotations

import math


def _tanh(x: float) -> float:
    if x > 8:
        return 1.0
    if x < -8:
        return -1.0
    e = math.exp(2 * x)
    return (e - 1) / (e + 1)


def detect_regime(cfg, kline: list[dict]) -> dict:
    """根据指数日线判定市场状态。

    参数
    ----
    cfg:     config.AppConfig（读 cfg.market）
    kline:   指数日线 [{date, open, close, ...}, ...]（按日期升序）

    返回
    ----
    {
      "state": "bull" | "neutral" | "bear" | "unknown",
      "position_factor": float,     # 仓位系数（0~1）
      "score": float,               # 连续强度分（约 -1~1，仅供展示）
      "detail": str,                # 人类可读说明
      "ma_gap": float,              # 价格相对长均线偏离
      "momentum": float,            # 中期动量
      "short_mom": float,           # 短期动量（领先信号）
      "vol_ratio": float,           # 短期波动/长期波动（<1=缩量整理，领先信号）
    }
    """
    m = cfg.market
    closes = [float(b["close"]) for b in kline if b.get("close") is not None] \
        if kline else []

    if len(closes) < m.ma_window + 2:
        return {
            "state": "unknown",
            "position_factor": 1.0,
            "score": 0.0,
            "detail": f"指数K线不足（需≥{m.ma_window+2}根），市场状态未知，按中性处理",
            "ma_gap": 0.0,
            "momentum": 0.0,
            "short_mom": 0.0,
            "vol_ratio": 1.0,
        }

    # 长期均线位置
    ma = sum(closes[-m.ma_window:]) / m.ma_window
    ma_gap = (closes[-1] / ma - 1.0) if ma else 0.0

    # 中期动量
    mw = min(m.mom_window, len(closes) - 1)
    mom = closes[-1] / closes[-(mw + 1)] - 1.0 if mw > 0 else 0.0

    # —— 领先信号 1：短期动量（短窗口捕捉拐点，比中期动量更灵敏）——
    smw = max(1, min(m.short_mom_window, len(closes) - 1))
    short_mom = closes[-1] / closes[-(smw + 1)] - 1.0 if smw > 0 else 0.0

    # —— 领先信号 2：波动率收缩比（短期波动 / 长期波动，<1 表示缩量整理）——
    def _vol_std(xs: list[float]) -> float:
        if len(xs) < 2:
            return 0.0
        mean = sum(xs) / len(xs)
        var = sum((v - mean) ** 2 for v in xs) / (len(xs) - 1)
        return var ** 0.5

    long_vol = _vol_std(closes[-m.ma_window:])
    short_win = max(2, min(m.short_mom_window * 2, len(closes)))
    short_vol = _vol_std(closes[-short_win:])
    vol_ratio = (short_vol / long_vol) if long_vol > 1e-9 else 1.0

    # 连续强度分（展示用）：均线位置权重 0.45，中期动量 0.3，短期动量 0.25
    score = 0.45 * _tanh(ma_gap / 0.10) + 0.3 * _tanh(mom / 0.10) + 0.25 * _tanh(short_mom / 0.05)

    above_ma = ma_gap >= m.bull_ma_gap
    up_trend = mom >= m.bull_mom
    below_ma = ma_gap <= m.bear_ma_gap
    down_trend = mom <= m.bear_mom

    # 领先信号：短期动量强弱 + 是否缩量整理
    strong_short = short_mom >= m.strong_short_mom
    weak_short = short_mom <= m.weak_short_mom
    shrinking = vol_ratio <= m.vol_shrink_threshold

    if above_ma and up_trend:
        state = "bull"
        detail = (
            f"牛市：价格站上 MA{m.ma_window}（偏离 {ma_gap*100:+.1f}%）"
            f"且中期动量 {mom*100:+.1f}%，满仓选股"
        )
    elif below_ma and down_trend:
        state = "bear"
        detail = (
            f"熊市：价格跌破 MA{m.ma_window}（偏离 {ma_gap*100:+.1f}%）"
            f"且中期动量 {mom*100:+.1f}%，空仓规避"
        )
    else:
        # 中性态：用领先信号细分出「偏强 / 偏弱」，缓解均线判定的滞后
        state = "neutral"
        pf = float(m.position.get("neutral", 0.5))
        if strong_short:
            pf = float(getattr(m, "neutral_up_factor", 0.65))
            detail = (
                f"中性偏强：均线偏离 {ma_gap*100:+.1f}%、中期动量 {mom*100:+.1f}%，"
                f"但短期动量 {short_mom*100:+.1f}% 偏强，仓位系数上调至 {pf:.2f}"
            )
        elif weak_short:
            pf = float(getattr(m, "neutral_down_factor", 0.35))
            detail = (
                f"中性偏弱：均线偏离 {ma_gap*100:+.1f}%、中期动量 {mom*100:+.1f}%，"
                f"短期动量 {short_mom*100:+.1f}% 偏弱，仓位系数下调至 {pf:.2f}"
            )
        else:
            detail = (
                f"中性：均线偏离 {ma_gap*100:+.1f}%、中期动量 {mom*100:+.1f}%"
                f"（未同时满足牛/熊条件），半仓降暴露"
            )
        if shrinking:
            detail += f"；波动率收缩（比值 {vol_ratio:.2f}），等待方向选择"

    return {
        "state": state,
        "position_factor": float(pf if state == "neutral" else m.position.get(state, 1.0)),
        "score": round(score, 4),
        "detail": detail,
        "ma_gap": round(ma_gap, 4),
        "momentum": round(mom, 4),
        "short_mom": round(short_mom, 4),
        "vol_ratio": round(vol_ratio, 4),
    }
