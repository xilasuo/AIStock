import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEarlyProfile } from "../lib/domain/trade-statistics";
import type { Trade } from "../lib/domain/domain";

function buy(partial: Partial<Trade> & { reason: string }): Trade {
  return {
    id: 1,
    symbol: "600000",
    name: "浦发银行",
    side: "买入",
    priceCents: 1000,
    priceMillis: 10000,
    priceTenThousandths: 100000,
    quantity: 1000,
    tradeDate: "2026-08-01",
    feeCents: 5,
    createdAt: "",
    ...partial,
    maxLossCents: partial.maxLossCents ?? null,
  };
}

const PREFS = { maxConcentrationPercent: 30, commissionRateTenThousandths: 2.5 };

test("买入不足 3 笔返回空", () => {
  const items = buildEarlyProfile([buy({ reason: "业绩向好" })], 1_000_000, PREFS);
  assert.equal(items.length, 0);
});

test("3 笔全带计划+规则买 → 计划/理由为 good", () => {
  const trades = [
    buy({ reason: "业绩向好", maxLossCents: 500 }),
    buy({ reason: "放量突破", maxLossCents: 600 }),
    buy({ reason: "均线多头趋势", maxLossCents: 400 }),
  ];
  const items = buildEarlyProfile(trades, 1_000_000, PREFS);
  const plan = items.find((i) => i.key === "plan");
  const reason = items.find((i) => i.key === "reason");
  assert.equal(plan?.verdict, "good");
  assert.equal(reason?.verdict, "good");
});

test("多数情绪买入 → 理由 warn；多数无计划 → 计划 warn", () => {
  const trades = [
    buy({ reason: "怕踏空追涨" }),
    buy({ reason: "冲动买入" }),
    buy({ reason: "业绩向好", maxLossCents: 500 }),
  ];
  const items = buildEarlyProfile(trades, 1_000_000, PREFS);
  assert.equal(items.find((i) => i.key === "reason")?.verdict, "warn");
  assert.equal(items.find((i) => i.key === "plan")?.verdict, "warn");
});

test("单笔超集中度上限 → 集中度 warn", () => {
  // big 单笔 = 50000 股 × 10 元 = 50 万元；总资产 100 万元 → 单笔占 50% > 30% 上限
  const big = buy({ reason: "业绩向好", quantity: 50000, priceTenThousandths: 100000, maxLossCents: 500 });
  const small = buy({ reason: "放量突破", quantity: 1000, priceTenThousandths: 100000, maxLossCents: 500 });
  const third = buy({ reason: "回踩支撑企稳", quantity: 1000, priceTenThousandths: 100000, maxLossCents: 500 });
  const items = buildEarlyProfile([big, small, third], 100_000_000, PREFS);
  assert.equal(items.find((i) => i.key === "concentration")?.verdict, "warn");
});

test("手续费占比过高 → 交易成本 info", () => {
  const trades = [
    buy({ reason: "业绩向好", quantity: 100, priceTenThousandths: 100000, feeCents: 500, maxLossCents: 500 }),
    buy({ reason: "放量突破", quantity: 100, priceTenThousandths: 100000, feeCents: 500, maxLossCents: 500 }),
    buy({ reason: "回踩支撑企稳", quantity: 100, priceTenThousandths: 100000, feeCents: 500, maxLossCents: 500 }),
  ];
  // 每笔成交 1000 元、费用 5 元 → 5‰ > 1‰
  const items = buildEarlyProfile(trades, 1_000_000, PREFS);
  assert.ok(items.find((i) => i.key === "fee"));
});
