"""操作（信号）模块

基于快慢均线交叉生成买卖信号；可选「突破 N 日新高」过滤。

**无前视约定（重要）**
本模块只负责「识别信号」，不负责成交。为避免用当日收盘价既当信号又当结果，
约定如下：

- 均线在第 t 日收盘后计算（使用含 t 日的历史收盘价，这是「收盘后才可知」的）。
- 第 t 日的金叉/死叉 = 用第 t 日的均线与第 t-1 日的均线比较得出。
- 因此「第 t 日收盘确认的信号」，最早只能到 **t+1 日** 才可执行。
- 返回的 buy/sell 集合的日期 d 表示「**在 d 日（信号次日）可执行买入/卖出**」。

这样回测层在 d 日按开盘/收盘成交时，用的都是信号确认之后的价格，无前视。

返回 (buy_dates, sell_dates)，均为 set[str]，供回测按日判定。
"""
from __future__ import annotations


def _sma_series(closes: list[float], n: int) -> list[float]:
    """简单移动平均序列，长度与 closes 一致。

    前 n-1 个位置样本不足，返回 None 表示「不可用」，
    避免把不完整窗口当成有效均线参与交叉判定。
    """
    out: list[float | None] = [None] * len(closes)
    if n <= 0 or not closes:
        return out
    window_sum = 0.0
    for i, c in enumerate(closes):
        window_sum += c
        if i >= n:
            window_sum -= closes[i - n]
        if i >= n - 1:
            out[i] = window_sum / n
    return out


def generate_signals(kline: list[dict], signal_cfg):
    """signal_cfg: config.SignalConfig"""
    cfg = signal_cfg
    closes = [b["close"] for b in kline]
    n = len(closes)
    fast = cfg.fast_ma
    slow = cfg.slow_ma
    if n < slow + 1:
        return set(), set()

    fast_ma = _sma_series(closes, fast)
    slow_ma = _sma_series(closes, slow)

    buy: set[str] = set()
    sell: set[str] = set()
    bw = cfg.breakout_window

    for i in range(1, n):
        d = kline[i]["date"]
        # 当日均线（收盘后可知）
        fa = fast_ma[i]
        sa = slow_ma[i]
        # 前一日均线（用于判断"当日是否刚发生交叉"）
        fa_prev = fast_ma[i - 1]
        sa_prev = slow_ma[i - 1]
        if fa is None or sa is None or fa_prev is None or sa_prev is None:
            continue

        cross_up = fa > sa and fa_prev <= sa_prev
        cross_dn = fa < sa and fa_prev >= sa_prev

        if cross_up:
            if cfg.use_breakout_filter:
                # 突破过滤用「前一日之前」的窗口，避免用到当日收盘价（前视）
                # prev_high 取 [i-bw, i-1] 区间的最高收盘价
                prev_high = max(closes[max(0, i - bw): i])
                # 当日收盘必须创出新高才确认突破
                if closes[i] <= prev_high:
                    continue
            # 信号在 i 日收盘确认，可执行日为次日
            if i + 1 < n:
                buy.add(kline[i + 1]["date"])
        elif cross_dn:
            # 死叉同理，可执行日为次日
            if i + 1 < n:
                sell.add(kline[i + 1]["date"])

    return buy, sell
