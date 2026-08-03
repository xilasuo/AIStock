import { getAiConfig } from "../../../lib/ai-config";
import { buildFallbackAnswer, isValidContext, type AssistantContext } from "../../../lib/assistant";
import { getCurrentUser, requireApiUser } from "../../../lib/auth";
import { ensureSchema, getDb } from "../../../db";
import { DEFAULT_PREFERENCES, fetchPreferences, type TradingPreferences } from "../../../lib/preferences";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

type ChatResponse = {
  choices?: Array<{ message?: { content?: string } }>;
};

const OFFLINE_NOTE = "（操盘手离线值班：当前未接入 AI，以下是按你的纪律和盘面本地算出的参考，话一样直接，但判断请以实盘为准。）\n";

function summarizeContext(ctx: AssistantContext): string {
  const s = ctx.stock;
  const q = ctx.quote;
  const f = ctx.financials;
  const lines = [
    `股票：${s.name}(${s.code})，类型=${s.instrumentType}，行业=${s.industry ?? "未知"}`,
    `行情时间：${q.marketTime ?? "未提供"}`,
    `当前价=${q.price}，涨跌幅=${q.changePercent.toFixed(2)}%，MA20=${q.ma20}`,
    `走势结构：现价相对MA20${q.price >= q.ma20 ? "之上（短线偏强）" : "之下（短线偏弱）"}；支撑=${q.support}，阻力=${q.resistance}，价格相对阻力距离=${q.resistance > 0 ? (((q.resistance - q.price) / q.price) * 100).toFixed(1) + "%" : "缺失"}，近20日平均波动=${q.volatility.toFixed(2)}%`,
    `财务：营收增长=${f.revenueGrowth ?? "数据缺失"}，利润增长=${f.profitGrowth ?? "数据缺失"}，负债率=${f.debtRatio ?? "数据缺失"}，PE=${f.pe ?? "数据缺失"}，PB=${f.pb ?? "数据缺失"}，ROE=${f.roe ?? "数据缺失"}${f.revenueGrowth == null && f.profitGrowth == null && f.debtRatio == null ? "（基本面几乎全部缺失，本次判断以技术面为主）" : ""}`,
    `一句话结论：${ctx.summary}`,
    `已识别风险：${(ctx.risks ?? []).join("；") || "无"}`,
    `缺失信息：${(ctx.missingInformation ?? []).join("；") || "无"}`,
    `数据来源：${ctx.source.name}（获取于 ${ctx.source.fetchedAt}）`,
  ];
  if (ctx.position) {
    const p = ctx.position;
    lines.push(`我的持仓：${p.quantity}股，成本=${p.averageCost}，当前回报=${p.returnPercent.toFixed(2)}%，占账户仓位=${p.stockPositionPercent ?? "数据缺失"}%`);
  } else {
    lines.push("我的持仓：无");
  }
  const pf = ctx.portfolio;
  lines.push(`账户：总资产=${pf.totalAssets ?? "数据缺失"}，现金=${pf.cash ?? "数据缺失"}，总仓位=${pf.totalPositionPercent ?? "数据缺失"}%，账户总收益=${pf.totalProfitPercent ?? "数据缺失"}%`);
  if (ctx.volume) {
    const divergenceNote =
      ctx.volume.divergence === "顶背离"
        ? "（价格高位但量能未同步放大，警惕追高）"
        : ctx.volume.divergence === "底背离"
          ? "（低位缩量、抛压衰竭迹象，关注止跌但勿直接抄底）"
          : ctx.volume.ratio != null && ctx.volume.ratio >= 1.5
            ? "（明显放量，配合价格方向判断突破可靠性）"
            : ctx.volume.ratio != null && ctx.volume.ratio < 0.6
              ? "（明显缩量，突破可信度低）"
              : "";
    lines.push(`量能：当日成交量 ${ctx.volume.latest}，近5日均量 ${ctx.volume.ma5.toFixed(0)}、近20日均量 ${ctx.volume.ma20.toFixed(0)}，量比 ${ctx.volume.ratio === null ? "缺失" : ctx.volume.ratio.toFixed(2)}，量价背离 ${ctx.volume.divergence ?? "未知"}（近20日上涨放量 ${ctx.volume.upDaysWithVolume} 天、下跌放量 ${ctx.volume.downDaysWithVolume} 天）${divergenceNote}。`);
  } else {
    lines.push("量能：数据缺失。");
  }
  if (ctx.oscillators) {
    const o = ctx.oscillators;
    const macd = o.macd
      ? `DIF=${o.macd.dif.toFixed(3)}, DEA=${o.macd.dea.toFixed(3)}, 柱=${o.macd.hist.toFixed(3)}, 状态=${o.macd.state}, 背离=${o.macd.divergence ?? "未知"}`
      : "DIF/DEA/柱=缺失";
    const rsi = o.rsi
      ? `RSI6=${o.rsi.rsi6?.toFixed(1) ?? "缺失"}, RSI12=${o.rsi.rsi12?.toFixed(1) ?? "缺失"}, RSI24=${o.rsi.rsi24?.toFixed(1) ?? "缺失"}, 区=${o.rsi.zone}`
      : "RSI=缺失";
    const kdj = o.kdj
      ? `K=${o.kdj.k?.toFixed(1) ?? "缺失"}, D=${o.kdj.d?.toFixed(1) ?? "缺失"}, J=${o.kdj.j?.toFixed(1) ?? "缺失"}, 状态=${o.kdj.state}`
      : "KDJ=缺失";
    lines.push(`摆动指标：${macd}；${rsi}；${kdj}。`);
  } else {
    lines.push("摆动指标：数据缺失。");
  }
  return lines.join("\n");
}

