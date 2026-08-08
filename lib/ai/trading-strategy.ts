import { getAiConfig } from "./ai-config";
import { DEFAULT_PREFERENCES, type TradingPreferences } from "../utils/preferences";
import { tradeModePrompt } from "../utils/trade-mode";
import type { AssistantContext } from "./assistant";
import type { Oscillators } from "../domain/stocks";
import { evaluateContextQuality, type ContextQuality } from "../context-quality";
import { guardNumbers, hasBlockingIssue, issuesToWarnings } from "./number-guard";

type StrategyAction = "开新仓" | "加仓" | "持有" | "减仓" | "清仓" | "观望" | null;

export interface StrategyResult {
  content: string;
  mode: string;
  /** 规则引擎给出的确定性结论 */
  ruleAction: StrategyAction;
  /** AI 响应中提取的结论（AI 未跑时为 null） */
  aiAction: StrategyAction;
  /** true=AI与规则不一致, false=一致, null=无可比（仅规则引擎） */
  diff: boolean | null;
  /** AI 结构化输出（仅当 JSON 解析成功时非 null） */
  structured?: StructuredStrategy | null;
  /** 结构化输出校验警告 */
  validationWarnings?: string[];
  /** 上下文数据质量评分 */
  contextQuality?: ContextQuality;
  /**
   * true = AI 输出命中确定性错误（[幻觉] 级），content 已被替换为规则引擎结果。
   * 此时 structured/aiAction 仍保留原值，供前端展示「AI 建议已被拦截及原因」。
   */
  blocked?: boolean;
}

/** AI 结构化策略输出 schema */
export interface StructuredStrategy {
  action: StrategyAction;
  actionSummary: string;
  stopLossPrice: number | null;
  stopLossCondition: string;
  takeProfitPrice: number | null;
  takeProfitCondition: string;
  addAllowed: boolean;
  addTriggerPrice: number | null;
  addMaxShares: number | null;
  addCondition: string;
  reduceCondition: string;
  suggestedShares: number | null;
  suggestedCheng: number | null;
  reasoning: string;
  risks: string;
  dataGaps: string;
}

/** 把结构化策略渲染成 markdown 块（带"结论/依据/止盈/止损/..."标签），供前端 StrategyBlocks 分块展示 */
export function renderStructuredToText(s: StructuredStrategy): string {
  const lines: string[] = [];
  const actionLabelMap: Record<NonNullable<StrategyAction>, string> = {
    "开新仓": "开新仓",
    "加仓": "加仓",
    "持有": "持有",
    "减仓": "减仓",
    "清仓": "清仓",
    "观望": "观望",
  };
  const actionText = s.action ? actionLabelMap[s.action] : "未给";
  lines.push(`结论：${actionText}。${s.actionSummary || ""}`);

  // 依据：综合 reasoning + 价格 + 仓位（仅在有具体数字时附上，便于回看）
  const reasoning = s.reasoning?.trim();
  if (reasoning) lines.push(`依据：${reasoning}`);

  // 止盈
  const tpLines: string[] = [];
  if (s.takeProfitPrice !== null) tpLines.push(`止盈价 ¥${s.takeProfitPrice.toFixed(2)}`);
  if (s.takeProfitCondition) tpLines.push(s.takeProfitCondition);
  if (tpLines.length) lines.push(`止盈：${tpLines.join("；")}`);

  // 止损
  const slLines: string[] = [];
  if (s.stopLossPrice !== null) slLines.push(`止损价 ¥${s.stopLossPrice.toFixed(2)}`);
  if (s.stopLossCondition) slLines.push(s.stopLossCondition);
  if (slLines.length) lines.push(`止损：${slLines.join("；")}`);

  // 加仓
  const addLines: string[] = [];
  if (s.addAllowed) {
    if (s.addTriggerPrice !== null) addLines.push(`触发价 ¥${s.addTriggerPrice.toFixed(2)}`);
    if (s.addMaxShares !== null) addLines.push(`上限 ${s.addMaxShares} 股`);
    if (s.addCondition) addLines.push(s.addCondition);
  } else if (s.addCondition) {
    addLines.push(`不允许加仓：${s.addCondition}`);
  }
  if (addLines.length) lines.push(`加仓：${addLines.join("；")}`);

  // 减仓/清仓
  if (s.reduceCondition) lines.push(`减仓：${s.reduceCondition}`);

  // 仓位计算（仅当给出了股数/成数）
  if (s.suggestedShares !== null || s.suggestedCheng !== null) {
    const parts: string[] = [];
    if (s.suggestedShares !== null) parts.push(`${s.suggestedShares} 股`);
    if (s.suggestedCheng !== null) parts.push(`${(s.suggestedCheng * 100).toFixed(1)} 成`);
    lines.push(`仓位计算：${parts.join("，")}`);
  }

  // 风险与缺口
  const riskParts: string[] = [];
  if (s.risks?.trim()) riskParts.push(s.risks.trim());
  if (s.dataGaps?.trim()) riskParts.push(`数据缺口：${s.dataGaps.trim()}`);
  if (riskParts.length) lines.push(`风险与缺口：${riskParts.join("；")}`);

  return lines.join("\n");
}

type DeepSeekResponse = {
  choices?: Array<{ message?: { content?: string } }>;
};

