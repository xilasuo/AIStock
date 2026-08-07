import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateMarketHistory,
  buildTradeCycles,
  calculatePortfolio,
  findInvalidSell,
  isIsoDate,
  isStockCode,
  localIsoDate,
  toCents,
  toMillis,
  toTenThousandths,
  type Trade,
} from "../lib/domain/domain";
import { tencentSymbol } from "../lib/domain/stocks";

function trade(values: Partial<Trade>): Trade {
  return {
    id: 1,
    symbol: "600519",
    name: "贵州茅台",
    side: "买入",
    priceCents: 10_000,
    quantity: 100,
    tradeDate: "2026-07-01",
    reason: "测试",
    maxLossCents: null,
    feeCents: 0,
    ...values,
  };
}

test("分批买卖按移动平均成本计算持仓和已实现盈亏", () => {
  const summary = calculatePortfolio([
    trade({ id: 1, priceCents: 10_000, quantity: 100 }),
    trade({ id: 2, priceCents: 12_000, quantity: 100, tradeDate: "2026-07-02" }),
    trade({ id: 3, side: "卖出", priceCents: 13_000, quantity: 150, tradeDate: "2026-07-03", feeCents: 100 }),
  ]);

  assert.equal(summary.positions.length, 1);
  assert.equal(summary.positions[0].quantity, 50);
  assert.equal(summary.positions[0].averageCostCents, 11_000);
  assert.equal(summary.realizedCents, 299_900);
  assert.equal(summary.winningSells, 1);
});

test("超出持仓数量的卖出不会制造负持仓", () => {
  const summary = calculatePortfolio([
    trade({ quantity: 20 }),
    trade({ id: 2, side: "卖出", quantity: 100, priceCents: 9_000, tradeDate: "2026-07-02" }),
  ]);
  assert.equal(summary.positions.length, 0);
  assert.equal(summary.realizedCents, -20_000);
});

test("卖出被截断时手续费按实际成交比例摊销", () => {
  // 持仓 20 股，卖单申报 100 股：实际只能成交 20 股（1/5），
  // 手续费 500 分也应只摊 1/5（100 分），而不是整笔扣除。
  // 收入 20×90 元 - 成本 20×100 元 = -200 元，再扣 1 元手续费 = -201 元。
  const summary = calculatePortfolio([
    trade({ quantity: 20, priceCents: 10_000 }),
    trade({
      id: 2,
      side: "卖出",
      quantity: 100,
      priceCents: 9_000,
      tradeDate: "2026-07-02",
      feeCents: 500,
    }),
  ]);

  assert.equal(summary.realizedCents, -20_100);
});

test("卖出未被截断时手续费全额计入", () => {
  // 持仓与卖出数量一致，不存在截断，手续费应 100% 计入。
  const summary = calculatePortfolio([
    trade({ quantity: 100, priceCents: 10_000 }),
    trade({
      id: 2,
      side: "卖出",
      quantity: 100,
      priceCents: 11_000,
      tradeDate: "2026-07-02",
      feeCents: 500,
    }),
  ]);

  assert.equal(summary.realizedCents, 99_500);
});

test("多次部分卖出的成本摊销不累积舍入误差", () => {
  // 成本无法整除的标的分三次卖光，最终应无残留持仓与残留成本。
  const summary = calculatePortfolio([
    trade({ id: 1, side: "买入", priceCents: 33, priceMillis: 333, quantity: 3 }),
    trade({ id: 2, side: "卖出", priceCents: 33, priceMillis: 333, quantity: 1, tradeDate: "2026-07-02" }),
    trade({ id: 3, side: "卖出", priceCents: 33, priceMillis: 333, quantity: 1, tradeDate: "2026-07-03" }),
    trade({ id: 4, side: "卖出", priceCents: 33, priceMillis: 333, quantity: 1, tradeDate: "2026-07-04" }),
  ]);

  assert.equal(summary.positions.length, 0);
});

test("按日期补录的卖出不能破坏后续交易的可卖数量", () => {
  const trades: Trade[] = [
    trade({ id: 1, side: "买入", quantity: 100, tradeDate: "2026-07-10" }),
    trade({ id: 2, side: "卖出", quantity: 100, tradeDate: "2026-07-20" }),
    trade({ id: 3, side: "卖出", quantity: 50, tradeDate: "2026-07-15" }),
  ];

  assert.deepEqual(findInvalidSell(trades), {
    symbol: "600519",
    availableQuantity: 50,
    requestedQuantity: 100,
  });
});

