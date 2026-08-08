"""技术指标工具（选股因子计算的底层函数）

全部基于日线收盘价序列（升序），纯标准库实现，供 strategy/screener.py、
strategy/signals.py 复用。不依赖任何第三方包。

**性能约定（2026-08-05 优化）**
- 所有窗口类指标只计算「尾部窗口」需要的数据，不白算全量序列；
- 数值与旧实现逐位一致（同一组样本、同一求和顺序）；
- 纯 Python 循环内用局部变量绑定（out.append 等）避免属性查找。
"""
from __future__ import annotations

import math


def sma(values: list[float], n: int) -> list[float]:
    """简单移动平均；前 n-1 个位置用可用样本均值填充。

    滑动窗口维护窗口和（O(n)），输出与逐次 sum 的旧实现一致。
    """
    if n <= 0:
        return [0.0] * len(values)
    out: list[float] = []
    append = out.append
    window_sum = 0.0
    for i in range(len(values)):
        window_sum += values[i]
        if i >= n:
            window_sum -= values[i - n]
        if i + 1 < n:
            # 前 n-1 个位置样本不足，用可用样本均值填充（与旧实现逐位一致）
            append(sum(values[: i + 1]) / (i + 1))
        else:
            append(window_sum / n)
    return out


def ema(values: list[float], n: int) -> list[float]:
    """指数移动平均（递推）。"""
    if not values or n <= 0:
        return [0.0] * len(values)
    k = 2.0 / (n + 1)
    out: list[float] = []
    append = out.append
    prev = values[0]
    append(prev)
    for v in values[1:]:
        prev = v * k + prev * (1 - k)
        append(prev)
    return out


def log_returns(closes: list[float]) -> list[float]:
    """相邻日对数收益率。"""
    out: list[float] = []
    append = out.append
    for i in range(1, len(closes)):
        a, b = closes[i - 1], closes[i]
        append(math.log(b / a) if a > 0 and b > 0 else 0.0)
    return out


def rolling_vol(closes: list[float], n: int) -> float:
    """最近 n 日日对数收益率的年化波动率（样本标准差 × √252）。

    只计算尾部窗口（最多 n+1 根收盘价）的对数收益，结果与
    「全量对数收益再取尾部」的旧实现逐位一致。
    """
    if n <= 0:
        n = len(closes) - 1
    if n < 1 or len(closes) < 2:
        return 0.0
    # 尾部窗口：需要 n 个相邻收益，即最近 n+1 根收盘价
    window = closes[-(n + 1):]
    r: list[float] = []
    r_append = r.append
    for i in range(1, len(window)):
        a, b = window[i - 1], window[i]
        r_append(math.log(b / a) if a > 0 and b > 0 else 0.0)
    if len(r) < 2:
        return 0.0
    mean = sum(r) / len(r)
    var = sum((x - mean) ** 2 for x in r) / (len(r) - 1)
    return math.sqrt(var) * math.sqrt(252.0)


def rsi(closes: list[float], n: int = 14) -> float:
    """Wilder RSI，返回最新值（0~100）。数据不足返回 50（中性）。

    只计算尾部 n 个相邻差价的涨/跌均值（更早的差价不影响尾部均值），
    结果与旧实现（全量差价再取尾部）逐位一致。
    """
    if len(closes) < n + 1:
        return 50.0
    # 尾部窗口：最后 n+1 根收盘价产生 n 个差价
    window = closes[-(n + 1):]
    gains = 0.0
    losses = 0.0
    for i in range(1, len(window)):
        d = window[i] - window[i - 1]
        if d > 0:
            gains += d
        else:
            losses += -d
    avg_g = gains / n
    avg_l = losses / n
    if avg_l == 0:
        return 100.0 if avg_g > 0 else 50.0
    rs = avg_g / avg_l
    return 100.0 - 100.0 / (1.0 + rs)


def macd(closes: list[float], fast: int = 12, slow: int = 26, signal: int = 9):
    """返回 (macd_line, signal_line, histogram) 的最新值；数据不足返回 0。

    EMA 是递推计算、初值固定在序列起点，无法从中间开始，故保留全量
    遍历（每标的每参数组合仅调用一次，代价已在 walk_forward 预过滤中摊薄）。
    """
    if len(closes) < slow + signal:
        return 0.0, 0.0, 0.0
    ef = ema(closes, fast)
    es = ema(closes, slow)
    macd_line = [ef[i] - es[i] for i in range(len(closes))]
    sig = ema(macd_line, signal)
    hist = macd_line[-1] - sig[-1]
    return macd_line[-1], sig[-1], hist


