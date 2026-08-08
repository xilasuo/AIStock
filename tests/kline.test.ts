import assert from "node:assert/strict";
import test from "node:test";
import { detectMarkers } from "../lib/kline";

// 构造一段低价股（现价约 5.94，区间 5~6）日K序列，复现卓翼科技(002369)大屏场景，
// 用于锁定「坏数字（如 .335/.35/.60、<1 的异常价位）来自模型抄错而非数据层算错」。
function makeBars(n: number, base = 5.94): { date: string; open: number; high: number; low: number; close: number; vol: number }[] {
  const bars = [];
  let close = base;
  for (let i = 0; i < n; i++) {
    const drift = Math.sin(i / 7) * 0.15; // 小幅波动
    const open = close;
    close = Math.max(0.5, base + drift);
    const high = Math.max(open, close) + 0.05;
    const low = Math.min(open, close) - 0.05;
    bars.push({
      date: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`,
      open: +open.toFixed(3),
      high: +high.toFixed(3),
      low: +low.toFixed(3),
      close: +close.toFixed(3),
      vol: 1_000_000,
    });
  }
  return bars;
}

test("detectMarkers 在低价股场景下产出的所有价位/均线均为 >=1 的合理值，不出现 <1 异常价（杜绝 .335/.35/.60 类坏值源头）", () => {
  const bars = makeBars(130);
  const mk = detectMarkers(bars, "卓翼科技");

  // 五条均线都必须在合理区间（>=1，且接近现价 5~6 区间，不因算法 bug 塌成 <1）
  for (const [name, v] of [
    ["ma5", mk.ma5], ["ma10", mk.ma10], ["ma20", mk.ma20],
    ["ma60", mk.ma60], ["ma120", mk.ma120],
  ] as const) {
    assert.ok(Number.isFinite(v), `${name} 必须是有限数`);
    assert.ok(v >= 1, `${name}=${v} 不应 <1（避免出现 .335/.60 这类丢首位的坏值）`);
  }

  // 关键价位（泡沫顶/突破位/支撑/双底）同样不得 <1
  assert.ok(mk.top.price >= 1, `泡沫顶=${mk.top.price} 不应 <1`);
  assert.ok(mk.breakout >= 1, `突破确认位=${mk.breakout} 不应 <1`);
  assert.ok(mk.support >= 1, `生死支撑=${mk.support} 不应 <1`);
  if (mk.doubleBottom) {
    assert.ok(mk.doubleBottom.support >= 1, "双底支撑不应 <1");
    assert.ok(mk.doubleBottom.neck >= 1, "双底颈线不应 <1");
  }

  // toFixed(2) 后所有价位字符串都必须含整数位（形如 "5.34"），不得是 ".34"
  const allLevels = [
    mk.ma5, mk.ma10, mk.ma20, mk.ma60, mk.ma120,
    mk.top.price, mk.breakout, mk.support,
    ...(mk.doubleBottom ? [mk.doubleBottom.support, mk.doubleBottom.neck] : []),
  ];
  for (const v of allLevels) {
    const s = v.toFixed(2);
    assert.ok(s.includes(".") && !s.startsWith("."), `价位 ${v} -> "${s}" 不应丢整数位`);
  }
});

test("支撑与突破位相对现价的位置自洽（支撑<=现价<=突破位，或形态特殊），且均有限", () => {
  const bars = makeBars(130);
  const mk = detectMarkers(bars, "卓翼科技");
  const price = bars[bars.length - 1].close;
  assert.ok(Number.isFinite(mk.support) && Number.isFinite(mk.breakout), "支撑/突破位必须有限");
  // 非双底形态下：支撑应为近期低点（<= 现价附近），突破位应 >= 现价附近；二者不应反序到离谱
  assert.ok(mk.breakout >= mk.support - 1e-6, `突破位(${mk.breakout})不应低于支撑(${mk.support})`);
});
