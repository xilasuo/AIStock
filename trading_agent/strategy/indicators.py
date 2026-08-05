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
