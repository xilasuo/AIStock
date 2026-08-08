import type { AssistantContext } from "./assistant";

/**
 * 数字守卫：从 LLM 自由文本里提取数字，与 context 真实数值做白名单比对，
 * 抓出「掉小数点/丢首位/中文大写/凭空捏造」这类幻觉。
 *
 * 背景：validateStructured 只校验结构化 JSON 的数值字段，管不到 reasoning /
 * stopLossCondition / 对话正文这些自由文本，而实际事故（.335、.96元、
 * 叁佰肆拾肆元玖角陆分）恰恰都发生在自由文本里。
 */

/** 违规等级：hallucination=确定性错误应拦截；warning=可疑需提示 */
export type GuardLevel = "hallucination" | "warning";

export interface GuardIssue {
  level: GuardLevel;
  /** 机器可读类型，便于统计与测试断言 */
  code:
    | "chinese_numeral"
    | "leading_dot"
    | "dangling_unit"
    | "price_off_whitelist"
    | "percent_off_whitelist";
  message: string;
  /** 命中的原始片段 */
  snippet: string;
}

/** 中文大写数字字符（含金额单位），出现即违规 */
const CN_NUMERAL_RE = /[零壹贰叁肆伍陆柒捌玖拾佰仟萬万亿][零壹贰叁肆伍陆柒捌玖拾佰仟萬万亿元角分点百千]{1,}/g;

/**
 * 掉首位数字：紧跟 ¥/价/位/损/盈 等语境或独立出现的 ".96" "．335"
 * 匹配「非数字字符 + 小数点 + 数字」，例如 "现金只剩 .96 元"、"止损.335"
 */
const LEADING_DOT_RE = /(^|[^0-9A-Za-z.])[.．]\d{1,4}/g;

/** 悬空单位：数字后紧跟小数点再接单位，如 "16. 元" "5.元" "3. %" */
const DANGLING_UNIT_RE = /\d+[.．]\s*(?=[元%％股成])/g;

/** 正文里出现的价格型数字：¥12.34 / 12.34元 / 12.34 */
const PRICE_TOKEN_RE = /(?:¥|￥)?(\d+(?:\.\d+)?)\s*元?/g;

/** 正文里出现的百分比：12.34% */
const PERCENT_TOKEN_RE = /(-?\d+(?:\.\d+)?)\s*[%％]/g;

/** 浮点比较容差：允许 LLM 做合理四舍五入（两位小数） */
const EPS = 0.011;

function pushNum(set: Set<number>, v: number | null | undefined) {
  if (v === null || v === undefined || !Number.isFinite(v)) return;
  set.add(Number(v.toFixed(4)));
}

/**
 * 构建价格白名单：context 里所有真实价格 + 由它们派生的合理值。
 * 派生值包含常见的止损/止盈计算结果，避免把 LLM 的正当计算误判成幻觉。
 */
export function buildPriceWhitelist(ctx: AssistantContext): Set<number> {
  const set = new Set<number>();
  const q = ctx.quote;
  const bases = [q.price, q.ma20, q.support, q.resistance];
  for (const b of bases) pushNum(set, b);
  if (ctx.position) {
    pushNum(set, ctx.position.averageCost);
  }
  // 派生：现价/支撑/成本 的常见折算（止损位、止盈位）
  const ratios = [0.9, 0.92, 0.93, 0.95, 0.96, 0.97, 0.98, 1.02, 1.03, 1.05, 1.08, 1.1, 1.15, 1.2];
  for (const b of bases) {
    if (!Number.isFinite(b) || b <= 0) continue;
    for (const r of ratios) pushNum(set, b * r);
  }
  if (ctx.position && ctx.position.averageCost > 0) {
    for (const r of ratios) pushNum(set, ctx.position.averageCost * r);
  }
  return set;
}

