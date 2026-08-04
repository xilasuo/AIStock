import { test } from "node:test";
import assert from "node:assert/strict";
import { computeOscillators, type ChartRow } from "../lib/domain/stocks.ts";

// 自带高低价波动的 K 线，保证 KDJ 的 RSV 有合理取值范围（high/low 不能相等）。
function ohlcRow(date: string, close: number): ChartRow {
  return {
    date,
    open: close,
    high: close * 1.03,
    low: close * 0.97,
    close,
    volume: 100,
    ma5: null,
    ma20: null,
    ma60: null,
  };
}

function buildOhlc(closes: number[]): ChartRow[] {
  return closes.map((close, i) => ohlcRow(`2026-01-${String(i + 1).padStart(2, "0")}`, close));
}

const LEN = 60; // 足够 MACD(26+9)/RSI(24)/KDJ(9) 计算

test("样本过短：MACD/RSI/KDJ 均返回 null", () => {
  const o = computeOscillators(buildOhlc([10, 11, 12]));
  assert.equal(o.macd, null);
  assert.equal(o.rsi, null);
  assert.equal(o.kdj, null);
});

test("持续上涨：RSI 超买、KDJ 超买钝化、MACD 偏多", () => {
  const closes = Array.from({ length: LEN }, (_, i) => Math.pow(i + 1, 1.6));
  const o = computeOscillators(buildOhlc(closes));
  assert.ok(o.macd, "MACD 应非空");
  assert.ok(
    o.macd!.state === "多头" || o.macd!.state === "金叉",
    `MACD 应偏多，实际 ${o.macd!.state}`,
  );
  assert.notEqual(o.macd!.divergence, "顶背离", "同步上涨不应判顶背离");
  assert.ok(o.rsi, "RSI 应非空");
  assert.equal(o.rsi!.zone, "超买", `RSI 区应超买，实际 ${o.rsi!.zone}`);
  assert.ok(o.kdj, "KDJ 应非空");
  assert.equal(o.kdj!.state, "超买钝化", `KDJ 应超买钝化，实际 ${o.kdj!.state}`);
});

test("持续下跌：RSI 超卖、KDJ 超卖钝化、MACD 偏弱", () => {
  const closes = Array.from({ length: LEN }, (_, i) => Math.pow(LEN - i, 0.7));
  const o = computeOscillators(buildOhlc(closes));
  assert.ok(o.macd, "MACD 应非空");
  assert.ok(
    o.macd!.state === "空头" || o.macd!.state === "死叉",
    `MACD 应偏弱，实际 ${o.macd!.state}`,
  );
  assert.ok(o.rsi, "RSI 应非空");
  assert.equal(o.rsi!.zone, "超卖", `RSI 区应超卖，实际 ${o.rsi!.zone}`);
  assert.ok(o.kdj, "KDJ 应非空");
  assert.equal(o.kdj!.state, "超卖钝化", `KDJ 应超卖钝化，实际 ${o.kdj!.state}`);
});

test("温和波动：RSI 处于中性区", () => {
  const closes = Array.from({ length: LEN }, (_, i) => 10 + Math.sin(i) * 0.5);
  const o = computeOscillators(buildOhlc(closes));
  assert.ok(o.rsi, "RSI 应非空");
  assert.equal(o.rsi!.zone, "中性", `RSI 区应中性，实际 ${o.rsi!.zone}`);
});

test("数值合理性：有限且 RSI 落在 [0,100]", () => {
  const closes = Array.from({ length: LEN }, (_, i) => 10 + Math.sin(i) * 3 + i * 0.05);
  const o = computeOscillators(buildOhlc(closes));
  if (o.macd) {
    assert.ok(Number.isFinite(o.macd.dif));
    assert.ok(Number.isFinite(o.macd.dea));
    assert.ok(Number.isFinite(o.macd.hist));
    assert.ok(
      Math.abs(o.macd.hist - (o.macd.dif - o.macd.dea) * 2) < 1e-9,
      "红绿柱应为 (DIF-DEA)*2",
    );
  }
  if (o.rsi) {
    for (const key of ["rsi6", "rsi12", "rsi24"] as const) {
      const value = o.rsi[key];
      if (value !== null) {
        assert.ok(value >= 0 && value <= 100, `${key} 应落在 [0,100]，实际 ${value}`);
      }
    }
  }
  if (o.kdj) {
    assert.ok(Number.isFinite(o.kdj.k!));
    assert.ok(Number.isFinite(o.kdj.d!));
    assert.ok(Number.isFinite(o.kdj.j!));
  }
});