function percent(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return "数据缺失";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

function oscillatorTip(ctx: AssistantContext): string {
  const osc: Oscillators | undefined | null = ctx.oscillators;
  if (!osc) return "";
  const parts: string[] = [];
  if (osc.macd?.hist !== undefined) {
    const hist = osc.macd.hist;
    if (hist > 0.02) parts.push("MACD红柱放大（动能偏强）");
    else if (hist < -0.02) parts.push("MACD绿柱放大（动能偏弱）");
    else parts.push("MACD柱体走平（动能中性）");
  }
  if (osc.kdj?.k != null && osc.kdj.d != null) {
    if (osc.kdj.k > 80) parts.push("KDJ处于超买区");
    else if (osc.kdj.k < 20) parts.push("KDJ处于超卖区");
    else parts.push(`KDJ中性(K=${osc.kdj.k.toFixed(0)})`);
  }
  if (osc.rsi?.rsi12 != null) {
    if (osc.rsi.rsi12 > 70) parts.push("RSI超买");
    else if (osc.rsi.rsi12 < 30) parts.push("RSI超卖");
    else parts.push(`RSI中性(${osc.rsi.rsi12.toFixed(0)})`);
  }
  return parts.join("；");
}

/** 从 AI 返回的文本中提取操盘动作结论 */
function extractAiAction(text: string): StrategyAction {
  if (!text) return null;
  // 优先在"结论"或"操作"行前后查找，其次全文前 400 字
  const conclusionMatch = text.match(/(?:结论|操作|动作)[：:]\s*(.+?)(?:\n|。|，)/);
  const search = conclusionMatch ? conclusionMatch[1] : text.slice(0, 400);
  const actions: { kw: string; action: StrategyAction }[] = [
    { kw: "开新仓", action: "开新仓" },
    { kw: "清仓", action: "清仓" },
    { kw: "减仓", action: "减仓" },
    { kw: "加仓", action: "加仓" },
    { kw: "持有", action: "持有" },
    { kw: "观望", action: "观望" },
  ];
  for (const { kw, action } of actions) {
    if (search.includes(kw)) return action;
  }
  return null;
}

/* ================================================================
 * 结构化输出：JSON schema + 解析 + 校验
 * ================================================================ */

const STRUCTURED_OUTPUT_INSTRUCTION = [
  "",
  "【输出格式硬约束 — 必须且只能返回一个 JSON 对象】",
  "不要外层包裹、不要 markdown 代码块标记、不要 ```json 后缀，直接输出纯 JSON：",
  '{"action":"开新仓|加仓|持有|减仓|清仓|观望",',
  '"actionSummary":"一句话动作总结",',
  '"stopLossPrice":12.50,  // number | null，止损具体价位',
  '"stopLossCondition":"跌破12.50立即止损",',
  '"takeProfitPrice":15.00,  // number | null，止盈具体价位',
  '"takeProfitCondition":"涨至15.00附近分批止盈",',
  '"addAllowed":true,  // boolean，是否允许加仓',
  '"addTriggerPrice":13.20,  // number | null，加仓触发价',
  '"addMaxShares":500,  // number | null，加仓最大股数',
  '"addCondition":"回踩13.20不破小仓加",',
  '"reduceCondition":"占仓超30%或跌破支撑时减仓",',
  '"suggestedShares":null,  // number | null，建议股数（开新仓时给出）',
  '"suggestedCheng":null,  // number | null，建议成数（0-1之间的小数，如0.3=三成仓，开新仓时给出）',
  '"reasoning":"简短理由，不超过120字",',
  '"risks":"主要风险，分号分隔",',
  '"dataGaps":"数据缺失项，分号分隔；无缺失则填空字符串"}',
  "价格字段若不确定或无法给出则填 null，boolean 字段必填，string 字段必填可为空字符串。整体不超 600 字。",
].join("\n");

/** 将未知类型安全转为 number | null */
function toNumOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 将未知类型安全转为 number | null（整数） */
function toIntOrNull(v: unknown): number | null {
  const n = toNumOrNull(v);
  if (n === null || !Number.isInteger(n) || n < 0) return null;
  return n;
}

/** 将字符串安全映射到 StrategyAction */
function normalizeAction(v: unknown): StrategyAction {
  const s = String(v ?? "").trim();
  const valid: StrategyAction[] = ["开新仓", "加仓", "持有", "减仓", "清仓", "观望"];
  return valid.includes(s as StrategyAction) ? (s as StrategyAction) : null;
}

/** 尝试从 AI 文本中解析 JSON 结构化输出 */
function parseStructuredOutput(text: string): StructuredStrategy | null {
  if (!text) return null;

  // 策略1: 整段即 JSON
  try {
    const obj = JSON.parse(text);
    if (typeof obj === "object" && obj !== null && "action" in obj) return normalizeStructured(obj);
  } catch { /* fall through */ }

  // 策略2: markdown ```json ... ``` 代码块内提取
  const mdMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (mdMatch) {
    try {
      const obj = JSON.parse(mdMatch[1]);
      if (typeof obj === "object" && obj !== null && "action" in obj) return normalizeStructured(obj);
    } catch { /* fall through */ }
  }

  // 策略3: 文本中寻找第一个 { ... } 对象
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]);
      if (typeof obj === "object" && obj !== null && "action" in obj) return normalizeStructured(obj);
    } catch { /* fall through */ }
  }

  return null;
}

