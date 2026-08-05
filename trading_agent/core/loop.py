"""闭环编排（对应架构图内循环：选票→操作→回测→优化策略）

编排四步流水线，产出供报告/通知使用的结果字典。
"""
from __future__ import annotations

import copy

import config
from data import universe as universe_mod, provider
from data.provider import StaticProvider
from strategy import screener, signals, market_state
from backtest import engine
from timeutil import sh_now


def _zero_metrics() -> dict:
    """空仓（无入选）时的零化指标，保证下游报告/前端不崩。"""
    return {
        "total_return": 0.0,
        "annual_return": 0.0,
        "sharpe": 0.0,
        "max_drawdown": 0.0,
        "win_rate": 0.0,
        "trades": 0,
        "n_stocks": 0,
    }


def run(cfg: config.AppConfig, dp=None) -> dict:
    """运行完整闭环，产出结果字典。

    dp: DataProvider（可注入）。None 时回退默认数据源（腾讯/东财直连）。
    当 WorkBuddy 中枢取数后，应传入 StaticProvider 让引擎用中枢数据计算。
    """
    dp = dp or provider.default_provider()

    # 0) 市场状态（风控前置）：取宽基指数 K 线判定牛/中性/熊，给出仓位系数
    regime = {
        "state": "unknown", "position_factor": 1.0, "score": 0.0,
        "detail": "市场状态未启用（config.market.enable=False）",
        "ma_gap": 0.0, "momentum": 0.0,
    }
    if cfg.market.enable:
        mk = dp.fetch_kline(cfg.market.index_code, cfg.beg, cfg.end)
        # 静态/中枢注入模式下无指数行情则不回退实时网络（避免无谓延迟），
        # 直接判为 unknown（中性，不强行空仓）；实时直连模式才回退取指数。
        if not mk and not isinstance(dp, StaticProvider):
            mk = provider.default_provider().fetch_kline(cfg.market.index_code, cfg.beg, cfg.end)
        regime = market_state.detect_regime(cfg, mk)

    # 1) 选票（按仓位系数缩放实际选股数；熊市 position=0 → 空仓）
    target_top_n = cfg.screener.top_n
    eff_top_n = max(0, int(round(target_top_n * regime["position_factor"])))
    codes = universe_mod.get_universe(cfg, dp)
    screen_out = screener.screen(cfg, codes, dp, top_n_override=eff_top_n)
    selected = screen_out["rows"]
    screener_meta = screen_out.get("meta") or {}
    selected_codes = [r["code"] for r in selected]

    # 1.5) 真实历史模拟（滚动再平衡回测，消除幸存者偏差）
    # 在候选池全量上做 walk-forward：每期只用「截至当期」的数据重选票，
    # 产出无前视的真实历史绩效。相比用"今天选票回测过去"的乐观结果更可信。
    walk_forward_bt = None
    try:
        if codes:
            from backtest.walk_forward import walk_forward
            # 预取候选池全量历史 K 线（供 walk-forward 逐期截取）
            all_klines = {c: dp.fetch_kline(c, cfg.beg, cfg.end) for c in codes}
            all_quotes = {c: dp.fetch_quote(c) for c in codes}
            walk_forward_bt = walk_forward(all_klines, all_quotes, codes, cfg)
    except Exception:  # noqa: BLE001
        walk_forward_bt = None

    # 拉取已选标的的历史 K 线（回测/信号所需）
    code_klines = {c: dp.fetch_kline(c, cfg.beg, cfg.end) for c in selected_codes}

    # 2) 操作（当前参数下的信号）
    code_signals = {c: signals.generate_signals(code_klines[c], cfg.signal) for c in selected_codes}

    # 空仓保护：无入选标的时跳过回测/优化，产出零化指标，避免引擎崩溃
    if not selected_codes:
        result = {
            "meta": {
                "generated_at": sh_now().strftime("%Y-%m-%d %H:%M:%S"),
                "beg": cfg.beg,
                "end": cfg.end,
                "universe_size": len(codes),
                "top_n": target_top_n,
                "selected_n": 0,
                "notifier": cfg.notifier,
            },
            "market_state": regime,
            "screener": screener_meta,
            "selected": [],
            "base": {
                "signal": {"fast_ma": cfg.signal.fast_ma, "slow_ma": cfg.signal.slow_ma},
                "metrics": _zero_metrics(),
            },
            "final": {
                "signal": {"fast_ma": cfg.signal.fast_ma, "slow_ma": cfg.signal.slow_ma},
                "metrics": _zero_metrics(),
                "dates": [],
                "equity": [],
                "n_signals_total": 0,
            },
        }
        return result

    base_bt = engine.backtest(code_klines, code_signals, cfg)

    # 补充每只标的的信号条数（买入 + 卖出事件）与信号时点
    # signal_time = 该股 K 线最新 bar 的日期（日线即信号依据的行情日；
    # 盘后扫描=当日收盘，盘前/盘中=最新可用交易日）。供榜单展示「选出时间」。
    for r in selected:
        bs = code_signals.get(r["code"], (set(), set()))
        r["n_signals"] = len(bs[0]) + len(bs[1])
        _bars = code_klines.get(r["code"]) or []
        r["signal_time"] = _bars[-1].get("date") if _bars else ""

    result = {
        "meta": {
            "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "beg": cfg.beg,
            "end": cfg.end,
            "universe_size": len(codes),
            "top_n": target_top_n,
            "selected_n": len(selected),
            "notifier": cfg.notifier,
        },
        "market_state": regime,
        "screener": screener_meta,
        "selected": selected,
        "base": {
            "signal": {"fast_ma": cfg.signal.fast_ma, "slow_ma": cfg.signal.slow_ma},
            "metrics": base_bt["metrics"],
        },
    }

    # 3)+4) 回测 + 优化策略（迭代）
    if cfg.optim.enabled and selected_codes:
        from optimization import optimizer
        opt = optimizer.optimize(code_klines, selected_codes, cfg)
        best_bt = opt["best_backtest"]
        result["optimized"] = {
            "best_signal": {
                "fast_ma": opt["best_signal"].fast_ma,
                "slow_ma": opt["best_signal"].slow_ma,
            },
            "best_metrics": best_bt["metrics"],
            "grid": opt["grid"],
            # 样本外绩效（真实可期，防过拟合）；前端/报告应优先展示此项
            "out_of_sample": opt.get("out_of_sample") or {},
            "split": opt.get("split") or {},
        }
        # 若样本外可用，最终绩效改用样本外（诚实呈现，避免样本内美化）
        oos = opt.get("out_of_sample") or {}
        if oos.get("metrics"):
            final_bt = {
                "metrics": oos["metrics"],
                "dates": oos.get("dates", []),
                "equity": oos.get("equity", []),
            }
        else:
            final_bt = best_bt
        final_signal = opt["best_signal"]
    else:
        final_bt = base_bt
        final_signal = cfg.signal

    # 统计最终信号总条数（买入 + 卖出事件）
    final_signals = {c: signals.generate_signals(code_klines[c], final_signal) for c in selected_codes}
    n_signals_total = sum(len(s[0]) + len(s[1]) for s in final_signals.values())

    result["final"] = {
        "signal": {"fast_ma": final_signal.fast_ma, "slow_ma": final_signal.slow_ma},
        "metrics": final_bt["metrics"],
        "dates": final_bt["dates"],
        "equity": final_bt["equity"],
        "n_signals_total": n_signals_total,
    }

    # 真实历史模拟（walk-forward）：诚实呈现，避免幸存者偏差
    if walk_forward_bt is not None:
        wf = walk_forward_bt
        result["walk_forward"] = {
            "metrics": wf["metrics"],
            "dates": wf["dates"],
            "equity": wf["equity"],
            "rebalance_days": wf["rebalance_days"],
            "positions": wf.get("positions", []),
        }
    return result
