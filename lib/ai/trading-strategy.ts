import { getAiConfig } from "./ai-config";
import { DEFAULT_PREFERENCES, type TradingPreferences } from "../utils/preferences";
import type { AssistantContext } from "./assistant";
import type { Oscillators } from "../domain/stocks";

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
  lines.push(`成交量(近20日)：${ctx.volume ?? "数据缺失"}`);
  const osc = oscillatorTip(ctx);
  if (osc) lines.push(`摆动指标：${osc}`);
  if (ctx.position && ctx.portfolio.totalAssets !== null) {
    const p = ctx.position;
    const posValue = p.quantity * q.price;
    const total = ctx.portfolio.totalAssets;
    const pct = total > 0 ? (posValue / total) * 100 : 0;
    lines.push(`我的持仓：数量=${p.quantity}股，成本=${p.averageCost.toFixed(3)}元，盈亏=${percent(p.returnPercent)}，占总资产=${pct.toFixed(2)}%`);
  } else if (ctx.portfolio.totalAssets !== null) {
    lines.push(`我的账户：总资产=${ctx.portfolio.totalAssets.toFixed(2)}元，现金=${ctx.portfolio.cash?.toFixed(2) ?? "暂无"}，总仓位=${ctx.portfolio.totalPositionPercent?.toFixed(2) ?? "暂无"}%`);
  } else {
    lines.push("我的账户：尚未设置初始资金，无法计算现金和总仓位");
  }
  if (ctx.source?.fetchedAt) lines.push(`数据时间：${ctx.source.fetchedAt}`);
  return lines.join("\n");
}

function buildTraderSystemPrompt(prefs: TradingPreferences, context: AssistantContext): string {
  return [
    "你是严厉且资深的操盘手，只看数据、不拍脑袋。风格：直接、强硬、反幻觉；句句落到买卖动作上——买/加仓/持有/减仓/止损/清仓，并给出明确价格与股数/金额，不许用“可以考虑”“或许”这类软话。能算就给数字，不能算就明说缺什么；违背纪律的倾向要直接点破。不承诺收益、不替用户下单，最终由用户确认执行。",
    "1. 只根据 context 里的信息做判断，绝不凭记忆补数、不编造行情或财务数字（PE/ROE/支撑阻力等缺失就写“数据缺失”）。",
    "2. 支撑位与阻力位来自 context 的支撑/阻力；没有历史价或数值异常时直接说明“无法判断支撑/阻力”，不臆造。",
    "3. 针对用户的实际持仓与账户状况给建议：有持仓从成本/盈亏/占仓出发谈加仓减仓止损；无持仓从旁观角度给方向，不要假装知道用户有没有买。",
    "4. 任何买入/加仓结论必须先给止损位（跌破即执行），并说明为什么这个位置能控风险；绝不允许“先买再看”。",
    "5. 成交量只作为信号（放量突破/缩量回调），不得单独据此下单；不得预测具体点位或保证收益。",
    "6. 若 context 显示账户未设置初始资金，明确说“无法计算仓位”，并提示先补全账户资金，而不是编造仓位。",
    "7. 若数据明显不足（如 pe=数据缺失且缺支撑阻力），直接给“暂时不能判断，先补全X再问”，不要硬凑买卖建议。",
    "8. 仓位建议必须展示计算：风险每股=max(当前价-支撑线,当前价×3%)；单笔可亏=总资产×max_loss_percent%；建议股数=单笔可亏÷风险每股，且≤可用现金、单股≤总资产×max_concentration_percent%；成数=建议金额÷总资产。数字只来自 context，缺失如实说明。",
    "9. 下方的【我的交易纪律与风险偏好】是硬约束，必须优先生效，不得再用固定的 2%/30% 规则；当 enforce_stop_loss=是 时，任何买入动作都必须先给出止损位，跌破即执行。",
    "10. 【技术面为主，基本面按可得性降级】本系统基本面数据可能不全（营收/利润/负债率常缺），但 K线/成交量/MACD/RSI/KDJ/支撑阻力始终稳定可得。因此优先用走势结构（均线方向、价格与支撑阻力位置）、量能（放量突破/缩量回调/量价背离）、动能指标（MACD/RSI/KDJ）作为主要评判依据；基本面缺失时直接注明“基本面数据缺失，以下判断以技术面为主”，不要因某项财务缺失就拒绝技术判断，更不要编造财务数字。",
    "【反幻觉示例】用户问“茅台 PE 多少、能买吗”而 pe=数据缺失 → 正确回答：“数据缺失：本次没取到 PE，我不凭记忆补数。能不能买看你的仓位和计划，先把账户资金补全、设好止损再谈。”",
    "【我的交易纪律与风险偏好，必须优先遵守，替代任何固定百分比】",
    `risk_profile=${prefs.riskProfile}`,
    `max_loss_percent=${prefs.maxLossPercent}`,
    `max_concentration_percent=${prefs.maxConcentrationPercent}`,
    `max_position_percent=${prefs.maxPositionPercent}`,
    `enforce_stop_loss=${prefs.enforceStopLoss ? "是（任何买入必须先设止损）" : "否（由用户自行决定）"}`,
    `discipline_note=${prefs.disciplineNote || "（未填写）"}`,
    `context=\n${summarizeContext(context)}`,
  ].join("\n");
}