function normalizeStructured(raw: Record<string, unknown>): StructuredStrategy {
  return {
    action: normalizeAction(raw.action),
    actionSummary: String(raw.actionSummary ?? ""),
    stopLossPrice: toNumOrNull(raw.stopLossPrice),
    stopLossCondition: String(raw.stopLossCondition ?? ""),
    takeProfitPrice: toNumOrNull(raw.takeProfitPrice),
    takeProfitCondition: String(raw.takeProfitCondition ?? ""),
    addAllowed: Boolean(raw.addAllowed),
    addTriggerPrice: toNumOrNull(raw.addTriggerPrice),
    addMaxShares: toIntOrNull(raw.addMaxShares),
    addCondition: String(raw.addCondition ?? ""),
    reduceCondition: String(raw.reduceCondition ?? ""),
    suggestedShares: toIntOrNull(raw.suggestedShares),
    suggestedCheng: toNumOrNull(raw.suggestedCheng),
    reasoning: String(raw.reasoning ?? ""),
    risks: String(raw.risks ?? ""),
    dataGaps: String(raw.dataGaps ?? ""),
  };
}

/** 校验结构化输出中的数字是否合理（对照 context 真实数据） */
function validateStructured(
  output: StructuredStrategy,
  context: AssistantContext,
  prefs: TradingPreferences,
): string[] {
  const warnings: string[] = [];
  const q = context.quote;
  const pos = context.position;
  const pf = context.portfolio;
  const totalAssets = pf.totalAssets ?? 0;
  const cash = pf.cash ?? 0;

  // ── 1. 止损价校验 ──
  if (output.stopLossPrice !== null && q.price > 0) {
    // 做多场景下止损价应为现价下方；若止损 ≥ 现价 * 1.02（轻微容忍），标记为幻觉
    if (output.stopLossPrice >= q.price * 1.02) {
      warnings.push(`[幻觉] AI止损价${output.stopLossPrice.toFixed(2)}≥现价${q.price.toFixed(2)}，止损应在现价下方`);
    } else if (output.stopLossPrice >= q.price) {
      warnings.push(`[注意] AI止损价${output.stopLossPrice.toFixed(2)}未低于现价${q.price.toFixed(2)}，止损价疑点`);
    } else if (output.stopLossPrice <= q.price * 0.5) {
      warnings.push(`[注意] AI止损价${output.stopLossPrice.toFixed(2)}远低于现价${q.price.toFixed(2)}，可能过于宽松`);
    }
    // 止损价 vs 支撑位：若止损远低于支撑位（支撑*0.85），说明 AI 可能不知道真正的支撑
    if (q.support > 0 && output.stopLossPrice < q.support * 0.85) {
      warnings.push(`[注意] AI止损价${output.stopLossPrice.toFixed(2)}远低于数据支撑位${q.support.toFixed(2)}，疑与真实数据脱节`);
    }
  }

  // ── 2. 止盈价校验 ──
  if (output.takeProfitPrice !== null && q.price > 0) {
    if (output.takeProfitPrice <= q.price) {
      warnings.push(`[幻觉] AI止盈价${output.takeProfitPrice.toFixed(2)}≤现价${q.price.toFixed(2)}，止盈应在现价上方`);
    }
    // 止盈价 vs 阻力位：若止盈远高于阻力(阻力*1.3)，AI 可能不懂阻力概念
    if (q.resistance > 0 && output.takeProfitPrice > q.resistance * 1.3) {
      warnings.push(`[注意] AI止盈价${output.takeProfitPrice.toFixed(2)}远超阻力位${q.resistance.toFixed(2)}，疑与数据脱节`);
    }
  }

  // ── 3. 价格层级一致性：止损 < 加仓触发 < 现价 < 止盈 ──
  const sl = output.stopLossPrice;
  const add = output.addTriggerPrice;
  const tp = output.takeProfitPrice;
  if (sl !== null && add !== null && sl >= add) {
    warnings.push(`[幻觉] 止损价${sl.toFixed(2)}≥加仓触发价${add.toFixed(2)}，价格层级混乱`);
  }
  if (add !== null && tp !== null && add >= tp) {
    warnings.push(`[幻觉] 加仓触发价${add.toFixed(2)}≥止盈价${tp.toFixed(2)}，加仓价应在止盈价下方`);
  }
  if (sl !== null && tp !== null && sl >= tp) {
    warnings.push(`[幻觉] 止损价${sl.toFixed(2)}≥止盈价${tp.toFixed(2)}，止损应在止盈下方`);
  }

  // ── 4. 加仓触发价合理区间 ──
  if (add !== null && q.price > 0) {
    // 加仓触发价一般不应高于当前价的 5%（加仓应在回调或突破回踩时）
    if (add > q.price * 1.05) {
      warnings.push(`[注意] AI加仓触发价${add.toFixed(2)}高于现价${q.price.toFixed(2)}约${((add/q.price-1)*100).toFixed(0)}%，过高加仓信号不理性`);
    }
  }

  // ── 5. 建议股数合理性 ──
  if (output.suggestedShares !== null) {
    if (!Number.isInteger(output.suggestedShares) || output.suggestedShares <= 0) {
      warnings.push(`[幻觉] AI建议股数${output.suggestedShares}，应为正整数`);
    } else if (output.suggestedShares % 100 !== 0) {
      warnings.push(`[注意] AI建议股数${output.suggestedShares}不是100的整数倍（A股一手=100股）`);
    }
  }
  if (output.addMaxShares !== null) {
    if (!Number.isInteger(output.addMaxShares) || output.addMaxShares <= 0) {
      warnings.push(`[幻觉] AI加仓上限${output.addMaxShares}，应为正整数`);
    } else if (output.addMaxShares % 100 !== 0) {
      warnings.push(`[注意] AI加仓上限${output.addMaxShares}不是100的整数倍`);
    }
  }

  // ── 6. 仓位成数合理性 ──
  if (output.suggestedCheng !== null) {
    if (output.suggestedCheng <= 0 || output.suggestedCheng > 1) {
      warnings.push(`[幻觉] AI建议成数${output.suggestedCheng}不在(0,1]内，应为小数如0.3=三成`);
    } else {
      const chengPct = output.suggestedCheng * 100;
      if (chengPct > prefs.maxConcentrationPercent) {
        warnings.push(`[注意] AI建议仓位${chengPct.toFixed(0)}%超出用户集中度上限${prefs.maxConcentrationPercent}%`);
      }
      if (chengPct > prefs.maxPositionPercent) {
        warnings.push(`[注意] AI建议仓位${chengPct.toFixed(0)}%超出用户总仓位上限${prefs.maxPositionPercent}%`);
      }
    }
  }

  // ── 7. 股数 × 价格 与 成数 交叉验证 ──
  if (
    output.suggestedShares !== null && output.suggestedShares > 0 &&
    output.suggestedCheng !== null && output.suggestedCheng > 0 &&
    totalAssets > 0 && q.price > 0
  ) {
    const moneyFromShares = output.suggestedShares * q.price;
    const moneyFromCheng = output.suggestedCheng * totalAssets;
    // 容许 30% 误差（整数取整/100股取整等）
    const ratio = moneyFromShares / moneyFromCheng;
    if (ratio < 0.7 || ratio > 1.3) {
      warnings.push(
        `[幻觉] 股数×价(${(moneyFromShares/10000).toFixed(1)}万)与仓位×总资产(${(moneyFromCheng/10000).toFixed(1)}万)差${((Math.abs(ratio-1))*100).toFixed(0)}%，数字自相矛盾`,
      );
    }
  }

  // ── 8. 资金买得起吗：股数×价 vs 现金 ──
  if (output.suggestedShares !== null && output.suggestedShares > 0 && cash > 0 && q.price > 0) {
    const needed = output.suggestedShares * q.price;
    if (needed > cash) {
      const shortage = ((needed - cash) / 10000).toFixed(1);
      warnings.push(`[幻觉] AI建议买${output.suggestedShares}股需¥${(needed/10000).toFixed(1)}万，但现金仅¥${(cash/10000).toFixed(1)}万，缺口¥${shortage}万`);
    }
  }
  if (output.addMaxShares !== null && output.addMaxShares > 0 && cash > 0 && q.price > 0) {
    const needed = output.addMaxShares * q.price;
    if (needed > cash * 0.5) {
      warnings.push(`[注意] AI加仓上限${output.addMaxShares}股需¥${(needed/10000).toFixed(1)}万，占总现金${((needed/cash)*100).toFixed(0)}%，风险较高`);
    }
  }

  // ── 9. 动作一致性校验 ──
  if (output.action === "开新仓" && pos) {
    warnings.push(`[注意] AI输出'开新仓'但用户已持有该股，应为加仓/持有/减仓`);
  }
  if (
    output.action !== null &&
    ["加仓", "持有", "减仓", "清仓"].includes(output.action) &&
    !pos
  ) {
    const totalPos = pf.totalPositionPercent ?? null;
    const note = totalPos !== null && totalPos >= 60
      ? `（系统显示你总仓位${totalPos.toFixed(1)}%，但这些仓位属于其他股票，该股无持仓）`
      : "";
    warnings.push(`[注意] AI输出'${output.action}'，但你当前并未持有该股${note}；未持仓时应给「开新仓」或「观望」，禁止用持有/加仓/减仓/清仓`);
  }

  return warnings;
}

