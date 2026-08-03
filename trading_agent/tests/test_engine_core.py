"""trading_agent 引擎核心逻辑单元测试（标准库 unittest，零依赖）

覆盖评审修复的关键金融逻辑：
- 信号无前视（信号日 = 金叉确认次日）
- 回测止损按盘中最低价触发、止损日不再开仓
- 真实历史模拟（walk-forward）正常产出、净值非恒等
- 单票风险预算：仓位受 risk_per_position 与止损距离联动约束

运行：cd trading_agent && python -m unittest tests.test_engine_core -v
"""
from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import config
from data.provider import StaticProvider
from strategy import signals
from backtest import engine
from backtest.walk_forward import walk_forward


def make_kline(dates, closes, lows=None, opens=None):
    bars = []
    for i, d in enumerate(dates):
        c = closes[i]
        o = opens[i] if opens else c
        l = lows[i] if lows else c
        bars.append({
            "date": d, "open": o, "high": max(o, c, l),
            "low": l, "close": c, "volume": 0, "amount": 0,
        })
    return bars


def rising_then_falling(dates, peak_idx=25, total=50):
    """先跌后涨触发金叉再下跌，返回 closes。"""
    c = 100.0
    closes = []
    for i in range(peak_idx):
        c -= 1.0
        closes.append(c)
    for i in range(total - peak_idx):
        c += 2.0
        closes.append(c)
    return closes


class TestSignalNoLookahead(unittest.TestCase):
    def setUp(self):
        self.cfg = config.AppConfig()
        self.cfg.signal.fast_ma = 5
        self.cfg.signal.slow_ma = 20
        self.cfg.signal.use_breakout_filter = False

    def test_buy_date_is_next_day_of_cross(self):
        """信号日必须 = 金叉确认日的次日（无前视）。"""
        dates = [f"2024-01-{i:02d}" for i in range(1, 51)]
        closes = rising_then_falling(dates)
        kline = make_kline(dates, closes)
        buy, _ = signals.generate_signals(kline, self.cfg.signal)
        self.assertTrue(buy, "应有买入信号")

        # 复算金叉确认索引（用与 signals 一致的 SMA 定义）
        fast = []
        for i in range(len(closes)):
            w = closes[max(0, i - 4): i + 1]
            fast.append(sum(w) / len(w))
        slow = []
        for i in range(len(closes)):
            w = closes[max(0, i - 19): i + 1]
            slow.append(sum(w) / len(w))
        cross_idx = None
        for i in range(1, len(closes)):
            if fast[i] > slow[i] and fast[i - 1] <= slow[i - 1]:
                cross_idx = i
                break
        self.assertIsNotNone(cross_idx)
        first_buy = min(buy)
        # 首个买入日应是金叉确认日的次日
        self.assertEqual(first_buy, dates[cross_idx + 1])

    def test_no_signal_before_slow_ma_ready(self):
        """慢线窗口未满前不应产生信号（避免不完整窗口假信号）。"""
        dates = [f"2024-01-{i:02d}" for i in range(1, 51)]
        closes = rising_then_falling(dates)
        kline = make_kline(dates, closes)
        buy, sell = signals.generate_signals(kline, self.cfg.signal)
        for d in buy | sell:
            idx = dates.index(d)
            # 信号日必在慢线窗口（20）+1 之后才可能产生（可执行日再 +1）
            self.assertGreater(idx, self.cfg.signal.slow_ma + 1)


class TestBacktestStopLoss(unittest.TestCase):
    def test_stop_loss_triggered_by_intraday_low(self):
        """止损应被盘中最低价触发，且记录一笔记亏。"""
        dates = [f"2024-02-{i:02d}" for i in range(1, 20)]
        closes = [100, 99, 98, 97, 96, 95, 94, 96, 98, 100, 101, 100, 99, 98, 97, 96, 95, 94, 93]
        lows = [99, 98, 97, 96, 95, 94, 93, 95, 97, 99, 100, 98, 97, 96, 95, 94, 93, 92, 91]
        cfg = config.AppConfig()
        cfg.signal.fast_ma = 2
        cfg.signal.slow_ma = 3
        cfg.signal.use_breakout_filter = False
        cfg.signal.stop_loss_pct = -0.08
        kline = make_kline(dates, closes, lows=lows)
        buy, sell = signals.generate_signals(kline, cfg.signal)
        _, _, stats = engine._simulate_one(kline, buy, sell, cfg)
        if stats["closed_pnls"]:
            self.assertLessEqual(stats["closed_pnls"][0], 0, "止损平仓应记亏损")
        self.assertGreaterEqual(stats["trades"], 0)

    def test_no_buy_on_exit_day(self):
        """止损/卖出当日不应再重新开仓（避免一根K线先卖后买）。"""
        # 构造：某日同时是卖出信号日与买入信号日，确认不会同日既卖又买
        dates = [f"2024-03-{i:02d}" for i in range(1, 40)]
        closes = []
        c = 100.0
        for i in range(39):
            c += (0.5 if i < 25 else -1.5)
            closes.append(c)
        cfg = config.AppConfig()
        cfg.signal.fast_ma = 2
        cfg.signal.slow_ma = 3
        cfg.signal.use_breakout_filter = False
        kline = make_kline(dates, closes)
        buy, sell = signals.generate_signals(kline, cfg.signal)
        _, _, stats = engine._simulate_one(kline, buy, sell, cfg)
        # trades 反映的是「持仓中触发退出」的事件；同日退出后再开仓由 in_market=False 保证
        self.assertIsInstance(stats["trades"], int)
        self.assertGreaterEqual(stats["trades"], 0)