test("完全卖出后不会把毫厘舍入残差带入下一次持仓", () => {
  const result = calculatePortfolio([
    trade({ id: 1, side: "买入", priceCents: 33, priceMillis: 334, quantity: 3 }),
    trade({ id: 2, side: "卖出", priceCents: 33, priceMillis: 334, quantity: 3 }),
    trade({ id: 3, side: "买入", priceCents: 50, priceMillis: 500, quantity: 1 }),
  ]);

  assert.equal(result.positions[0].costMillis, 500);
  assert.equal(result.positions[0].averageCostMillis, 500);
});

test("金额和基础字段验证保持严格", () => {
  assert.equal(toCents("12.345"), 1235);
  assert.equal(toMillis("0.615"), 615);
  assert.equal(toTenThousandths("1.4821"), 14821);
  assert.equal(toCents("bad"), 0);
  assert.equal(isStockCode("600519"), true);
  assert.equal(isStockCode("60051"), false);
  assert.equal(isIsoDate("2026-07-29"), true);
  assert.equal(isIsoDate("2026-02-30"), false);
  assert.equal(isIsoDate("29/07/2026"), false);
});

test("四位小数成交均价会原样参与持仓计算", () => {
  const result = calculatePortfolio([
    trade({
      id: 1,
      priceCents: 148,
      priceMillis: 1482,
      priceTenThousandths: 14821,
      quantity: 1090,
    }),
  ]);

  assert.equal(result.positions[0].averageCostTenThousandths, 14821);
  assert.equal(result.positions[0].costTenThousandths, 16_154_890);
});

test("ETF价格按千分之一元保存并计算持仓", () => {
  const summary = calculatePortfolio([
    trade({ id: 1, priceCents: 62, priceMillis: 615, quantity: 100 }),
    trade({ id: 2, side: "卖出", priceCents: 63, priceMillis: 630, quantity: 100, tradeDate: "2026-07-02" }),
  ]);

  assert.equal(summary.positions.length, 0);
  assert.equal(summary.realizedCents, 150);
});

test("5开头ETF映射到上海市场", () => {
  assert.equal(tencentSymbol("513180"), "sh513180");
});

test("部分卖出不会提前生成待复盘周期", () => {
  const cycles = buildTradeCycles([
    trade({ id: 1, quantity: 100 }),
    trade({ id: 2, side: "卖出", quantity: 40, priceCents: 11_000, tradeDate: "2026-07-02" }),
  ]);

  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].endTradeId, null);
  assert.equal(cycles[0].trades.length, 2);
});

test("同一股票的多次完整持仓分别形成复盘周期", () => {
  const cycles = buildTradeCycles([
    trade({ id: 1, quantity: 100 }),
    trade({ id: 2, side: "卖出", quantity: 100, priceCents: 11_000, tradeDate: "2026-07-02" }),
    trade({ id: 3, quantity: 50, priceCents: 12_000, tradeDate: "2026-07-03" }),
    trade({ id: 4, side: "卖出", quantity: 50, priceCents: 11_000, tradeDate: "2026-07-04" }),
  ]);

  assert.equal(cycles.length, 2);
  assert.deepEqual(cycles.map((cycle) => cycle.endTradeId), [2, 4]);
  assert.deepEqual(cycles.map((cycle) => cycle.realizedCents), [100_000, -50_000]);
});

test("表单默认日期使用本地年月日而不是UTC截断", () => {
  assert.equal(localIsoDate(new Date(2026, 6, 29, 0, 30)), "2026-07-29");
});

test("日线可以聚合为周K和月K并重新计算均线", () => {
  const history = [
    { date: "2026-06-29", open: 10, high: 12, low: 9, close: 11, volume: 100 },
    { date: "2026-06-30", open: 11, high: 13, low: 10, close: 12, volume: 200 },
    { date: "2026-07-01", open: 12, high: 14, low: 11, close: 13, volume: 300 },
    { date: "2026-07-06", open: 13, high: 15, low: 12, close: 14, volume: 400 },
    { date: "2026-07-07", open: 14, high: 16, low: 13, close: 15, volume: 500 },
  ];

  const weekly = aggregateMarketHistory(history, "week");
  assert.deepEqual(weekly.map(({ date, open, high, low, close, volume }) => (
    { date, open, high, low, close, volume }
  )), [
    { date: "2026-07-01", open: 10, high: 14, low: 9, close: 13, volume: 600 },
    { date: "2026-07-07", open: 13, high: 16, low: 12, close: 15, volume: 900 },
  ]);

  const monthly = aggregateMarketHistory(history, "month");
  assert.equal(monthly.length, 2);
  assert.equal(monthly[0].close, 12);
  assert.equal(monthly[1].open, 12);
});
