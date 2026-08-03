"""滚动再平衡回测（walk-forward / 真实历史模拟）

**为什么需要它**
`core/loop.py` 的基准回测是「用今天的选股结果去回测它的全历史」，存在严重的
幸存者偏差：今天选出来的票往往是过去涨得好的，回测必然乐观，无法反映策略
「历史上每一天真实会怎么选、怎么走」。

本模块实现真正的**滚动再平衡**：在历史区间内，按再平衡周期逐期重选票，
每期只用「截至该期首日」的数据做决策（无未来信息），模拟真实操盘节奏。

**无前视约定**
- 每期首日 T，只使用 K 线中 date <= T 的数据选股、判断市场状态。
- 当期买入在 T 日按开盘价建仓；止损沿用 engine 的无前视逻辑。
- 下一期重选时，先在 T 日开盘平掉上期持仓，再按新选票建仓。

**仓位管理**
- 等权分配：现金按当前持仓票数平均分配，单票风险受控（默认最大并行持仓
  cfg.signal.max_positions）。
- 若市场状态为熊市（position_factor=0），当期空仓；中性则降权建仓。
"""
from __future__ import annotations

import config
from data.provider import StaticProvider
from strategy import screener, market_state
from . import metrics


def _slice_klines_by_date(full_klines: dict[str, list[dict]], up_to: str) -> dict[str, list[dict]]:
    """把每只标的的 kline 截取到 date <= up_to（含当日），用于「截至当日」决策。"""
    out = {}
    for code, bars in full_klines.items():
        out[code] = [b for b in bars if b.get("date", "") <= up_to]
    return out


def _rebuild_provider(full_klines, full_quotes, up_to: str) -> StaticProvider:
    """构造「截至 up_to」的 StaticProvider，注入选股所需的数据（无未来信息）。"""
    sliced_k = _slice_klines_by_date(full_klines, up_to)
    return StaticProvider(klines=sliced_k, quotes=full_quotes, hot=[])


def _price(bars, d, kind="open"):
    """取某标的截至日期 d 的价格（open/close/low）。"""
    for b in reversed(bars):
        if b.get("date", "") <= d:
            v = b.get(kind)
            if v is None:
                v = b.get("close", 0)
            return float(v or 0)
    return 0.0


