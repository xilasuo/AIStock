"""回测引擎

对每个标的独立做「买入持有至卖出/止损」的模拟（归一化净值从 1.0 起），
再等权聚合为组合净值曲线。含单边手续费 + 滑点 + 止损。

**无前视约定**
- signals.generate_signals 返回的 buy/sell 日期是「可执行日」（信号次日）。
- 可执行日按「当日开盘价」成交：开盘时点信号已确认（前一日收盘确认），
  用开盘价成交最贴近真实可执行性，且不引入当日收盘的前视。
- 止损用**当日盘中最低价**触发（真实止损单会被盘中低点扫到），
  且当日若已止损/死叉卖出，当日不再重新开仓（避免一根K线先卖后买的荒谬逻辑）。
"""
from __future__ import annotations

import config
from . import metrics


def _simulate_one(kline: list[dict], buy: set, sell: set, cfg: config.AppConfig):
    """返回该标的的逐日净值序列（起始 1.0）与交易统计。"""
    bcfg = cfg.backtest
    cost = bcfg.fee_rate + bcfg.slippage
    cash = 1.0
    shares = 0.0
    entry = 0.0
    in_market = False
    trades = 0
    wins = 0
    equity = []
    stop = cfg.signal.stop_loss_pct

    # 逐笔已平仓盈亏记录（用于计算真实交易胜率）
    closed_pnls: list[float] = []

    for bar in kline:
        price = bar["close"]
        open_p = bar.get("open", price) or price
        low = bar.get("low", price) or price
        d = bar["date"]

        if in_market:
            # 当日是否触发止损/死叉卖出
            stop_price = entry * (1 + stop)
            hit_stop = low <= stop_price  # 盘中最低价触及止损
            hit_sell = d in sell
            exited = False
            if hit_stop:
                # 止损按止损价成交（更贴近实际：止损单在触及价位触发）
                exit_price = stop_price
                exited = True
            elif hit_sell:
                exit_price = open_p  # 死叉信号次日开盘卖出
                exited = True

            if exited:
                pnl = (exit_price - entry) / entry
                closed_pnls.append(pnl)
                if pnl > 0:
                    wins += 1
                cash = shares * exit_price * (1 - cost)
                shares = 0.0
                in_market = False
                trades += 1

        # 开仓：仅当当日未卖出且当日是买入可执行日（避免先卖后买）
        if (not in_market) and d in buy:
            shares = cash * (1 - cost) / open_p
            cash = 0.0
            entry = open_p
            in_market = True

        equity.append(cash + shares * price)

    stats = {
        "trades": trades,
        "wins": wins,
        "win_rate": (wins / trades) if trades else 0.0,
        "closed_pnls": closed_pnls,
    }
    return equity, [b["date"] for b in kline], stats


def backtest(code_klines: dict, code_signals: dict, cfg: config.AppConfig) -> dict:
    """输入：code->kline，code->(buy,sell)。输出组合回测结果字典。"""
    per_code = {}
    all_dates = set()
    total_trades = 0
    total_wins = 0
    for code, kline in code_klines.items():
        buy, sell = code_signals.get(code, (set(), set()))
        eq, dates, stats = _simulate_one(kline, buy, sell, cfg)
        d2e = dict(zip(dates, eq))
        per_code[code] = {"equity": eq, "dates": dates, "trades": stats["trades"], "d2e": d2e}
        total_trades += stats["trades"]
        total_wins += stats["wins"]
        all_dates.update(dates)

    common = sorted(all_dates)
    n_codes = len(per_code) or 1
    portfolio = []
    # 游标法聚合：每只票维护已消费的日期下标（dates 升序），随 common 单调前进，
    # 每 (票, 日) 摊还 O(1)，消除旧实现「每日期对每票线性扫描 earlier」的 O(D×N×B)。
    cursors = {c: 0 for c in per_code}
    for d in common:
        vals = []
        for c, rec in per_code.items():
            dates = rec["dates"]
            ci = cursors[c]
            while ci < len(dates) and dates[ci] <= d:
                ci += 1
            cursors[c] = ci
            if ci > 0:
                # 最近「<= d」的日期（carry-forward：沿用上一已知净值）
                vals.append(rec["d2e"][dates[ci - 1]])
            else:
                # d 早于该标的首个交易日（次新股等）：沿用起始净值（carry-forward）
                vals.append(rec["equity"][0] if rec["equity"] else 0.0)
        portfolio.append(sum(vals) / n_codes)

    m = metrics.compute_metrics(portfolio, cfg)
    m["trades"] = total_trades
    m["n_stocks"] = len(per_code)
    # 真实交易胜率（已平仓交易盈利占比），替代旧的"日胜率"
    m["win_rate"] = (total_wins / total_trades) if total_trades else 0.0
    m["trade_win_rate"] = m["win_rate"]
    return {
        "dates": common,
        "equity": portfolio,
        "per_code": per_code,
        "metrics": m,
    }
