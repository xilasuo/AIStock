import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateTradeStatistics, type ReviewInput } from "../lib/domain/trade-statistics.ts";
import type { CapitalFlow, Trade } from "../lib/domain/domain.ts";

function trade(overrides: Partial<Trade> & Pick<Trade, "id" | "symbol" | "side" | "priceCents" | "quantity" | "tradeDate">): Trade {
  return {
    name: "测试股",
    priceMillis: overrides.priceCents * 10,
    priceTenThousandths: overrides.priceCents * 100,
    reason: "测试",
    maxLossCents: null,
    feeCents: 0,
    ...overrides,
  };
}

test("空交易返回零值统计", () => {
  const stats = calculateTradeStatistics([], [], []);
  assert.equal(stats.totalTrades, 0);
  assert.equal(stats.winRate, 0);
  assert.equal(stats.profitFactor, 0);
  assert.equal(stats.maxDrawdownCents, 0);
});

test("计算胜率、盈亏比与期望值", () => {
  const trades: Trade[] = [
    trade({ id: 1, symbol: "600000", side: "买入", priceCents: 1000, quantity: 100, tradeDate: "2026-01-02" }),
    trade({ id: 2, symbol: "600000", side: "卖出", priceCents: 1200, quantity: 100, tradeDate: "2026-01-10" }),
    trade({ id: 3, symbol: "600001", side: "买入", priceCents: 2000, quantity: 100, tradeDate: "2026-01-03" }),
    trade({ id: 4, symbol: "600001", side: "卖出", priceCents: 1800, quantity: 100, tradeDate: "2026-01-12" }),
  ];
  const stats = calculateTradeStatistics(trades, [], []);
  assert.equal(stats.totalTrades, 2);
  assert.equal(stats.winningTrades, 1);
  assert.equal(stats.losingTrades, 1);
  assert.equal(stats.winRate, 0.5);
  assert.equal(stats.realizedCents, 20000 - 20000);
  assert.equal(stats.profitFactor, 1);
  assert.equal(stats.expectancyCents, 0);
});

test("未平仓周期不计入统计", () => {
  const trades: Trade[] = [
    trade({ id: 1, symbol: "600000", side: "买入", priceCents: 1000, quantity: 100, tradeDate: "2026-01-02" }),
  ];
  const stats = calculateTradeStatistics(trades, [], []);
  assert.equal(stats.totalTrades, 0);
});

test("最大回撤基于资金曲线计算", () => {
  const trades: Trade[] = [
    trade({ id: 1, symbol: "600000", side: "买入", priceCents: 1000, quantity: 100, tradeDate: "2026-01-02" }),
    trade({ id: 2, symbol: "600000", side: "卖出", priceCents: 1500, quantity: 100, tradeDate: "2026-01-10" }),
    trade({ id: 3, symbol: "600001", side: "买入", priceCents: 1000, quantity: 100, tradeDate: "2026-01-11" }),
    trade({ id: 4, symbol: "600001", side: "卖出", priceCents: 800, quantity: 100, tradeDate: "2026-01-20" }),
  ];
  const capitalFlows: CapitalFlow[] = [{ id: 1, flowDate: "2026-01-01", amountCents: 100_00, note: "本金", createdAt: "2026-01-01" }];
  const stats = calculateTradeStatistics(trades, capitalFlows, []);
  assert.equal(stats.totalTrades, 2);
  assert.equal(stats.realizedCents, 50000 - 20000);
  assert.ok(stats.equityCurve.length > 1);
  assert.equal(stats.maxDrawdownCents, 20000);
  assert.ok(stats.maxDrawdownPercent > 0 && stats.maxDrawdownPercent < 100);
});

test("按标签聚合收益与胜率", () => {
  const trades: Trade[] = [
    trade({ id: 1, symbol: "600000", side: "买入", priceCents: 1000, quantity: 100, tradeDate: "2026-01-02" }),
    trade({ id: 2, symbol: "600000", side: "卖出", priceCents: 1200, quantity: 100, tradeDate: "2026-01-10" }),
    trade({ id: 3, symbol: "600001", side: "买入", priceCents: 2000, quantity: 100, tradeDate: "2026-01-03" }),
    trade({ id: 4, symbol: "600001", side: "卖出", priceCents: 1800, quantity: 100, tradeDate: "2026-01-12" }),
  ];
  const reviews: ReviewInput[] = [
    { cycleEndTradeId: 2, symbol: "600000", resultCents: 20000, tags: ["突破", "按计划"], followedPlan: true },
    { cycleEndTradeId: 4, symbol: "600001", resultCents: -20000, tags: ["追高", "没按计划"], followedPlan: false },
  ];
  const stats = calculateTradeStatistics(trades, [], reviews);
  const breakthrough = stats.byTag.find((item) => item.tag === "突破");
  assert.ok(breakthrough);
  assert.equal(breakthrough.realizedCents, 20000);
  assert.equal(breakthrough.winRate, 1);
  const chasing = stats.byTag.find((item) => item.tag === "追高");
  assert.ok(chasing);
  assert.equal(chasing.realizedCents, -20000);
  assert.equal(chasing.winRate, 0);
});

test("计划执行度：按计划与偏离计划的盈亏及胜率", () => {
  const reviews: ReviewInput[] = [
    { cycleEndTradeId: 1, symbol: "600000", resultCents: 20000, tags: ["按计划"], followedPlan: true },
    { cycleEndTradeId: 2, symbol: "600001", resultCents: -5000, tags: ["按计划"], followedPlan: true },
    { cycleEndTradeId: 3, symbol: "600002", resultCents: -20000, tags: ["没按计划"], followedPlan: false },
    { cycleEndTradeId: 4, symbol: "600003", resultCents: 30000, tags: ["没按计划"], followedPlan: false },
  ];
  const stats = calculateTradeStatistics([], [], reviews);
  assert.equal(stats.planAdherence.total, 4);
  assert.equal(stats.planAdherence.followed, 2);
  assert.equal(stats.planAdherence.rate, 0.5);
  assert.equal(stats.planAdherence.followedRealizedCents, 15000);
  assert.equal(stats.planAdherence.deviatedRealizedCents, 10000);
  assert.equal(stats.planAdherence.followedWinRate, 0.5);
  assert.equal(stats.planAdherence.deviatedWinRate, 0.5);
});

test("连胜与连亏统计", () => {
  const trades: Trade[] = [];
  let id = 0;
  const make = (symbol: string, buy: number, sell: number, day: string) => {
    trades.push(trade({ id: ++id, symbol, side: "买入", priceCents: buy, quantity: 100, tradeDate: day }));
    trades.push(trade({ id: ++id, symbol, side: "卖出", priceCents: sell, quantity: 100, tradeDate: day }));
  };
  make("600000", 1000, 1100, "2026-01-02");
  make("600001", 1000, 1200, "2026-01-03");
  make("600002", 1000, 900, "2026-01-04");
  make("600003", 1000, 800, "2026-01-05");
  const stats = calculateTradeStatistics(trades, [], []);
  assert.equal(stats.longestWinStreak, 2);
  assert.equal(stats.longestLossStreak, 2);
  assert.equal(stats.currentLossStreak, 2);
  assert.equal(stats.currentWinStreak, 0);
});
