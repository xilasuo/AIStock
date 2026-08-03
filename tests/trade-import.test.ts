import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMaxLossAlerts, parseBrokerCsv, prepareTradeInput } from "../lib/trade-import.ts";

test("解析东方财富风格交割单", () => {
  const csv = [
    "成交日期,证券代码,证券名称,买卖标志,成交价格,成交数量,手续费",
    "2026-01-02,600000,浦发银行,买入,10.50,1000,5.00",
    "2026-01-10,600000,浦发银行,卖出,12.30,1000,5.00",
  ].join("\n");
  const rows = parseBrokerCsv(csv);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].symbol, "600000");
  assert.equal(rows[0].side, "买入");
  assert.equal(rows[0].price, 10.5);
  assert.equal(rows[0].quantity, 1000);
  assert.equal(rows[0].fee, 5);
  assert.equal(rows[1].side, "卖出");
});

test("兼容带引号与千分位的字段", () => {
  const csv = [
    '日期,代码,名称,方向,价格,数量,金额',
    '2026/01/02,"600000","浦发银行","买入","10.50","1,000","10,500"',
  ].join("\n");
  const rows = parseBrokerCsv(csv);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tradeDate, "2026-01-02");
  assert.equal(rows[0].price, 10.5);
  assert.equal(rows[0].quantity, 1000);
});

test("识别带市场前缀的代码", () => {
  const csv = [
    "代码,方向,价格,数量,日期",
    "SH600000,买入,10.5,100,2026-01-02",
  ].join("\n");
  const rows = parseBrokerCsv(csv);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].symbol, "600000");
});

test("prepareTradeInput 校验买入金额安全范围", () => {
  const ok = prepareTradeInput({ symbol: "600000", name: "浦发银行", side: "买入", price: 10.5, quantity: 100, tradeDate: "2026-01-02", reason: "券商导入", fee: 0 });
  assert.ok(ok.values);
  assert.equal(ok.values?.priceCents, 1050);

  const bad = prepareTradeInput({ symbol: "600000", name: "浦发银行", side: "买入", price: -1, quantity: 100, tradeDate: "2026-01-02", reason: "券商导入" });
  assert.equal(bad.error, "价格和数量必须是有效的正数，且交易金额不能超出安全范围");
});

test("prepareTradeInput 拒绝未来日期", () => {
  const future = "2099-01-01";
  const result = prepareTradeInput({ symbol: "600000", name: "浦发银行", side: "买入", price: 10.5, quantity: 100, tradeDate: future, reason: "券商导入" });
  assert.equal(result.error, "交易日期不能晚于今天");
});

test("buildMaxLossAlerts 用技术面止损位（stopLoss）生成止损与止盈", () => {
  // 买入价 10 元，技术面止损 9.5（支撑位），无 maxLoss
  const alerts = buildMaxLossAlerts({
    symbol: "600000",
    name: "浦发银行",
    currentPriceMillis: 10000,
    maxLossTenThousandths: 0,
    stopLoss: 9.5,
  });
  assert.equal(alerts.length, 3);
  const stop = alerts.find((a) => a.type === "止损")!;
  assert.equal(stop.targetTenThousandths, 95000, "止损价用技术面支撑位 9.5 元");
  // 止盈一 = 10 + 1.5×(10-9.5) = 10.75
  const tp1 = alerts.find((a) => a.type === "止盈一")!;
  assert.equal(tp1.targetTenThousandths, 107500, "止盈一按 1.5R（基于技术面止损距离）");
});

test("buildMaxLossAlerts 无 stopLoss 时回退按 maxLoss 反推止损", () => {
  // 买入价 10 元，每股亏损 0.5 → 止损 9.5；止盈一 = 10+1.5×0.5 = 10.75
  const alerts = buildMaxLossAlerts({
    symbol: "600000",
    name: "浦发银行",
    currentPriceMillis: 10000,
    maxLossTenThousandths: 5000,
  });
  const stop = alerts.find((a) => a.type === "止损")!;
  assert.equal(stop.targetTenThousandths, 95000, "无技术面止损时按 maxLoss 反推止损价");
  const tp1 = alerts.find((a) => a.type === "止盈一")!;
  assert.equal(tp1.targetTenThousandths, 107500, "止盈一按 1.5R");
});
