import assert from "node:assert/strict";
import test from "node:test";
import { isEtfCode, parseStockSuggestions, resolveStock } from "../lib/domain/stocks";

test("本地常用股票名称仍可直接解析", () => {
  assert.deepEqual(resolveStock("贵州茅台"), { code: "600519", name: "贵州茅台" });
});

test("实时搜索结果可以解析晶华新材", () => {
  const content = 'v_hint="sh~603683~\\u6676\\u534e\\u65b0\\u6750~jhxc~GP-A"';
  assert.deepEqual(parseStockSuggestions(content), [{ code: "603683", name: "晶华新材" }]);
});

test("实时搜索只保留内地A股", () => {
  const content = 'v_hint="hk~03750~\\u5b81\\u5fb7\\u65f6\\u4ee3~ndsd~GP^sz~300750~\\u5b81\\u5fb7\\u65f6\\u4ee3~ndsd~GP-A"';
  assert.deepEqual(parseStockSuggestions(content), [{ code: "300750", name: "宁德时代" }]);
});

test("没有搜索结果时返回空列表", () => {
  assert.deepEqual(parseStockSuggestions('v_hint="N";'), []);
});

test("159583识别为通信设备主题ETF", () => {
  assert.equal(isEtfCode("159583"), true);
  assert.deepEqual(resolveStock("159583"), { code: "159583", name: "富国中证通信设备主题ETF" });
});