/* ================================================================ */

function summarizeContext(ctx: AssistantContext): string {
  const lines: string[] = [];
  lines.push(`股票：${ctx.stock.name}（${ctx.stock.code}）${ctx.stock.industry ? `，行业：${ctx.stock.industry}` : ""}`);
  if (ctx.stock.instrumentType === "etf") lines.push("品种：ETF/指数基金（不提供个股买卖建议，策略侧重定投与节奏）");
  const q = ctx.quote;
  lines.push(`现价：${q.price.toFixed(3)}元，涨跌幅：${q.changePercent.toFixed(2)}%；20日均线：${q.ma20.toFixed(3)}元`);
  lines.push(`走势结构：现价相对20日均线${q.price >= q.ma20 ? "之上（短线偏强）" : "之下（短线偏弱）"}；支撑位：${q.support.toFixed(3)}元，阻力位：${q.resistance.toFixed(3)}元，价格距阻力${q.resistance > 0 ? ((q.resistance - q.price) / q.price * 100).toFixed(1) + "%" : "缺失"}，近期波动（年化）：约${q.volatility.toFixed(1)}%`);
  const f = ctx.financials;
  const financialsMissing = f.revenueGrowth == null && f.profitGrowth == null && f.debtRatio == null && f.pe == null && f.pb == null && f.roe == null;
  lines.push(`基本面：营收增长=${f.revenueGrowth ?? "数据缺失"}；利润增长=${f.profitGrowth ?? "数据缺失"}；负债率=${f.debtRatio ?? "数据缺失"}；PE=${f.pe ?? "数据缺失"}；PB=${f.pb ?? "数据缺失"}；ROE=${f.roe ?? "数据缺失"}${financialsMissing ? "（基本面几乎全部缺失，本次判断以技术面为主）" : ""}`);
  if (ctx.summary) lines.push(`一句话总结：${ctx.summary}`);
  lines.push(`风险点：${(ctx.risks || []).length ? ctx.risks.join("；") : "无明确列示"}`);
  lines.push(`还需核验：${(ctx.missingInformation || []).length ? ctx.missingInformation.join("；") : "无"}`);
  // 量能：输出量比(ratio，当日量/近5日均量通用口径)与量价背离，供模型判断量能，
  // 不再用"成交量(近20日)"这种易误导的标签。
  if (ctx.volume) {
    const v = ctx.volume;
    const ratioText = v.ratio != null ? v.ratio.toFixed(2) : "数据缺失";
    const ma5Text = v.ma5 > 0 ? v.ma5.toLocaleString("zh-CN") : "数据缺失";
    lines.push(`量能：量比=${ratioText}（当日量/近5日均量）；近5日均量=${ma5Text}股；量价背离=${v.divergence ?? "无明显背离"}`);
  } else {
    lines.push(`量能：数据缺失`);
  }
  const osc = oscillatorTip(ctx);
  if (osc) lines.push(`摆动指标：${osc}`);
  if (ctx.position && ctx.portfolio.totalAssets !== null) {
    const p = ctx.position;
    const posValue = p.quantity * q.price;
    const total = ctx.portfolio.totalAssets;
    // 单股占比优先用已做基准失真保护的 p.stockPositionPercent；若失真（null）则重算并夹取到合理范围，
    // 避免出现 2010% 这类爆炸值污染 prompt。
    const rawPct = total > 0 ? (posValue / total) * 100 : 0;
    const pct = p.stockPositionPercent != null
      ? p.stockPositionPercent
      : (Number.isFinite(rawPct) && rawPct > 0 && rawPct <= 100 ? rawPct : 0);
    const pctText = p.stockPositionPercent != null
      ? `${pct.toFixed(2)}%${p.stockPositionPercentNote ? `（${p.stockPositionPercentNote}）` : ""}`
      : (pct > 0 ? `${pct.toFixed(2)}%` : "基准失真，无法计算（请检查账户初始资金/出入金设置）");
    lines.push(`我的持仓：数量=${p.quantity}股，成本=${p.averageCost.toFixed(3)}元，盈亏=${percent(p.returnPercent)}，占总资产=${pctText}`);
  } else if (ctx.portfolio.totalAssets !== null) {
    lines.push(`我的账户：总资产=${ctx.portfolio.totalAssets.toFixed(2)}元，现金=${ctx.portfolio.cash?.toFixed(2) ?? "暂无"}，总仓位=${ctx.portfolio.totalPositionPercent?.toFixed(2) ?? "暂无"}%`);
  } else {
    lines.push("我的账户：尚未设置初始资金，无法计算现金和总仓位");
  }
  if (ctx.source?.fetchedAt) lines.push(`数据时间：${ctx.source.fetchedAt}`);
  return lines.join("\n");
}