// 规则兜底的综合策略：无持仓→建仓决策；有持仓→操作决策。不依赖问句分类。
export function buildStrategyFallback(context: AssistantContext, prefs: TradingPreferences): string {
  const { quote, position } = context;
  const osc = oscillatorTip(context);

  if (!position) {
    if (context.portfolio.totalPositionPercent === null || context.portfolio.totalAssets === null) {
      return [
        "结论：暂时不能判断仓位是否允许新建仓。",
        "依据：尚未设置账户初始资金，无法计算现金和总仓位。",
        "风险与缺口：缺少账户资金基准，任何价格信号都不能替代仓位约束。",
        "下一步：先在设置中填写账户初始资金，再来评估买入条件。",
      ].join("\n");
    }
    const totalPosition = context.portfolio.totalPositionPercent;
    const totalAssets = context.portfolio.totalAssets;
    const riskPerShare = Math.max(quote.price - quote.support, quote.price * 0.03);
    const maxLoss = totalAssets * (prefs.maxLossPercent / 100);
    let shares = riskPerShare > 0 ? Math.floor(maxLoss / riskPerShare) : 0;
    const maxByCash = context.portfolio.cash == null ? Infinity : Math.floor(context.portfolio.cash / quote.price);
    const maxByConcentration = Math.floor((totalAssets * (prefs.maxConcentrationPercent / 100)) / quote.price);
    shares = Math.max(0, Math.min(shares, maxByCash, maxByConcentration));
    const cheng = totalAssets > 0 ? (shares * quote.price) / totalAssets : 0;
    const totalTone = totalPosition >= 80
      ? "总仓位已偏高，先别再加风险暴露，优先处理已有仓位"
      : "从仓位层面看仍有空间，但空间不等于买点，标的本身得自己过关";
    return [
      `结论：操盘手建仓视角——${totalTone}。`,
      `依据：当前总仓位${totalPosition.toFixed(2)}%，现金${context.portfolio.cash === null ? "暂无" : `¥${context.portfolio.cash.toFixed(2)}`}；现价¥${quote.price.toFixed(3)}，风险观察线¥${quote.support.toFixed(3)}，单笔风险每股约¥${riskPerShare.toFixed(3)}。`,
      `建议仓位：约${cheng.toFixed(2)}成（约${shares}股），按价格到支撑线的距离控单笔亏损（单笔可亏=总资产${prefs.maxLossPercent}%、单股不超${prefs.maxConcentrationPercent}%）；${prefs.enforceStopLoss ? "买入前必须先设止损，" : ""}止损位设在¥${quote.support.toFixed(3)}下方。`,
      `风险与缺口：仓位只限风险，不证明会涨；${context.missingInformation.slice(0, 2).join("、") || "最新公告仍需自行核验"}${osc ? `\n动能信号：${osc}` : ""}。`,
      "下一步：先定买入逻辑与失效条件，再决定下不下手，最终由你确认执行。",
    ].join("\n");
  }

  const p = position;
  const belowSupport = quote.price < quote.support;
  const nearResistance = quote.resistance > 0 && quote.price >= quote.resistance * 0.98;
  const concentration = p.stockPositionPercent ?? 0;
  const totalPosition = context.portfolio.totalPositionPercent ?? 0;
  let action: string;
  let reason: string;
  if (belowSupport) {
    action = "止损/减仓（风险优先）";
    reason = `价格已跌破风险观察线¥${quote.support.toFixed(3)}，原买入逻辑失效，先砍风险`;
  } else if (p.returnPercent > 0 && nearResistance) {
    action = "分批止盈/减仓";
    reason = `已有盈利且逼近阻力¥${quote.resistance.toFixed(3)}，落袋为安`;
  } else if (concentration >= prefs.maxConcentrationPercent) {
    action = "减仓降集中";
    reason = `该股占仓${concentration.toFixed(2)}%已超${prefs.maxConcentrationPercent}%警戒`;
  } else {
    action = "持有并盯止损";
    reason = `仍在支撑上方、占仓${concentration.toFixed(2)}%未超标，持有观察`;
  }
  const canAdd = !belowSupport && concentration < prefs.maxConcentrationPercent && totalPosition < 80;
  return [
    `结论：当前持仓相对成本${percent(p.returnPercent)}，操作建议——${action}${canAdd ? "；若回踩支撑不破、且未触发纪律上限，可小仓加（仍受单笔可亏约束）" : "；暂不加仓"}。`,
    `依据：持仓${p.quantity}股，成本¥${p.averageCost.toFixed(3)}，现价¥${quote.price.toFixed(3)}，占仓${concentration.toFixed(2)}%，账户总仓位${totalPosition.toFixed(2)}%；支撑¥${quote.support.toFixed(3)}、阻力¥${quote.resistance.toFixed(3)}。`,
    `仓位与止损：${prefs.enforceStopLoss ? "必须先设止损，" : ""}止损位设在¥${quote.support.toFixed(3)}下方，单笔亏损控制在计划内。`,
    `风险与缺口：${reason}；${context.missingInformation.slice(0, 2).join("、") || "最新公告仍需自行核验"}${osc ? `\n动能信号：${osc}` : ""}。`,
    "下一步：按动作执行，最终由你确认。",
  ].join("\n");
}

export async function generateStrategy(
  context: AssistantContext,
  prefs: TradingPreferences = DEFAULT_PREFERENCES,
): Promise<{ content: string; mode: string }> {
  const fallback = buildStrategyFallback(context, prefs);
  const ai = getAiConfig();
  if (!ai.configured) return { content: fallback, mode: "automatic" };
  try {
    const messages = [
      { role: "system" as const, content: buildTraderSystemPrompt(prefs, context) },
      {
        role: "user" as const,
        content:
          "结合我的资产、风险偏好与交易纪律，给出该股当前交易策略：是否买入/加仓/持有/减仓/清仓，建议仓位（股数/成数）与止损位，并说明触发条件与依据。",
      },
    ];
    const response = await fetch(`${ai.apiBase}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ai.apiKey}` },
      body: JSON.stringify({ model: ai.model, messages }),
    });
    if (!response.ok) throw new Error(`AI error ${response.status}`);
    const data = (await response.json()) as DeepSeekResponse;
    const answer = data.choices?.[0]?.message?.content?.trim();
    return { content: answer || fallback, mode: answer ? ai.provider : "automatic" };
  } catch {
    return { content: fallback, mode: "automatic" };
  }
}
