"""评价指标：收益、年化、最大回撤、夏普

说明：这里只负责基于净值序列的组合指标。**交易胜率（win_rate）不在本模块计算**，
因为它需要逐笔已平仓盈亏，由 backtest/engine.py 统计后覆盖。本模块保留
`daily_win_rate`（日线方向胜率）作为参考，避免与"交易胜率"混淆。
"""
from __future__ import annotations

import config


def compute_metrics(equity: list[float], cfg: config.AppConfig) -> dict:
    n = len(equity)
    if n < 2:
        return {
            "total_return": 0.0, "annual_return": 0.0, "max_drawdown": 0.0,
            "sharpe": 0.0, "daily_win_rate": 0.0, "win_rate": 0.0, "n_days": n,
        }
    init, final = equity[0], equity[-1]
    total_return = final / init - 1.0
    daily = [equity[i] / equity[i - 1] - 1.0 for i in range(1, n)]
    mean = sum(daily) / len(daily)
    var = sum((x - mean) ** 2 for x in daily) / max(1, len(daily) - 1)
    std = var ** 0.5
    sharpe = (mean / std * (252 ** 0.5)) if std > 0 else 0.0
    ann = (final / init) ** (252 / (n - 1)) - 1 if (n - 1) > 0 else 0.0

    peak = equity[0]
    mdd = 0.0
    for e in equity:
        if e > peak:
            peak = e
        dd = e / peak - 1.0
        if dd < mdd:
            mdd = dd

    daily_win_rate = sum(1 for x in daily if x > 0) / len(daily)
    return {
        "total_return": total_return,
        "annual_return": ann,
        "max_drawdown": mdd,
        "sharpe": sharpe,
        "daily_win_rate": daily_win_rate,
        "win_rate": 0.0,  # 占位，由 engine.backtest 用真实交易胜率覆盖
        "n_days": n,
    }
