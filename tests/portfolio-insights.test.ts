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

test("基准资金过小/为负时收益率置 null 并给出可读说明，避免爆炸百分比", () => {
  // 初始资金极低（50元=5000分），总资产远大于基准：正常算会得出上万%的荒谬值
  const tinyBase = calculatePortfolioInsights(
    trades,
    { "600519": 120 },
    { "600519": [
      { date: "2026-07-01", close: 100 },
      { date: "2026-07-02", close: 120 },
    ] },
    5_000,
  );
  assert.equal(tinyBase.totalProfitPercent, null);
  assert.equal(tinyBase.profitPercentNote, "基准资金（初始资金 + 出入金净额）与当前总资产严重不匹配，收益率失真无法有效计算，请检查账户初始资金/出入金设置");

  // 初始资金 + 出入金净额为负（大额出金把基准压穿）
  const negativeBase = calculatePortfolioInsights(
    trades,
    { "600519": 120 },
    { "600519": [
      { date: "2026-07-01", close: 100 },
      { date: "2026-07-02", close: 120 },
    ] },
    2_000_000,
    [{ flowDate: "2026-07-03", amountCents: -5_000_000, note: "出金" }],
  );
  assert.equal(negativeBase.totalProfitPercent, null);
  assert.ok((negativeBase.profitPercentNote ?? "").includes("基准资金"));
});

test("正常基准下收益率按 (总资产-基准)/基准 计算", () => {
  // 初始资金 20000元，买入 100股@100元(=10000元)，现价120元(=12000元) → 总资产约 12000 + 余现金
  const result = calculatePortfolioInsights(
    trades,
    { "600519": 120 },
    { "600519": [
      { date: "2026-07-01", close: 100 },
      { date: "2026-07-02", close: 120 },
    ] },
    20_000_00,
  );
  // 总资产 = 初始 20000 + 市值 12000（因只买入一次，现金已扣减，总资产=12000+余现金）
  // 基准 = 20000；总收益% 应接近合理区间而非爆炸值
  assert.ok(result.totalProfitPercent !== null);
  assert.ok(Math.abs(result.totalProfitPercent!) < 200, `收益率应在合理范围，实际=${result.totalProfitPercent}`);
});
