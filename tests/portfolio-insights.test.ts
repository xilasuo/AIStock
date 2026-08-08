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
    [{ id: 1, flowDate: "2026-07-03", amountCents: -5_000_000, note: "出金", createdAt: "2026-07-03T00:00:00.000Z" }],
  );
  assert.equal(negativeBase.totalProfitPercent, null);
  assert.ok((negativeBase.profitPercentNote ?? "").includes("基准资金"));
});

test("单股占比在分母失真时不会爆炸成上千%（如 2010%），置 null 并给可读说明", () => {
  // 复现生产事故根因：初始资金被误设得极小，分母失真后 单股市值/总资产 会得出上千%的荒谬值。
  // 这正是「东方精工」回复里出现 2010% 单股仓位的代码层面防护点。
  const tinyBase = calculatePortfolioInsights(
    trades,
    { "600519": 120 },
    { "600519": [
      { date: "2026-07-01", close: 100 },
      { date: "2026-07-02", close: 120 },
    ] },
    5_000, // 50元，严重失真
  );
  const pos = tinyBase.positions[0];
  assert.equal(pos.allocationPercent, null, "分母失真时单股占比必须置 null，而非 2010%");
  assert.ok((pos.allocationPercentNote ?? "").includes("基准"), "应给出基准失真的可读说明，供 AI 注入而非自行编造占比");

  // 初始资金为负（大额出金压穿基准）：单股占比同样不得爆成上千%
  const negativeBase = calculatePortfolioInsights(
    trades,
    { "600519": 120 },
    { "600519": [
      { date: "2026-07-01", close: 100 },
      { date: "2026-07-02", close: 120 },
    ] },
    2_000_000,
    [{ id: 1, flowDate: "2026-07-03", amountCents: -5_000_000, note: "出金", createdAt: "2026-07-03T00:00:00.000Z" }],
  );
  const negPos = negativeBase.positions[0];
  assert.equal(negPos.allocationPercent, null, "基准为负时单股占比必须置 null");
  assert.ok((negPos.allocationPercentNote ?? "").length > 0, "应给可读说明");

  // 兜底：任何情况下单股占比都不得超过 100%（物理上单股市值不可能超过总资产）
  for (const r of [tinyBase, negativeBase]) {
    for (const p of r.positions) {
      if (p.allocationPercent !== null) {
        assert.ok(
          p.allocationPercent <= 100,
          `单股占比不得超过 100%，实际=${p.allocationPercent}（出现过 2010% 即此处漏防）`,
        );
      }
    }
  }
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
