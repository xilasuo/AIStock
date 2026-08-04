import assert from "node:assert/strict";
import test from "node:test";
import { calculatePortfolioInsights } from "../lib/domain/portfolio-insights";
import type { Trade } from "../lib/domain/domain";

const trades: Trade[] = [
  {
    id: 1,
    symbol: "600519",
    name: "贵州茅台",
    side: "买入",
    priceCents: 10000,
    priceMillis: 100000,
    quantity: 100,
    tradeDate: "2026-07-01",
    reason: "测试",
    maxLossCents: null,
    feeCents: 100,
  },
];

test("按初始资金、现金和市值计算总仓位与盈亏", () => {
  const result = calculatePortfolioInsights(
    trades,
    { "600519": 120 },
    { "600519": [
      { date: "2026-07-01", close: 100 },
      { date: "2026-07-02", close: 120 },
    ] },
    2_000_000,
  );

  assert.equal(result.cashCents, 999_900);
  assert.equal(result.marketValueCents, 1_200_000);
  assert.equal(result.totalAssetsCents, 2_199_900);
  assert.equal(result.unrealizedCents, 199_900);
  assert.ok(Math.abs((result.totalPositionPercent ?? 0) - 54.548) < 0.01);
  assert.equal(result.history.length, 2);
});

test("未设置初始资金时仍计算持仓盈亏但不伪造总仓位", () => {
  const result = calculatePortfolioInsights(trades, { "600519": 120 }, {}, null);
  assert.equal(result.unrealizedCents, 199_900);
  assert.equal(result.totalPositionPercent, null);
  assert.equal(result.totalProfitCents, null);
});