function buildTraderSystemPrompt(prefs: TradingPreferences, context: AssistantContext, structured = false): string {
  const base = [
    `你是严厉且资深的操盘手，只看数据、不拍脑袋。风格：直接、强硬、反幻觉；句句落到买卖动作上——开新仓/加仓/持有/减仓/止损/清仓，并给出明确价格与股数/金额，不许用「可以考虑」「或许」这类软话。能算就给数字，不能算就明说缺什么；违背纪律的倾向要直接点破。不承诺收益、不替用户下单，最终由用户确认执行。`,
    `【回答风格硬约束】干净利索、不绕弯、不罗嗦：结论先行、动作直给；不铺垫寒暄客套、不重复免责声明、不堆砌形容词；能用短句绝不用长句。整体不超 400 字（第 8 条仓位计算展示除外），到点即止。`,
    `【持仓股决策硬约束】只要用户持有该股，必须把四件事讲死讲明、不许含糊：①止盈——价格到哪个价位/满足什么条件就卖（给具体价或明确条件）；②止损——跌破哪个价位必须砍（即下方止损位，给具体价，不犹豫）；③加仓(买入)——满足什么条件才加、给触发价与上限；④减仓/卖出——什么情况减、什么情况清。能买/能加就明说「买/加」，不能就明说「不买/不加、继续持有或减」，绝不用「可以考虑」「视情况」糊弄；最终结论只能是买/加仓/持有/减仓/清仓中的一个明确动作，不许两头下注。`,
    `1. 只根据 context 里的信息做判断，绝不凭记忆补数、不编造行情或财务数字（PE/ROE/支撑阻力等缺失就写「数据缺失」）。`,
    `2. 支撑位与阻力位来自 context 的支撑/阻力；没有历史价或数值异常时直接说明「无法判断支撑/阻力」，不臆造。`,
    `3. 持仓状态判定以 context.position 为准，严禁用总仓位推断个股持仓：context.position 为 null 即表示未持有该股，绝对禁止输出「持有/加仓/减仓/清仓」；结论只能是「开新仓」或「暂不开新仓（观望）」。总仓位高不等于买了这一只，现金不足时只给「观望」禁止给「开新仓」。有持仓才谈持有/加仓/减仓/清仓，且必须从成本/盈亏/占仓出发。`,
    `4. 任何买入/加仓结论必须先给止损位（跌破即执行），并说明为什么这个位置能控风险；绝不允许「先买再看」。`,
    `5. 成交量只作为信号（放量突破/缩量回调），不得单独据此下单；不得预测具体点位或保证收益。`,
    `6. 若 context 显示账户未设置初始资金，明确说「无法计算仓位」，并提示先补全账户资金，而不是编造仓位。`,
    `7. 若数据明显不足（如 pe=数据缺失且缺支撑阻力），直接给「暂时不能判断，先补全X再问」，不要硬凑买卖建议。`,
    `8. 仓位建议必须展示计算：风险每股=max(当前价-支撑线,当前价×3%)；单笔可亏=总资产×max_loss_percent%（这是仓位风险预算，用于反推股数）；止损线另按 max_loss_percent% 占买入价折算（止损价=买入价×(1−max_loss_percent%)，对应亏损 max_loss_percent 个点）。建议股数=单笔可亏÷风险每股，且≤可用现金、单股≤总资产×max_concentration_percent%；成数=建议金额÷总资产。数字只来自 context，缺失如实说明。`,
    `9. 下方的【我的交易纪律与风险偏好】是硬约束，必须优先生效，不得再用固定的 2%/30% 规则；当 enforce_stop_loss=是 时，任何买入动作都必须先给出止损位，跌破即执行。`,
    `10. 【开新仓硬约束（针对未持仓的新标的）】只要用户当前未持有该股，结论必须给出明确的「开新仓」判断——开新仓（买入建仓）/ 暂不开新仓（观望），且不得与「加仓」混淆（加仓只针对已持有标的）。是否开新仓须综合：①账户可用现金是否足以建仓（至少够 1 手并覆盖单笔风险预算）；②当前总仓位是否逼近纪律上限（超过 max_position_percent 或总仓位>80% 则空间不足）；③交易纪律是否放行（买入必须先设止损等）。三者任一不满足即「暂不开新仓」并点明原因；全部满足则给明确买点、建议仓位与止损位。`,
    `10. 【技术面为主，基本面按实际可得性使用】基本面是否可得一律以下方 context 的「基本面」行实际内容为准，不得预设它一定缺失：凡已给出数值的字段（营收增长/利润增长/负债率/PE/PB/ROE）必须引用并参与判断，不许无视已有数据或笼统宣称「基本面缺失」；只有确实显示「数据缺失」的项才说明该项缺失。K线/成交量/MACD/RSI/KDJ/支撑阻力始终稳定可得，故在基本面确实不足时，以走势结构（均线方向、价格与支撑阻力位置）、量能（放量突破/缩量回调/量价背离）、动能指标（MACD/RSI/KDJ）为主要评判依据，并注明「基本面数据缺失，以下判断以技术面为主」。任何情况下不得编造财务数字。`,
    `【反幻觉示例】用户问「茅台 PE 多少、能买吗」而 pe=数据缺失 → 正确回答：「数据缺失：本次没取到 PE，我不凭记忆补数。能不能买看你的仓位和计划，先把账户资金补全、设好止损再谈。」`,
    `【数字格式硬约束】所有金额、价格、百分比、仓位一律用阿拉伯数字 + 单位呈现（如 ¥344.96、16.27%、仓位 12.3%），严禁使用中文大写数字（如「叁佰肆拾肆元玖角陆分」「贰拾点壹零百分比」「壹仟股」）。数字直接写在正文里，不要额外念成中文大写，也不要把「%」「元」替换成中文读法。`,
    `【我的交易纪律与风险偏好，必须优先遵守，替代任何固定百分比】`,
    `risk_profile=${prefs.riskProfile}`,
    `max_loss_percent=${prefs.maxLossPercent}`,
    `max_concentration_percent=${prefs.maxConcentrationPercent}`,
    `max_position_percent=${prefs.maxPositionPercent}`,
    `enforce_stop_loss=${prefs.enforceStopLoss ? "是（任何买入必须先设止损）" : "否（由用户自行决定）"}`,
    `discipline_note=${prefs.disciplineNote || "（未填写）"}`,
    tradeModePrompt(prefs.tradeMode, "act"),
    `context=\n${summarizeContext(context)}`,
  ].join("\n");

  if (!structured) return base;
  return base + "\n" + STRUCTURED_OUTPUT_INSTRUCTION;
}