export async function POST(request: Request) {
  const unauthorized = await requireApiUser();
  if (unauthorized) return unauthorized;

  const user = await getCurrentUser();
  const payload = await request.json().catch(() => null) as {
    question?: string;
    context?: unknown;
    messages?: unknown;
  } | null;
  const question = payload?.question?.trim() ?? "";
  if (!question || question.length > 300 || !isValidContext(payload?.context)) {
    return Response.json({ error: "问题或分析上下文不正确" }, { status: 400 });
  }

  const messages = Array.isArray(payload?.messages)
    ? payload.messages.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const message = item as Partial<ChatMessage>;
        if (
          (message.role !== "user" && message.role !== "assistant") ||
          typeof message.content !== "string" ||
          !message.content.trim()
        ) {
          return [];
        }
        return [{ role: message.role, content: message.content.slice(0, 1200) }];
      }).slice(-8)
    : [];

  let prefs: TradingPreferences = DEFAULT_PREFERENCES;
  try {
    await ensureSchema();
    prefs = await fetchPreferences(getDb(), user.id);
  } catch {
    // 偏好缺失时退回默认纪律，不影响对话
  }
  const fallback = buildFallbackAnswer(question, payload.context as AssistantContext, prefs);
  const ai = getAiConfig();
  if (!ai.configured) {
    return Response.json({ answer: OFFLINE_NOTE + fallback, mode: "fallback" });
  }

  try {
    const response = await fetch(`${ai.apiBase}/chat/completions`, {
      method: "POST",
      signal: AbortSignal.timeout(25_000),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ai.apiKey}`,
      },
      body: JSON.stringify({
        model: ai.model,
        // 0.6：既保留“果断、敢于给方向”的操盘手风格，又不至于失控乱给结论。
        // 过低(0.2)会让回答偏保守、模式化，与硬约束要求的直给动作相悖。
        temperature: 0.6,
        messages: [
          {
            role: "system",
            content: [
              "你是严厉且资深的操盘手，有十年以上实盘经验。你说话直、不客气、不绕弯子，句句落到买卖动作上：买/加仓/持有/减仓/止损/清仓，并给出明确价格与仓位。你不哄用户，不做无意义的客套，对违背纪律的倾向要直接点破。对用户，你是替他盯盘、管仓、约束纪律的实战操盘手。",
              "【硬约束，违反即犯错】",
              "1. 一切观点和数字必须来自下方 context 与上文对话；context 未出现的数字（目标价、PE、仓位占比、ROE 等）一律不得编造，缺失就直说“数据缺失”。",
              "2. 任何买卖动作前必须先核对总仓位、现金、单股集中度；缺账户资金数据时不得下买卖结论，只能要求用户先补全账户资金。",
              "3. 必须结合用户持仓与该股在账户中的占比来给建议；无持仓时也要先点明“你当前无该股持仓记录”，再从旁观角度给方向。",
              "4. 给动作必须明确、量化、带态度：要么“买约 X 成、约 N 股”，要么“减仓/清仓/设止损到 ¥X”，直接下结论，不许用“可以考虑”“或许”“建议观望”这类软话糊弄。该止损就喊止损，该重仓就说明敢重仓的理由，别两头下注。同时用一两句话点出判断依据。不承诺收益、不替用户下单，最终由用户确认执行。",
              "5. 持仓建议是重点：根据当前价相对成本、支撑/阻力、该股占比与账户总仓位，明确给出加仓/持有/减仓/止损/止盈中哪一种，并说清触发条件。违反纪律（如单股仓位过重、该止损不止损）要直接点名批评，不留情面。",
              "6. 回答固定四段：结论（一句话亮明动作与态度，干脆别铺垫）/ 依据（点出具体数字及其数据时间）/ 风险与缺口 / 下一步操作。",
              "7. 不超过500字，口语化、不啰嗦、少重复免责声明，把话说到点子上。",
              "8. 仓位建议必须展示计算：风险每股=max(当前价-支撑线,当前价×3%)；单笔可亏=总资产×max_loss_percent%；建议股数=单笔可亏÷风险每股，且≤可用现金、单股≤总资产×max_concentration_percent%；成数=建议金额÷总资产。数字只来自 context，缺失如实说明。",
              "9. 下方的【我的交易纪律与风险偏好】是硬约束，必须优先生效，不得再用固定的 2%/30% 规则；当 enforce_stop_loss=是 时，任何买入动作都必须先给出止损位，跌破即执行。",
              "10. 【技术面为主，基本面按可得性降级】本系统基本面数据可能不全（营收/利润/负债率常缺），但 K线/成交量/MACD/RSI/KDJ/支撑阻力始终稳定可得。因此：优先用走势结构（均线多头/空头、价格与支撑阻力的位置）、量能（放量突破/缩量回调/量价背离）、动能指标（MACD金叉死叉、RSI超买超卖、KDJ）作为主要评判依据；基本面（PE/PB/ROE等）在缺失时直接注明“基本面数据缺失，以下判断以技术面为主”，不要因为某项财务数据缺失就拒绝给出技术判断，更不要编造财务数字。",
              "11. 【解释深度自适应】根据用户提问的措辞调整解释深度：问法偏入门（如“什么是支撑位”）就用大白话先讲清概念再给结论；用专业术语提问就直接讲要点、少铺垫。但无论深浅，结论都要落到明确的买卖建议与量化动作上。",
              "【反幻觉示例】用户问“茅台 PE 多少、能买吗”而 pe=数据缺失 → 正确回答：“PE 数据缺失，我不凭记忆给你编数。没有估值和账户资金，谁让你现在拍脑袋买谁就是害你；先把账户资金补全、仓位和止损设好，再来谈买不买。”",
              "【我的交易纪律与风险偏好，必须优先遵守，替代任何固定百分比】",
              `risk_profile=${prefs.riskProfile}`,
              `max_loss_percent=${prefs.maxLossPercent}`,
              `max_concentration_percent=${prefs.maxConcentrationPercent}`,
              `max_position_percent=${prefs.maxPositionPercent}`,
              `enforce_stop_loss=${prefs.enforceStopLoss ? "是（任何买入必须先设止损）" : "否（由用户自行决定）"}`,
              `discipline_note=${prefs.disciplineNote || "（未填写）"}`,
              `context=\n${summarizeContext(payload.context as AssistantContext)}`,
            ].join("\n"),
          },
          ...messages,
          { role: "user", content: question },
        ],
      }),
    });
    if (!response.ok) {
      return Response.json({ answer: OFFLINE_NOTE + fallback, mode: "fallback" });
    }

    const result = await response.json().catch(() => null) as ChatResponse | null;
    const answer = result?.choices?.[0]?.message?.content?.trim();
    return Response.json({
      answer: answer ? answer.slice(0, 3000) : OFFLINE_NOTE + fallback,
      mode: answer ? "ai" : "fallback",
    });
  } catch {
    return Response.json({ answer: OFFLINE_NOTE + fallback, mode: "fallback" });
  }
}
