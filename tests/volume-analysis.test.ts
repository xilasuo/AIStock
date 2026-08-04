import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeVolume, type ChartRow } from "../lib/domain/stocks.ts";

function row(date: string, close: number, volume: number): ChartRow {
  return { date, open: close, high: close, low: close, close, volume, ma5: null, ma20: null, ma60: null };
}

// 构造一段 K 线：closes / volumes 长度一致，日期顺序递增
function build(closes: number[], volumes: number[]): ChartRow[] {
  return closes.map((close, i) => row(`2026-01-${String(i + 1).padStart(2, "0")}`, close, volumes[i]));
}

const FLAT = 40; // 多数场景用 40 根，保证均量/背离判定有足够样本

test("明显放量：当日量远大于近20日均量", () => {
  const closes = Array.from({ length: FLAT }, (_, i) => 10 + (i % 11)); // 5~15 波动，末值落在中段
  const volumes = Array.from({ length: FLAT }, () => 100);
  volumes[FLAT - 1] = 300; // 末根显著放量
  const v = analyzeVolume(build(closes, volumes));

  assert.ok(v.ratio !== null && v.ratio >= 1.5, `量比应 >= 1.5，实际 ${v.ratio}`);
  assert.equal(v.divergence, "无明显背离"); // 价格在中段，不应触发背离
});

test("明显缩量：当日量远小于近20日均量", () => {
  const closes = Array.from({ length: FLAT }, (_, i) => 5 + (i % 11)); // 5~15 波动，末值落在中段
  const volumes = Array.from({ length: FLAT }, () => 100);
  volumes[FLAT - 1] = 30; // 末根显著缩量
  const v = analyzeVolume(build(closes, volumes));

  assert.ok(v.ratio !== null && v.ratio < 0.6, `量比应 < 0.6，实际 ${v.ratio}`);
  assert.equal(v.divergence, "无明显背离");
});

test("顶背离：价格创新高但末根量能未跟上", () => {
  const closes = Array.from({ length: FLAT }, (_, i) => i + 1); // 1..40 单调上行，末值=区间最高
  const volumes = Array.from({ length: FLAT }, () => 200); // 区间最大量 200
  volumes[FLAT - 1] = 100; // 末根量 < 0.6 * 200 = 120
  const v = analyzeVolume(build(closes, volumes));

  assert.equal(v.divergence, "顶背离");
});

test("底背离：价格创新低且末根缩量", () => {
  const closes = Array.from({ length: FLAT }, (_, i) => FLAT - i); // 40..1 单调下行，末值=区间最低
  const volumes = Array.from({ length: FLAT }, () => 200); // 区间最大量 200
  volumes[FLAT - 1] = 100; // 末根量 < 0.6 * 200 = 120
  const v = analyzeVolume(build(closes, volumes));

  assert.equal(v.divergence, "底背离");
});

test("单根样本：背离判定为空，量比退化为1", () => {
  const v = analyzeVolume([row("2026-01-01", 10, 100)]);
  assert.equal(v.ratio, 1); // 样本不足时 ma20 退化为该根量，量比=1
  assert.equal(v.divergence, null); // 背离需 >=20 根样本
  assert.equal(v.ma5, 100);
  assert.equal(v.ma20, 100);
  assert.equal(v.upDaysWithVolume, 0);
  assert.equal(v.downDaysWithVolume, 0);
});

test("零成交量时量比为 null", () => {
  const closes = Array.from({ length: FLAT }, () => 10);
  const volumes = Array.from({ length: FLAT }, () => 0);
  const v = analyzeVolume(build(closes, volumes));
  assert.equal(v.ratio, null);
  assert.equal(v.divergence, null);
});

test("上涨放量/下跌放量按近20日有效计数", () => {
  // 末20根：10 根收阳且放量(>均量)，10 根收阴且缩量
  const closes: number[] = [];
  const volumes: number[] = [];
  for (let i = 0; i < FLAT; i++) {
    if (i < FLAT - 20) {
      closes.push(10);
      volumes.push(100); // 前20根垫底，保证末20根均量≈均量
    } else {
      const up = (i - (FLAT - 20)) % 2 === 0;
      closes.push(up ? 11 : 9); // 阳线收高、阴线收低
      volumes.push(up ? 500 : 50); // 放量 / 缩量
    }
  }
  const v = analyzeVolume(build(closes, volumes));
  assert.equal(v.upDaysWithVolume, 10, `上涨放量天数应为10，实际 ${v.upDaysWithVolume}`);
  assert.equal(v.downDaysWithVolume, 0, `阴线均为缩量，下跌放量天数应为0，实际 ${v.downDaysWithVolume}`);
});
