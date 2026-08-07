/**
 * 上下文质量评分系统（P2）
 * 评估 AI 分析输入数据的完整性与新鲜度，
 * 帮助用户理解 AI 建议是否基于充分的数据。
 */

import type { AssistantContext } from "./ai/assistant";

export interface DimensionScore {
  label: string;
  score: number; // 0-100
  detail: string; // 简短描述
}

export interface ContextQuality {
  overall: number; // 0-100 加权总分
  dimensions: DimensionScore[];
  /** 各维度加权因子：[0]=行情, [1]=技术, [2]=基本面, [3]=量价, [4]=持仓, [5]=K线深度 */
  weights: number[];
}

const WEIGHTS = [0.25, 0.25, 0.2, 0.15, 0.10, 0.05]; // 各维度权重

/** 计算 AssistantContext 的上下文质量评分 */
export function evaluateContextQuality(ctx: AssistantContext): ContextQuality {
  const dims: DimensionScore[] = [
    scoreQuoteFreshness(ctx),
    scoreTechnicalCompleteness(ctx),
    scoreFundamentals(ctx),
    scoreVolumeData(ctx),
    scorePositionData(ctx),
    scoreKlineDepth(ctx),
  ];

  const weights = WEIGHTS;
  const totalWeight = dims.reduce((s, _, i) => s + (dimScore(i) > 0 ? weights[i] : 0), 0);
  const overall = totalWeight > 0
    ? Math.round(dims.reduce((s, d, i) => s + d.score * weights[i], 0) / totalWeight)
    : 0;

  return { overall, dimensions: dims, weights };

  function dimScore(idx: number) { return dims[idx].score; }
}

/** 1. 行情时效性：市场时间距今越短分越高 */
function scoreQuoteFreshness(ctx: AssistantContext): DimensionScore {
  const t = ctx.quote.marketTime;
  if (!t) {
    return { label: "行情时效", score: 0, detail: "无行情时间" };
  }
  const ageMin = (Date.now() - new Date(t).getTime()) / 60000;
  if (ageMin < 1) return { label: "行情时效", score: 100, detail: "<1分钟前" };
  if (ageMin < 5) return { label: "行情时效", score: 85, detail: `${Math.round(ageMin)}分钟前` };
  if (ageMin < 15) return { label: "行情时效", score: 60, detail: `${Math.round(ageMin)}分钟前` };
  if (ageMin < 60) return { label: "行情时效", score: 30, detail: `${Math.round(ageMin)}分钟前` };
  return { label: "行情时效", score: 0, detail: `${Math.round(ageMin / 60)}小时前` };
}

/** 2. 技术指标完整性：MACD/RSI/KDJ/MA20 是否齐全 */
function scoreTechnicalCompleteness(ctx: AssistantContext): DimensionScore {
  let present = 0;
  const osc = ctx.oscillators;
  if (osc?.macd !== null && osc?.macd !== undefined) present++;
  if (osc?.rsi !== null && osc?.rsi !== undefined) present++;
  if (osc?.kdj !== null && osc?.kdj !== undefined) present++;
  if (ctx.quote.ma20 && ctx.quote.ma20 > 0) present++;

  const total = 4;
  if (present === total) return { label: "技术指标", score: 100, detail: "4/4 齐全" };
  if (present >= 3) return { label: "技术指标", score: 75, detail: `${present}/4 可用` };
  if (present >= 2) return { label: "技术指标", score: 50, detail: `${present}/4 部分` };
  if (present >= 1) return { label: "技术指标", score: 25, detail: `${present}/4 稀少` };
  return { label: "技术指标", score: 0, detail: "0/4 缺失" };
}

/** 3. 基本面完整性：6个财务字段多少非空 */
function scoreFundamentals(ctx: AssistantContext): DimensionScore {
  const f = ctx.financials;
  const fields = [f.revenueGrowth, f.profitGrowth, f.debtRatio, f.pe, f.pb, f.roe];
  const present = fields.filter(v => v !== null && v !== undefined).length;
  const total = 6;

  if (present === total) return { label: "基本面", score: 100, detail: "6/6 齐全" };
  if (present >= 5) return { label: "基本面", score: 85, detail: `${present}/6 几乎齐全` };
  if (present >= 4) return { label: "基本面", score: 65, detail: `${present}/6 较完整` };
  if (present >= 3) return { label: "基本面", score: 45, detail: `${present}/6 半缺失` };
  if (present >= 1) return { label: "基本面", score: 20, detail: `${present}/6 大量缺失` };
  return { label: "基本面", score: 0, detail: "无财务数据" };
}

/** 4. 量价数据：volume 对象是否存在 */
function scoreVolumeData(ctx: AssistantContext): DimensionScore {
  if (!ctx.volume) return { label: "量价数据", score: 0, detail: "缺失" };
  let score = 80;
  if (ctx.volume.ratio !== null) score = 100;
  if (ctx.volume.divergence) score += 10; // 有背离判断加分
  return { label: "量价数据", score: Math.min(100, score), detail: "可用" };
}

/** 5. 持仓关联：是否注入了个股持仓数据 */
function scorePositionData(ctx: AssistantContext): DimensionScore {
  if (!ctx.stock.code || ctx.stock.code === "000000") {
    return { label: "持仓关联", score: 0, detail: "全局模式（无具体股票）" };
  }
  if (ctx.position) {
    return { label: "持仓关联", score: 100, detail: `持有${ctx.position.quantity}股` };
  }
  // 有股票但无持仓——对个性化分析有帮助，但无仓位数据
  return { label: "持仓关联", score: 50, detail: "未持有该股" };
}

/** 6. K线深度：通过支撑/阻力窗口推断可用K线数量 */
function scoreKlineDepth(ctx: AssistantContext): DimensionScore {
  // support=近20日最低，resistance=近60日最高；两者都有说明至少60根K线
  const hasSupport = ctx.quote.support > 0;
  const hasResistance = ctx.quote.resistance > 0;
  if (hasSupport && hasResistance) return { label: "K线深度", score: 100, detail: "≥60根" };
  if (hasSupport) return { label: "K线深度", score: 50, detail: "~20根" };
  return { label: "K线深度", score: 0, detail: "不足" };
}

/** 将质量评分格式化为短标签 */
export function qualityLabel(overall: number): { text: string; cls: string } {
  if (overall >= 90) return { text: "优", cls: "q-excellent" };
  if (overall >= 70) return { text: "良", cls: "q-good" };
  if (overall >= 50) return { text: "中", cls: "q-fair" };
  return { text: "差", cls: "q-poor" };
}
