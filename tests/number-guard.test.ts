import { test } from "node:test";
import assert from "node:assert/strict";
import {
  guardNumbers,
  hasBlockingIssue,
  issuesToWarnings,
  buildPriceWhitelist,
} from "../lib/ai/number-guard";
import type { AssistantContext } from "../lib/ai/assistant";

/** 卓翼科技（002369）事故现场的真实上下文 */
const zhuoyiCtx: AssistantContext = {
  symbol: "002369",
  name: "卓翼科技",
  quote: {
    price: 5.7,
    changePercent: 1.24,
    ma20: 5.34,
    support: 5.35,
    resistance: 6.35,
  },
  position: {
    quantity: 1000,
    averageCost: 5.6,
    returnPercent: 1.79,
    stockPositionPercent: 12.3,
  },
} as AssistantContext;

test("拦截中文大写数字（叁佰肆拾肆元玖角陆分）", () => {
  const text = "当前浮盈叁佰肆拾肆元玖角陆分，收益率贰拾点壹零百分比。";
  const issues = guardNumbers(text, zhuoyiCtx);
  assert.ok(hasBlockingIssue(issues), "中文大写必须命中拦截");
  assert.ok(issues.some((i) => i.code === "chinese_numeral"));
});

test("拦截掉首位数字（.335 / .96 / .60）", () => {
  const text = "止损设在 .335 元，若跌破 .60 则清仓，现金剩 .96 元。";
  const issues = guardNumbers(text, zhuoyiCtx);
  assert.ok(hasBlockingIssue(issues));
  const dots = issues.filter((i) => i.code === "leading_dot");
  assert.equal(dots.length, 3, `应捕获 3 处掉首位，实际 ${dots.length}`);
});

test("拦截悬空单位（16. 元 / 5.元）", () => {
  const text = "阻力位 16. 元，成本 5.元。";
  const issues = guardNumbers(text, zhuoyiCtx);
  assert.ok(hasBlockingIssue(issues));
  assert.ok(issues.some((i) => i.code === "dangling_unit"));
});

test("拦截爆炸百分比（2010%）", () => {
  const text = "你单股仓位已 2010%，建议立即减仓。";
  const issues = guardNumbers(text, zhuoyiCtx);
  assert.ok(hasBlockingIssue(issues));
  assert.ok(issues.some((i) => i.code === "percent_off_whitelist"));
});

test("正常回复不误报（真实数值 + 合理折算 + 常规百分比）", () => {
  const text =
    "现价 5.70 元，MA20 为 5.34 元，支撑 5.35 元在现价下方约 6.1%，阻力 6.35 元。" +
    "建议止损 5.13 元（现价×0.9），止盈 6.27 元。当前浮盈 1.79%，仓位 12.3%。";
  const issues = guardNumbers(text, zhuoyiCtx, { strictPrice: true });
  assert.equal(
    hasBlockingIssue(issues),
    false,
    `正常文本不应触发拦截：${JSON.stringify(issuesToWarnings(issues))}`,
  );
});

test("strictPrice 开启时能发现凭空捏造的价格", () => {
  const text = "支撑位在 8.06 元。";
  const issues = guardNumbers(text, zhuoyiCtx, { strictPrice: true });
  assert.ok(
    issues.some((i) => i.code === "price_off_whitelist" && i.snippet === "8.06"),
    "8.06 不在白名单，应告警",
  );
});

test("strictPrice 关闭时不做价格白名单比对", () => {
  const text = "支撑位在 8.06 元。";
  const issues = guardNumbers(text, zhuoyiCtx, { strictPrice: false });
  assert.equal(issues.some((i) => i.code === "price_off_whitelist"), false);
});

test("白名单包含 context 真实值及常见折算", () => {
  const wl = buildPriceWhitelist(zhuoyiCtx);
  assert.ok(wl.has(5.7), "应含现价");
  assert.ok(wl.has(5.34), "应含 MA20");
  assert.ok(wl.has(6.35), "应含阻力");
  assert.ok(wl.has(5.6), "应含成本价");
});

test("issuesToWarnings 输出 [幻觉]/[注意] 前缀", () => {
  const issues = guardNumbers("止损 .335 元，支撑 8.06 元。", zhuoyiCtx, { strictPrice: true });
  const warnings = issuesToWarnings(issues);
  assert.ok(warnings.some((w) => w.startsWith("[幻觉]")));
  assert.ok(warnings.some((w) => w.startsWith("[注意]")));
});

test("空文本与无上下文不崩溃", () => {
  assert.deepEqual(guardNumbers("", zhuoyiCtx), []);
  const emptyCtx = { symbol: "000001", name: "x", quote: { price: 0 } } as AssistantContext;
  assert.doesNotThrow(() => guardNumbers("随便写点 1.23 元", emptyCtx, { strictPrice: true }));
});