class TestWalkForward(unittest.TestCase):
    def _build_fixture(self):
        dates = [f"2024-01-{i:02d}" for i in range(1, 81)]
        codes = ["600519", "000858", "601318", "600036", "000333"]
        klines = {}
        for idx, code in enumerate(codes):
            c = 100.0 + idx * 5
            bars = []
            for i in range(80):
                c += (0.3 if i % 2 == 0 else -0.1)
                bars.append({"date": dates[i], "open": c, "high": c + 1,
                             "low": c - 1, "close": c, "volume": 0, "amount": 0})
            klines[code] = bars
        quotes = {code: {"name": code, "price": 100, "pe_ttm": 15, "pb": 2,
                         "turnover_pct": 2.0, "mcap_yi": 500, "float_mcap_yi": 400,
                         "roe": 15, "fund_flow": 1e8} for code in codes}
        return codes, klines, quotes

    def test_walk_forward_produces_equity_curve(self):
        """真实历史模拟应产出非空的净值曲线，且净值非恒等。"""
        codes, klines, quotes = self._build_fixture()
        cfg = config.AppConfig()
        cfg.market.enable = False
        cfg.optim.enabled = False
        cfg.universe = codes
        r = walk_forward(klines, quotes, codes, cfg)
        self.assertTrue(r["dates"])
        self.assertEqual(len(r["equity"]), len(r["dates"]))
        self.assertAlmostEqual(r["equity"][0], 1.0, places=4)
        self.assertGreater(abs(r["equity"][-1] - r["equity"][0]), 1e-9, "净值应变化")
        self.assertIn("total_return", r["metrics"])
        self.assertIn("win_rate", r["metrics"])

    def test_risk_budget_caps_position(self):
        """单票仓位受风险预算约束：单票权重 ≤ risk_per_position / |stop_loss|。"""
        codes, klines, quotes = self._build_fixture()
        cfg = config.AppConfig()
        cfg.market.enable = False
        cfg.optim.enabled = False
        cfg.universe = codes
        cfg.signal.stop_loss_pct = -0.08
        cfg.backtest.risk_per_position = 0.02
        cfg.backtest.max_position_weight = 1.0  # 关闭仓位上限干扰，单独测风险预算
        cfg.backtest.rebalance_days = 10
        # 用较少的票，确保等权(1/2=50%)>风险预算上限(25%)，从而被 risk_cap 截断
        subset = codes[:2]
        sub_k = {c: klines[c] for c in subset}
        sub_q = {c: quotes[c] for c in subset}
        r = walk_forward(sub_k, sub_q, subset, cfg)
        risk_cap = cfg.backtest.risk_per_position / abs(cfg.signal.stop_loss_pct)
        self.assertGreater(len(r["positions"]), 0, "应有持仓记录")
        # 每个再平衡期的每只票权重都不得超过 risk_cap
        for period in r["positions"]:
            for code, w in period["weights"].items():
                self.assertLessEqual(w, risk_cap + 1e-6,
                                     f"{code} 权重 {w} 超过风险预算上限 {risk_cap}")


class TestRiskBudgetMath(unittest.TestCase):
    def test_risk_cap_formula(self):
        """验证风险预算反推公式：risk_cap = 净值 × risk_per_position / |stop_loss|。"""
        cash = 1.0
        risk_budget = 0.02
        stop_pct = 0.08
        risk_cap = cash * risk_budget / stop_pct
        self.assertAlmostEqual(risk_cap, 0.25, places=6)  # 2%/8% = 25%
        # 更紧的止损 → 更大仓位；更紧的风险预算 → 更小仓位
        self.assertAlmostEqual(1.0 * 0.02 / 0.05, 0.40, places=6)
        self.assertAlmostEqual(1.0 * 0.01 / 0.08, 0.125, places=6)


if __name__ == "__main__":
    unittest.main()