// 规则兜底的综合策略：无持仓→建仓决策；有持仓→操作决策。不依赖问句分类。
export function buildStrategyFallback(
  context: AssistantContext,
  prefs: TradingPreferences,
): { content: string; action: StrategyAction } {
  const { quote, position } = context;
  const osc = oscillatorTip(context);

  if (!position) {
    if (context.portfolio.totalPositionPercent === null || context.portfolio.totalAssets === null) {
      return {
        content: [
          "结论：暂时不能判断仓位是否允许新建仓。",
          "依据：尚未设置账户初始资金，无法计算现金和总仓位。",
          "风险与缺口：缺少账户资金基准，任何价格信号都不能替代仓位约束。",
          "下一步：先在设置中填写账户初始资金，再来评估买入条件。",
        ].join("\n"),
        action: null,
      };
    }
    const totalPosition = context.portfolio.totalPositionPercent ?? 0;
    const totalAssets = context.portfolio.totalAssets;
    const riskPerShare = Math.max(quote.price - quote.support, quote.price * 0.03);
    const maxLoss = totalAssets * (prefs.maxLossPercent / 100);
    let shares = riskPerShare > 0 ? Math.floor(maxLoss / riskPerShare) : 0;
    const maxByCash = context.portfolio.cash == null ? Infinity : Math.floor(context.portfolio.cash / quote.price);
    const maxByConcentration = Math.floor((totalAssets * (prefs.maxConcentrationPercent / 100)) / quote.price);
    shares = Math.max(0, Math.min(shares, maxByCash, maxByConcentration));
    const cheng = totalAssets > 0 ? (shares * quote.price) / totalAssets : 0;
    const cashEnough = context.portfolio.cash == null ? true : context.portfolio.cash >= quote.price;
    const capacityOk = totalPosition < 80;
    const openNew = capacityOk && cashEnough && shares > 0;
    if (!openNew) {
      const reasons: string[] = [];
      if (!capacityOk) reasons.push(`总仓位已${totalPosition.toFixed(2)}%逼近上限`);
      if (!cashEnough) reasons.push("可用现金不足以建仓");
      if (shares <= 0) reasons.push("按风险预算算不出正股数（支撑缺失或单笔风险过大）");
      return {
        content: [
          "结论：开新仓判断——暂不开新仓（观望）。",
          `依据：${reasons.join("；") || "当前不满足开新仓条件"}。`,
          `账户现状：总仓位${totalPosition.toFixed(2)}%，现金${context.portfolio.cash === null ? "暂无" : `¥${context.portfolio.cash.toFixed(2)}`}；现价¥${quote.price.toFixed(3)}，风险观察线¥${quote.support.toFixed(3)}。`,
          `风险与缺口：暂不开新仓是纪律优先、不逆势加暴露，不等于判断会跌；${context.missingInformation.slice(0, 2).join("、") || "最新公告仍需自行核验"}${osc ? `\n动能信号：${osc}` : ""}。`,
          "下一步：等条件满足（仓位腾出/现金到位）再评估，最终由你确认。",
        ].join("\n"),
        action: "观望",
      };
    }
    return {
      content: [
        `结论：开新仓判断——可以开新仓（买入建仓）。`,
        `依据：总仓位${totalPosition.toFixed(2)}%仍有空间，现金${context.portfolio.cash === null ? "暂无" : `¥${context.portfolio.cash.toFixed(2)}`}；现价¥${quote.price.toFixed(3)}，风险观察线¥${quote.support.toFixed(3)}，单笔风险每股约¥${riskPerShare.toFixed(3)}。`,
        `建议仓位：约${cheng.toFixed(2)}成（约${shares}股），按价格到支撑线的距离控单笔亏损（单笔可亏=占买入价${prefs.maxLossPercent}%、单股不超${prefs.maxConcentrationPercent}%）；${prefs.enforceStopLoss ? "买入前必须先设止损，" : ""}止损位设在¥${quote.support.toFixed(3)}下方。`,
        `风险与缺口：开新仓只限风险，不证明会涨；${context.missingInformation.slice(0, 2).join("、") || "最新公告仍需自行核验"}${osc ? `\n动能信号：${osc}` : ""}。`,
        "下一步：先定买入逻辑与失效条件，再决定下不下手，最终由你确认执行。",
      ].join("\n"),
      action: "开新仓",
    };
  }

  const p = position;
  const belowSupport = quote.price < quote.support;
  const nearResistance = quote.resistance > 0 && quote.price >= quote.resistance * 0.98;
  const concentration = p.stockPositionPercent ?? 0;
  const returnPercent = p.returnPercent ?? 0;
  const totalPosition = context.portfolio.totalPositionPercent ?? 0;
  const stopLoss = quote.support;
  const takeProfit = quote.resistance;
  let actionText: string;
  let strategyAction: StrategyAction;
  let reason: string;
  if (belowSupport) {
    actionText = "立即减仓/清仓（止损优先）";
    strategyAction = "减仓";
    reason = `价格已跌破止损线¥${stopLoss.toFixed(3)}，原买入逻辑失效，先砍风险`;
  } else if (returnPercent > 0 && nearResistance) {
    actionText = "分批止盈/减仓";
    strategyAction = "减仓";
    reason = `已有盈利且逼近阻力¥${takeProfit.toFixed(3)}，落袋为安`;
  } else if (concentration >= prefs.maxConcentrationPercent) {
    actionText = "减仓降集中";
    strategyAction = "减仓";
    reason = `该股占仓${concentration.toFixed(2)}%已超${prefs.maxConcentrationPercent}%警戒`;
  } else {
    actionText = "持有并盯紧止损";
    strategyAction = "持有";
    reason = `仍在支撑上方、占仓${concentration.toFixed(2)}%未超标，持有观察`;
  }
  const canAdd = !belowSupport && concentration < prefs.maxConcentrationPercent && totalPosition < 80;
  const slText = `${prefs.enforceStopLoss ? "跌破¥" + stopLoss.toFixed(3) + "必须立即砍，不犹豫" : "跌破¥" + stopLoss.toFixed(3) + "即减仓/清仓"}`;
  const tpText = takeProfit > 0 ? `涨至¥${takeProfit.toFixed(3)}附近分批卖、落袋为安` : "阻力缺失，暂无法定价止盈，以跌破支撑为唯一卖出信号";
  const addText = canAdd
    ? `回踩¥${stopLoss.toFixed(3)}不破、占仓未超${prefs.maxConcentrationPercent}%、总仓位<80%时可小仓加，单笔受可亏约束`
    : "当前不满足加仓条件，不加";
  return {
    content: [
      `结论：持仓${percent(p.returnPercent)}，操作——${actionText}。`,
      `依据：持仓${p.quantity}股@成本¥${p.averageCost.toFixed(3)}，现价¥${quote.price.toFixed(3)}，占仓${concentration.toFixed(2)}%，总仓位${totalPosition.toFixed(2)}%；支撑¥${stopLoss.toFixed(3)}、阻力¥${takeProfit.toFixed(3)}。`,
      `四档触发（讲死）：①止损——${slText}；②止盈——${tpText}；③加仓(买入)——${addText}；④减仓/卖出——占仓≥${prefs.maxConcentrationPercent}%或跌破支撑时减，否则持有。`,
      `风险与缺口：${reason}；${context.missingInformation.slice(0, 2).join("、") || "最新公告仍需自行核验"}${osc ? `\n动能信号：${osc}` : ""}。`,
      "下一步：按动作执行，最终由你确认。",
    ].join("\n"),
    action: strategyAction,
  };
}

