import { test } from "node:test";
import assert from "node:assert/strict";
import { baseCloseSince } from "../lib/domain/stocks";

const rows = [
  { date: "2026-07-25", close: 100 },
  { date: "2026-07-28", close: 110 },
  { date: "2026-07-29", close: 121 },
  { date: "2026-07-30", close: 130 },
];

test("取加入日当天收盘价作为基准", () => {
  assert.equal(baseCloseSince(rows, "2026-07-29"), 121);
});

test("加入时间带时分秒也按日期比较，取当天收盘", () => {
  assert.equal(baseCloseSince(rows, "2026-07-29T14:30:00.000Z"), 121);
});

test("取加入日之前最近一个交易日的收盘价", () => {
  // 2026-07-27 是非交易日（周日），应回退到 07-25 的 100
  assert.equal(baseCloseSince(rows, "2026-07-27"), 100);
});

test("加入时间晚于全部历史时取最后一条收盘", () => {
  assert.equal(baseCloseSince(rows, "2026-08-05"), 130);
});

test("加入时间早于全部历史时退化为最早一条", () => {
  assert.equal(baseCloseSince(rows, "2026-01-01"), 100);
});

test("空历史返回 null", () => {
  assert.equal(baseCloseSince([], "2026-07-30"), null);
});

test("可据此计算自加入关注以来的涨跌幅", () => {
  const base = baseCloseSince(rows, "2026-07-28") as number;
  const current = 130;
  const changePercent = ((current - base) / base) * 100;
  assert.ok(Math.abs(changePercent - 18.18) < 0.01);
});