# ——— 均线 / 布林 / 量 / 涨停 / MACD 状态（供策略硬过滤使用） ———


def ma(values: list[float], n: int) -> float | None:
    """简单移动平均最新值；数据不足返回 None。"""
    if len(values) < n:
        return None
    return sum(values[-n:]) / n


def bollinger_band(
    closes: list[float], n: int = 20, k: float = 2.0
) -> tuple[float | None, float | None, float | None]:
    """返回 (mid, upper, lower) 布林带最新值；数据不足返回 (None, None, None)。"""
    if len(closes) < n:
        return None, None, None
    window = closes[-n:]
    mean = sum(window) / n
    var = sum((x - mean) ** 2 for x in window) / n
    std = math.sqrt(var)
    return mean, mean + k * std, mean - k * std


def volume_ratio(volumes: list[float], lookback: int = 20) -> float:
    """最新量 / 近 N 日均量；数据不足返回 1.0。"""
    if len(volumes) < lookback + 1:
        return 1.0
    latest = volumes[-1]
    avg = sum(volumes[-(lookback + 1): -1]) / lookback
    if avg <= 0:
        return 1.0
    return latest / avg


def detect_limit_up(
    closes: list[float], board: str = "main", lookback: int = 5
) -> int:
    """检测近 lookback 天内最近一次涨停距今天数（1=昨天）；未检测到返回 -1。

    不同板块阈值：主板 ≈9.9%，科创/创业 ≈19.9%，北交 ≈29.9%。
    """
    limits = {"main": 0.099, "cyb": 0.199, "kc": 0.199, "bj": 0.299}
    threshold = limits.get(board, 0.099) * 0.92  # 留 8% 容差（实际封板可能未满 10%）
    for offset in range(1, min(lookback + 1, len(closes))):
        prev = closes[-(offset + 1)]
        curr = closes[-offset]
        if prev > 0 and (curr / prev - 1.0) >= threshold:
            return offset
    return -1


def macd_histogram_series(
    closes: list[float], fast: int = 12, slow: int = 26, signal: int = 9
) -> list[float]:
    """返回完整 MACD 柱（histogram = DIF - DEA）序列；数据不足返回空列表。

    供底背离等需要逐点比较 MACD 值的策略使用。
    """
    if len(closes) < slow + signal:
        return []
    ef = ema(closes, fast)
    es = ema(closes, slow)
    dif_line = [ef[i] - es[i] for i in range(len(closes))]
    sig = ema(dif_line, signal)
    return [dif_line[i] - sig[i] for i in range(len(closes))]


def macd_cross_status(
    closes: list[float], fast: int = 12, slow: int = 26, signal: int = 9
) -> str:
    """返回最新 MACD 状态：'golden'(金叉) | 'dead'(死叉) | 'red_expand'(红柱放大) | 'none'。

    需要 slow+signal+2 根日线，不足返回 'none'。
    """
    if len(closes) < slow + signal + 2:
        return "none"
    ef = ema(closes, fast)
    es = ema(closes, slow)
    dif_line = [ef[i] - es[i] for i in range(len(closes))]
    sig = ema(dif_line, signal)
    dif_now = dif_line[-1]
    dea_now = sig[-1]
    dif_prev = dif_line[-2]
    dea_prev = sig[-2]
    # 金叉：上一根 DIF ≤ DEA，当前 DIF > DEA
    if dif_prev <= dea_prev and dif_now > dea_now:
        return "golden"
    # 死叉：上一根 DIF ≥ DEA，当前 DIF < DEA
    if dif_prev >= dea_prev and dif_now < dea_now:
        return "dead"
    # 红柱放大：MACD 柱为正值且较上一根在扩大
    hist_now = dif_now - dea_now
    hist_prev = dif_prev - dea_prev
    if hist_now > 0 and hist_now > hist_prev:
        return "red_expand"
    return "none"