def walk_forward(
    full_klines: dict[str, list[dict]],
    full_quotes: dict[str, dict],
    codes: list[str],
    cfg: config.AppConfig,
) -> dict:
    """在历史区间上做滚动再平衡回测。

    full_klines: 每只标的的全历史 kline（含未来，但仅用于逐期截取）。
    full_quotes: 每只标的的静态行情快照（估值等）。
    codes:       候选池（选股范围，固定的 universe 或当日热点）。
    """
    # 统一每个标的的日期轴，取并集排序作为回测时间轴
    all_dates = set()
    for bars in full_klines.values():
        all_dates.update(b.get("date") for b in bars if b.get("date"))
    timeline = sorted(all_dates)
    if len(timeline) < cfg.signal.slow_ma + 5:
        return _empty_result(cfg, len(codes))

    # 再平衡周期（按交易日数量，默认 20 个交易日约一个月）
    rebalance_every = getattr(cfg.backtest, "rebalance_days", 20)

    cash = 1.0  # 起始资金 1.0（归一化）
    positions: dict[str, dict] = {}  # code -> {shares, entry}
    equity_curve: list[float] = []
    curve_dates: list[str] = []
    total_trades = 0
    total_wins = 0
    position_log: list[dict] = []  # 每再平衡期记录 {date, weights: {code: 占净值比例}}

    rebalance_idx = 0  # 下一次再平衡所在 timeline 下标
    for i, d in enumerate(timeline):
        # —— 到再平衡日：平旧仓、重选票、建新仓 ——
        if i == rebalance_idx:
            up_to_d = _slice_klines_by_date(full_klines, d)
            # 判断截至当日的市场状态（决定当期仓位系数）
            mk = up_to_d.get(cfg.market.index_code) or []
            regime = {"state": "neutral", "position_factor": 1.0}
            if cfg.market.enable:
                rg = market_state.detect_regime(cfg, mk)
                regime = {"state": rg["state"], "position_factor": rg["position_factor"]}

            # 先平掉上期持仓（按当日开盘价）
            for code in list(positions.keys()):
                px = _price(full_klines.get(code, []), d)
                pos = positions.pop(code)
                cash += pos["shares"] * px
                total_trades += 1
                pnl = (px - pos["entry"]) / pos["entry"]
                if pnl > 0:
                    total_wins += 1

            # 若市场允许建仓（非熊市），重选票并按风险预算分配现金
            eff_top_n = max(0, int(round(cfg.screener.top_n * regime["position_factor"])))
            if eff_top_n > 0:
                dp = _rebuild_provider(full_klines, full_quotes, d)
                screen_out = screener.screen(cfg, codes, dp, top_n_override=eff_top_n)
                selected = screen_out["rows"][: cfg.signal.max_positions]
                if selected:
                    cost = cfg.backtest.fee_rate + cfg.backtest.slippage
                    # 单票风险预算反推仓位：单票最大可亏 = 净值 × risk_per_position，
                    # 由止损距离反推单票最大仓位，确保「最坏情况单票止损只亏净值 risk_per_position」。
                    stop_pct = abs(cfg.signal.stop_loss_pct)
                    risk_budget = getattr(cfg.backtest, "risk_per_position", 0.02)
                    risk_cap = (cash * risk_budget / stop_pct) if stop_pct > 1e-9 else cash
                    # 同时受「单票最大仓位上限」与「等权」约束（防止票数少时过度集中）
                    max_w = getattr(cfg.backtest, "max_position_weight", 0.25)
                    alloc = min(cash / len(selected), cash * max_w, risk_cap)
                    for r in selected:
                        code = r["code"]
                        px = _price(full_klines.get(code, []), d)
                        if px <= 0:
                            continue
                        shares = alloc * (1 - cost) / px
                        cash -= alloc
                        positions[code] = {"shares": shares, "entry": px}
                    # 记录当期建仓权重（占净值比例），供风控审计/测试断言
                    equity_now = cash + sum(
                        pos["shares"] * _price(full_klines.get(cd, []), d)
                        for cd, pos in positions.items()
                    )
                    position_log.append({
                        "date": d,
                        "weights": {
                            cd: round(pos["shares"] * _price(full_klines.get(cd, []), d) / equity_now, 4)
                            for cd, pos in positions.items()
                        },
                    })

            # 下一再平衡日
            rebalance_idx = i + rebalance_every

        # —— 日间：逐日检查持仓止损（盘中最低价触发）——
        for code in list(positions.keys()):
            pos = positions[code]
            bars = full_klines.get(code, [])
            low = _price(bars, d, "low")
            entry = pos["entry"]
            stop = cfg.signal.stop_loss_pct
            if low <= entry * (1 + stop):
                px = entry * (1 + stop)  # 止损价成交
                cash += pos["shares"] * px
                positions.pop(code)
                total_trades += 1
                if (px - entry) / entry > 0:
                    total_wins += 1

        # —— 日末：组合市值 ——
        mv = cash
        for code, pos in positions.items():
            px = _price(full_klines.get(code, []), d)
            mv += pos["shares"] * px
        equity_curve.append(mv)
        curve_dates.append(d)

    m = metrics.compute_metrics(equity_curve, cfg)
    m["trades"] = total_trades
    m["win_rate"] = (total_wins / total_trades) if total_trades else 0.0
    m["trade_win_rate"] = m["win_rate"]
    m["n_stocks"] = len(codes)

    return {
        "dates": curve_dates,
        "equity": equity_curve,
        "metrics": m,
        "rebalance_days": rebalance_every,
        "regime": regime,
        "positions": position_log,
    }


def _empty_result(cfg: config.AppConfig, n_codes: int) -> dict:
    m = metrics.compute_metrics([1.0, 1.0], cfg)
    m["trades"] = 0
    m["win_rate"] = 0.0
    m["n_stocks"] = n_codes
    return {
        "dates": [],
        "equity": [],
        "metrics": m,
        "rebalance_days": getattr(cfg.backtest, "rebalance_days", 20),
        "regime": {"state": "unknown", "position_factor": 1.0},
        "positions": [],
    }
