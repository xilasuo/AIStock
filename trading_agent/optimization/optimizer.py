"""优化策略模块

对信号参数（快/慢均线）做网格搜索，以夏普（或指定指标）为目标，
在已选标的的历史数据上挑选更优参数组合，形成「回测→优化」迭代。

**反过拟合（样本外验证）**
为避免在整段历史上做样本内最优化而高估绩效，这里采用**时间序列滚动切分**：
  - 训练段（前 train_ratio）：用来对每个网格参数打分，选出最优参数。
  - 测试段（后 1-train_ratio，样本外）：用训练段选出的最优参数回测，
    产出「样本外」绩效，作为该参数组合的真实预估。

报告同时给出：
  - best_signal        : 训练段最优参数
  - best_metrics       : 训练段最优绩效
  - out_of_sample      : 样本外绩效（真实可期），前端/邮件应优先展示此项
"""
from __future__ import annotations

import copy

import config
from strategy import signals
from backtest import engine


def apply_feedback_adjustment(cfg: config.AppConfig) -> config.AppConfig:
    """读取用户反馈，自适应调整因子权重与止损。

    正面反馈占比高 -> 强化动量因子、放宽止损（当前策略被认可）；
    占比低 -> 偏价值/流动性、收紧止损（当前策略需更谨慎）。
    """
    from feedback_store import feedback_summary

    try:
        s = feedback_summary()
    except Exception:  # noqa: BLE001
        return cfg
    if s["count"] == 0:
        return cfg

    ratio = s["positive_ratio"]
    w_mom = 0.3 + 0.4 * ratio
    w_val = 0.45 - 0.2 * ratio
    w_liq = max(0.1, round(1 - w_mom - w_val, 2))
    w_mom = round(w_mom, 2)
    w_val = round(w_val, 2)
    cfg.screener.w_momentum = w_mom
    cfg.screener.w_value = w_val
    cfg.screener.w_liquidity = w_liq
    cfg.signal.stop_loss_pct = round(-(0.06 + 0.04 * (1 - ratio)), 2)
    return cfg


def _split_klines(code_klines: dict, train_ratio: float):
    """把每只标的的 kline 按时间切分为训练段 / 测试段（样本外）。

    返回 (train_klines, test_klines)。每段都保留自己的完整 bar，供 engine 独立回测。
    """
    train: dict[str, list[dict]] = {}
    test: dict[str, list[dict]] = {}
    for code, kline in code_klines.items():
        if not kline:
            train[code] = []
            test[code] = []
            continue
        cut = max(1, int(len(kline) * train_ratio))
        # 切点需对齐到「至少 slow_ma+1」以上，避免测试段前段指标无效
        train[code] = kline[:cut]
        test[code] = kline[cut:]
    return train, test


def _backtest_signals(code_klines: dict, cfg, fast: int, slow: int) -> dict:
    """对给定 kline 集合、给定 (fast, slow) 生成信号并回测，返回 metrics 与 backtest。"""
    c = copy.copy(cfg)
    c.signal = copy.copy(cfg.signal)
    c.signal.fast_ma = fast
    c.signal.slow_ma = slow
    code_signals = {
        code: signals.generate_signals(kline, c.signal)
        for code, kline in code_klines.items()
    }
    bt = engine.backtest(code_klines, code_signals, c)
    return bt


def optimize(code_klines: dict, codes: list[str], cfg: config.AppConfig) -> dict:
    # 反馈闭环：用历史用户评价自适应调整参数后再搜索
    cfg = copy.deepcopy(cfg)
    cfg = apply_feedback_adjustment(cfg)

    ocfg = cfg.optim
    train_ratio = getattr(ocfg, "train_ratio", 0.7)

    grid = []
    for f in ocfg.fast_ma_grid:
        for s in ocfg.slow_ma_grid:
            if f < s:
                grid.append((f, s))

    # 样本外切分
    train_klines, test_klines = _split_klines(code_klines, train_ratio)

    results = []
    best = None
    for f, s in grid:
        # 训练段打分（样本内）
        bt = _backtest_signals(train_klines, cfg, f, s)
        metric_val = bt["metrics"].get(ocfg.metric, 0.0)
        results.append({
            "fast_ma": f, "slow_ma": s,
            "metric": round(metric_val, 3),
            "sharpe": round(bt["metrics"]["sharpe"], 3),
            "total_return": round(bt["metrics"]["total_return"], 3),
            "max_drawdown": round(bt["metrics"]["max_drawdown"], 3),
            "win_rate": round(bt["metrics"].get("win_rate", 0.0), 3),
            "trades": bt["metrics"].get("trades", 0),
        })
        if best is None or metric_val > best[1]:
            best = ((f, s), metric_val, bt)

    best_params, best_metric, best_bt = best
    best_signal = copy.copy(cfg.signal)
    best_signal.fast_ma, best_signal.slow_ma = best_params

    # 样本外验证：用训练段选出的最优参数在测试段回测
    oos_bt = _backtest_signals(test_klines, cfg, best_params[0], best_params[1])
    oos_metrics = dict(oos_bt["metrics"])

    results.sort(key=lambda r: r["metric"], reverse=True)
    return {
        "best_signal": best_signal,
        "best_metric": best_metric,
        "best_backtest": best_bt,
        "grid": results,
        "out_of_sample": {
            "metrics": oos_metrics,
            "dates": oos_bt["dates"],
            "equity": oos_bt["equity"],
        },
        "split": {
            "train_ratio": train_ratio,
            "train_bars": {c: len(v) for c, v in train_klines.items()},
            "test_bars": {c: len(v) for c, v in test_klines.items()},
        },
    }