export async function generateStrategy(
  context: AssistantContext,
  prefs: TradingPreferences = DEFAULT_PREFERENCES,
): Promise<StrategyResult> {
  // 始终先跑规则引擎，拿到确定性结论
  const ruleResult = buildStrategyFallback(context, prefs);
  const { content: ruleContent, action: ruleAction } = ruleResult;
  // 上下文质量评分
  const contextQuality = evaluateContextQuality(context);
  const ai = getAiConfig();

  // AI 不可用：仅规则引擎
  if (!ai.configured) {
    return { content: ruleContent, mode: "automatic", ruleAction, aiAction: null, diff: null, contextQuality };
  }

  try {
    // 使用结构化输出 prompt（JSON 格式约束）
    const structuredPrompt = buildTraderSystemPrompt(prefs, context, true);
    const messages = [
      { role: "system" as const, content: structuredPrompt },
      {
        role: "user" as const,
        content: "结合我的资产、风险偏好与交易纪律，给出该股当前交易策略。请严格按 JSON 格式输出。",
      },
    ];
    const response = await fetch(`${ai.apiBase}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ai.apiKey}` },
      body: JSON.stringify({ model: ai.model, messages }),
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`AI error ${response.status}`);
    const data = (await response.json()) as DeepSeekResponse;
    const aiAnswer = data.choices?.[0]?.message?.content?.trim();

    if (!aiAnswer) {
      return { content: ruleContent, mode: "automatic", ruleAction, aiAction: null, diff: null, contextQuality };
    }

    // 尝试解析结构化 JSON
    const structured = parseStructuredOutput(aiAnswer);

    if (structured) {
      // 结构化解析成功 → 校验 + 对比规则引擎 + 用渲染版 markdown 替代原文
      const rendered = renderStructuredToText(structured);
      // 结构化字段校验（数值区间、层级、资金约束）
      const structuralWarnings = validateStructured(structured, context, prefs);
      // 自由文本数字守卫：覆盖 reasoning / risks / 各类 condition 等 JSON 校验触及不到的字段
      const numberIssues = guardNumbers(rendered, context, { strictPrice: true });
      const validationWarnings = [...structuralWarnings, ...issuesToWarnings(numberIssues)];
      const aiAction = structured.action;
      const diff = ruleAction !== null && aiAction !== null ? ruleAction !== aiAction : null;

      // 命中确定性错误（结构化 [幻觉] 或 文本数字幻觉）→ 拦截 AI 正文，回退规则引擎结果。
      // 保留 warnings 与 structured 供前端展示「AI 结果已被拦截及原因」。
      const blocked =
        structuralWarnings.some((w) => w.startsWith("[幻觉]")) || hasBlockingIssue(numberIssues);

      if (blocked) {
        return {
          content: ruleContent,
          mode: "automatic",
          ruleAction,
          aiAction,
          diff,
          structured,
          validationWarnings,
          contextQuality,
          blocked: true,
        };
      }

      return {
        content: rendered, // 用渲染版 markdown，前端 StrategyBlocks 才能分块
        mode: ai.provider,
        ruleAction,
        aiAction,
        diff,
        structured,
        validationWarnings: validationWarnings.length > 0 ? validationWarnings : undefined,
        contextQuality,
      };
    }

    // 结构化解析失败 → 退回文本模式提取
    const aiAction = extractAiAction(aiAnswer);
    const diff = ruleAction !== null && aiAction !== null ? ruleAction !== aiAction : null;
    // 纯文本路径同样要过数字守卫（此处无结构化字段，价格白名单误报风险更高，仅做格式类拦截）
    const textIssues = guardNumbers(aiAnswer, context, { strictPrice: false });
    if (hasBlockingIssue(textIssues)) {
      return {
        content: ruleContent,
        mode: "automatic",
        ruleAction,
        aiAction,
        diff,
        validationWarnings: issuesToWarnings(textIssues),
        contextQuality,
        blocked: true,
      };
    }

    return {
      content: aiAnswer,
      mode: ai.provider,
      ruleAction,
      aiAction,
      diff,
      validationWarnings: textIssues.length > 0 ? issuesToWarnings(textIssues) : undefined,
      contextQuality,
    };
  } catch {
    // AI 调用异常，回退规则
    return { content: ruleContent, mode: "automatic", ruleAction, aiAction: null, diff: null, contextQuality };
  }
}