/** 判断某个数字是否落在白名单（带容差，同时容忍 2 位小数四舍五入） */
function nearWhitelist(value: number, whitelist: Set<number>): boolean {
  for (const w of whitelist) {
    if (Math.abs(w - value) <= EPS) return true;
    // 容忍 LLM 把 5.345 写成 5.35 / 5.34
    if (Math.abs(Number(w.toFixed(2)) - value) <= EPS) return true;
    if (Math.abs(Number(w.toFixed(1)) - value) <= 0.051) return true;
  }
  return false;
}

/**
 * 核心：扫描一段 LLM 生成文本，返回所有数字类违规。
 *
 * @param text     LLM 输出的自由文本
 * @param ctx      真实上下文，用作白名单来源
 * @param options.strictPrice 是否开启价格白名单比对（对话链路建议 false 只做格式检查，
 *                            因为对话里合法出现的派生数字太多，误报率高）
 */
export function guardNumbers(
  text: string,
  ctx: AssistantContext,
  options: { strictPrice?: boolean } = {},
): GuardIssue[] {
  const issues: GuardIssue[] = [];
  if (!text) return issues;

  // ── 1. 中文大写数字 ──
  for (const m of text.matchAll(CN_NUMERAL_RE)) {
    issues.push({
      level: "hallucination",
      code: "chinese_numeral",
      message: `输出中出现中文大写数字「${m[0]}」，违反数字格式硬约束`,
      snippet: m[0],
    });
  }

  // ── 2. 掉首位数字（.96 / .335）──
  for (const m of text.matchAll(LEADING_DOT_RE)) {
    const snippet = m[0].trim();
    issues.push({
      level: "hallucination",
      code: "leading_dot",
      message: `输出中出现缺失整数位的数字「${snippet}」，疑似丢失首位数字`,
      snippet,
    });
  }

  // ── 3. 悬空单位（16. 元 / 5.元）──
  for (const m of text.matchAll(DANGLING_UNIT_RE)) {
    issues.push({
      level: "hallucination",
      code: "dangling_unit",
      message: `输出中出现小数点后无数字的写法「${m[0].trim()}」，疑似丢失小数位`,
      snippet: m[0].trim(),
    });
  }

  // ── 4. 百分比量级（爆炸值属格式类硬错误，与 strictPrice 无关，必须始终检查）──
  for (const m of text.matchAll(PERCENT_TOKEN_RE)) {
    const value = Number(m[1]);
    if (!Number.isFinite(value)) continue;
    if (Math.abs(value) > 1000) {
      issues.push({
        level: "hallucination",
        code: "percent_off_whitelist",
        message: `百分比「${m[0].trim()}」超出合理范围（±1000%），疑似量级错误`,
        snippet: m[0].trim(),
      });
    }
  }

  if (!options.strictPrice) return issues;

  // ── 5. 价格白名单比对（仅 strictPrice 模式，误报风险较高）──
  const whitelist = buildPriceWhitelist(ctx);
  if (whitelist.size > 0) {
    const seen = new Set<string>();
    for (const m of text.matchAll(PRICE_TOKEN_RE)) {
      const raw = m[1];
      if (!raw.includes(".")) continue; // 整数多为股数/天数，不做价格比对
      const value = Number(raw);
      if (!Number.isFinite(value) || value <= 0) continue;
      // 百分比场景由下面单独处理，这里跳过后接 % 的
      const after = text.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 1);
      if (after === "%" || after === "％") continue;
      if (seen.has(raw)) continue;
      seen.add(raw);
      if (!nearWhitelist(value, whitelist)) {
        issues.push({
          level: "warning",
          code: "price_off_whitelist",
          message: `价格「${raw}」不在 context 真实数值及其常见折算范围内，请核对是否自造`,
          snippet: raw,
        });
      }
    }
  }

  return issues;
}

/** 是否存在必须拦截的确定性错误 */
export function hasBlockingIssue(issues: GuardIssue[]): boolean {
  return issues.some((i) => i.level === "hallucination");
}

/** 把 issues 渲染成与 validateStructured 一致的 [幻觉]/[注意] 前缀警告文案 */
export function issuesToWarnings(issues: GuardIssue[]): string[] {
  return issues.map((i) => `${i.level === "hallucination" ? "[幻觉]" : "[注意]"} ${i.message}`);
}
