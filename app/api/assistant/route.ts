import { getAiConfig, type AiConfig } from "../../../lib/ai/ai-config";
import { buildFallbackAnswer, isValidContext, summarizeContext, type AssistantContext } from "../../../lib/ai/assistant";
import { getCurrentUser, requireApiUser } from "../../../lib/auth/auth";
import { ensureSchema, getDb } from "../../../db";
import { tradeRecords } from "../../../db/schema";
import { eq } from "drizzle-orm";
import { calculatePortfolio, type Trade } from "../../../lib/domain/domain";
import { DEFAULT_PREFERENCES, fetchPreferences, type TradingPreferences } from "../../../lib/utils/preferences";
import { tradeModePrompt } from "../../../lib/utils/trade-mode";

type ChatMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

type ChatResponse = {
  choices?: Array<{ message?: { content?: string } }>;
};

const OFFLINE_NOTE = "（操盘手离线值班：当前未接入 AI，以下是按你的纪律和盘面本地算出的参考，话一样直接，但判断请以实盘为准。）\n";

/** SSE 帧：data: {json}\n\n */
function sseFrame(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

/** 把多个帧拼成一个 SSE Response */
function sseResponse(frames: Array<{ type: string; content?: string; mode?: string }>): Response {
  const body = frames.map((f) => sseFrame(f)).join("");
  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

/**
 * 多轮上下文摘要：把最旧的历史对话交给 AI 压成一条摘要（保留用户目标、
 * 持仓、已给结论、风险偏好），避免长对话丢前文。独立小请求，失败返回 null。
 */
async function summarizeHistory(messages: ChatMessage[], ai: AiConfig): Promise<string | null> {
  try {
    const text = messages
      .map((m) => `${m.role}: ${m.content}`)
      .join("\n")
      .slice(-4000);
    const response = await fetch(`${ai.apiBase}/chat/completions`, {
      method: "POST",
      signal: AbortSignal.timeout(12_000),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ai.apiKey}`,
      },
      body: JSON.stringify({
        model: ai.model,
        // 摘要要的是忠实压缩，不是发挥，温度压低
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content:
              "把下面的对话历史压缩成不超过150字的中文摘要，只保留对后续判断仍有价值的信息：用户持有的股票、已给出的买卖结论、关键价位、用户的风险偏好与纪律。只输出摘要正文，不要任何前缀、不要寒暄。",
          },
          { role: "user", content: text },
        ],
      }),
    });
    if (!response.ok) return null;
    const result = (await response.json().catch(() => null)) as ChatResponse | null;
    const summary = result?.choices?.[0]?.message?.content?.trim();
    return summary ? summary.slice(0, 300) : null;
  } catch {
    return null;
  }
}

/**
 * 服务端持仓抓取：无论前端是否传入 position，都从 D1 读取当前登录用户的真实持仓，
 * 用 calculatePortfolio 算股数与成本均价，避免前端大屏/浮窗拿不到结构化持仓的问题。
 * 返回结构化持仓（用于回填 ctx.position）与一段汇总文本（用于注入 system，让 AI 总能看到完整持仓）。
 */
async function getServerHoldings(userId: number): Promise<{
  positions: Array<{ symbol: string; name: string; quantity: number; averageCostTenThousandths: number; costCents: number }>;
  text: string;
  totalCostCents: number;
} | null> {
  try {
    const rows = await getDb().select().from(tradeRecords).where(eq(tradeRecords.userId, userId));
    if (!rows.length) return null;
    const mapped: Trade[] = rows.map((r) => ({
      id: r.id,
      symbol: r.symbol,
      name: r.name,
      side: r.side as "买入" | "卖出",
      priceCents: r.priceCents,
      priceMillis: r.priceMillis ?? null,
      priceTenThousandths: r.priceTenThousandths ?? null,
      quantity: r.quantity,
      tradeDate: r.tradeDate,
      reason: r.reason,
      maxLossCents: null,
      feeCents: 0,
    }));
    const portfolio = calculatePortfolio(mapped);
    if (!portfolio.positions.length) return null;
    const positions = portfolio.positions.map((p) => ({
      symbol: p.symbol,
      name: p.name,
      quantity: p.quantity,
      averageCostTenThousandths: p.averageCostTenThousandths,
      costCents: Math.round((p.averageCostTenThousandths / 10_000) * p.quantity * 100),
    }));
    const totalCostCents = positions.reduce((sum, p) => sum + p.costCents, 0);
    const text = positions
      .map(
        (p) =>
          `${p.name}(${p.symbol}) ${p.quantity}股，成本均价¥${(p.averageCostTenThousandths / 10_000).toFixed(3)}`,
      )
      .join("；");
    return { positions, text, totalCostCents };
  } catch {
    return null;
  }
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
      }).slice(-14) // 多给几条历史，让后端有摘要空间
    : [];

  let prefs: TradingPreferences = DEFAULT_PREFERENCES;
  let serverHoldings: Awaited<ReturnType<typeof getServerHoldings>> = null;
  try {
    await ensureSchema();
    prefs = await fetchPreferences(getDb(), user.id);
    serverHoldings = await getServerHoldings(user.id);
  } catch {
    // 偏好缺失或服务端持仓抓取失败：退回默认纪律，不影响对话
  }

  // 用服务端真实持仓补充前端 context：前端大屏/浮窗往往 position=null，导致 AI 拿不到股数/成本。
  // 这里回填当前 context 股票（若有持仓）的 position，并准备全持仓汇总文本注入 system。
  const ctx = payload.context as AssistantContext;
  if (serverHoldings && !ctx.position) {
    const focus = serverHoldings.positions.find((p) => p.symbol === ctx.stock.code);
    if (focus) {
      // 后端无实时行情价时无法算精确的"市值/总资产"占比，这里用成本口径（持仓成本/总持仓成本）
      // 作为集中度参考，并明确标注口径，避免 AI 拿不到占比数据而编造（如 2010%）。
      const costBasedPercent = serverHoldings!.totalCostCents > 0
        ? (focus.costCents / serverHoldings!.totalCostCents) * 100
        : null;
      ctx.position = {
        quantity: focus.quantity,
        averageCost: focus.averageCostTenThousandths / 10_000,
        returnPercent: null,
        stockPositionPercent: costBasedPercent,
        stockPositionPercentNote: "按成本口径估算(持仓成本/总持仓成本)，非实时市值占比",
      };
    }
  }
  const serverHoldingsText = serverHoldings?.text;
  const fallback = buildFallbackAnswer(question, ctx, prefs);
  const ai = getAiConfig();
  if (!ai.configured) {
    // 无 AI：一次性输出 fallback（SSE 协议一致，前端无需分支）
    return sseResponse([
      { type: "delta", content: OFFLINE_NOTE + fallback },
      { type: "done", mode: "fallback" },
    ]);
  }

  // 多轮摘要：历史超过 10 条时，最旧的（除最近 4 条原文）交给 AI 压成摘要
  let history: ChatMessage[] = messages;
  if (messages.length > 10) {
    const old = messages.slice(0, messages.length - 4);
    const recent = messages.slice(-4);
    const summary = await summarizeHistory(old, ai);
    history = summary ? [{ role: "system", content: `此前对话摘要：${summary}` }, ...recent] : recent;
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${ai.apiBase}/chat/completions`, {
      method: "POST",
      // 流式生成通常 15~40s，25s 容易在生成途中被掐断，放宽到 60s
      signal: AbortSignal.timeout(60_000),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ai.apiKey}`,
      },
      body: JSON.stringify({
        model: ai.model,
        // 0.6：既保留“果断、敢于给方向”的操盘手风格，又不至于失控乱给结论。
        // 过低(0.2)会让回答偏保守、模式化，与硬约束要求的直给动作相悖。
        temperature: 0.6,
        stream: true,
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
              "5. 持仓建议是重点：只要用户持有该股，必须把四件事讲死讲明、不许含糊——①止盈：价格到哪个价位/满足什么条件就卖（给具体价或明确条件）；②止损：跌破哪个价位必须砍（给具体止损价，不犹豫）；③加仓(买入)：满足什么条件才加、给触发价与上限；④减仓/卖出：什么情况减、什么情况清。能买/能加就明说“买/加”，不能就明说“不买/不加”，绝不用“可以考虑”“视情况”糊弄；最终结论只能是买/加仓/持有/减仓/清仓中的一个明确动作，不许两头下注。违反纪律（如单股仓位过重、该止损不止损）要直接点名批评，不留情面。",
              "6. 回答固定四段，且必须用 Markdown 三级标题（###）起头、顺序一致：\n### 结论\n（一句话亮明动作与态度，干脆别铺垫）\n### 依据\n（点出具体数字及其数据时间）\n### 风险与缺口\n（列明未核验信息与数据缺口）\n### 下一步\n（可执行动作与触发条件）。不得把四段揉进一段，标题不可省略。",
              "7. 不超过500字，干净利索、不绕弯、不啰嗦，口语化、少重复免责声明，把话说到点子上。",
              "8. 仓位建议必须展示计算：风险每股=max(当前价-支撑线,当前价×3%)；单笔可亏=总资产×max_loss_percent%；建议股数=单笔可亏÷风险每股，且≤可用现金、单股≤总资产×max_concentration_percent%；成数=建议金额÷总资产。数字只来自 context，缺失如实说明。",
              "9. 下方的【我的交易纪律与风险偏好】是硬约束，必须优先生效，不得再用固定的 2%/30% 规则；当 enforce_stop_loss=是 时，任何买入动作都必须先给出止损位，跌破即执行。",
              "10. 【技术面为主，基本面按实际可得性使用】基本面是否可得，一律以下方 context 的“财务”行实际内容为准，不得预设它一定缺失：凡是 context 里给出了数值的字段（营收增长/利润增长/负债率/PE/PB/ROE 等），都必须在【依据】里明确引用并参与判断，不许无视已有数据、更不许笼统宣称“基本面缺失”。只有当某项确实显示“数据缺失”时，才对该项说明缺失。K线/成交量/MACD/RSI/KDJ/支撑阻力始终稳定可得，因此在基本面确实不足时，以走势结构（均线多头/空头、价格与支撑阻力的位置）、量能（放量突破/缩量回调/量价背离）、动能指标（MACD金叉死叉、RSI超买超卖、KDJ）为主要评判依据，并注明“基本面数据缺失，以下判断以技术面为主”。任何情况下都不得编造财务数字。",
              "11. 【解释深度自适应】根据用户提问的措辞调整解释深度：问法偏入门（如“什么是支撑位”）就用大白话先讲清概念再给结论；用专业术语提问就直接讲要点、少铺垫。但无论深浅，结论都要落到明确的买卖建议与量化动作上。",
              "12. 【金额/价格一律以阿拉伯数字+单位原样照抄，禁止任何变形，严禁中文大写】context 中所有金额、价格、成本、总资产、现金、仓位%、收益率等数字，系统只给阿拉伯数字（如“¥344.96”“97.87%”）。你回复时必须原样照抄这些阿拉伯数字，禁止改写成中文大写（如“叁佰肆拾肆元玖角陆分”“玖拾柒点捌捌百分比”“贰拾点陆百分比”一律禁止出现）。尤其严禁删掉小数点（344.96 写成 34496 等于凭空放大 100 倍、97.87% 写成 9787% 同理）、禁止省略数字（如“现金只剩 .96 元”“占 .67%”“止损 16. 元”都是丢失数字的严重违规）、禁止四舍五入改变精度、禁止变换量级（万/千）或写成“三百多元”“约345元”等模糊表述。成本/股价/止损价/总资产/盈利等所有数字同样适用。任何数字丢失、变形或中文大写化都属违规。",
              "【反幻觉示例】用户问“茅台 PE 多少、能买吗”而 pe=数据缺失 → 正确回答：“PE 数据缺失，我不凭记忆给你编数。没有估值和账户资金，谁让你现在拍脑袋买谁就是害你；先把账户资金补全、仓位和止损设好，再来谈买不买。”",
              "【我的交易纪律与风险偏好，必须优先遵守，替代任何固定百分比】",
              `risk_profile=${prefs.riskProfile}`,
              `max_loss_percent=${prefs.maxLossPercent}`,
              `max_concentration_percent=${prefs.maxConcentrationPercent}`,
              `max_position_percent=${prefs.maxPositionPercent}`,
              `enforce_stop_loss=${prefs.enforceStopLoss ? "是（任何买入必须先设止损）" : "否（由用户自行决定）"}`,
              `discipline_note=${prefs.disciplineNote || "（未填写）"}`,
              tradeModePrompt(prefs.tradeMode, "act"),
              `context=\n${summarizeContext(ctx, serverHoldingsText)}`,
            ].join("\n"),
          },
          ...history,
          { role: "user", content: question },
        ],
      }),
    });
    if (!upstream.ok || !upstream.body) {
      return sseResponse([
        { type: "delta", content: OFFLINE_NOTE + fallback },
        { type: "done", mode: "fallback" },
      ]);
    }
  } catch {
    return sseResponse([
      { type: "delta", content: OFFLINE_NOTE + fallback },
      { type: "done", mode: "fallback" },
    ]);
  }

  // 把上游 OpenAI 兼容 SSE 流逐 delta 转发为 {type:"delta"} 帧
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let full = "";
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const payload = trimmed.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            try {
              const parsed = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> };
              const delta = parsed?.choices?.[0]?.delta?.content;
              if (typeof delta === "string" && delta) {
                full += delta;
                controller.enqueue(encoder.encode(sseFrame({ type: "delta", content: delta })));
              }
            } catch {
              // 跳过无法解析的帧
            }
          }
        }
        // 上游空响应（模型没吐任何字）：回退到本地兜底，避免前端拿到空回复
        if (!full.trim()) {
          controller.enqueue(encoder.encode(sseFrame({ type: "delta", content: OFFLINE_NOTE + fallback })));
        }
        controller.enqueue(encoder.encode(sseFrame({ type: "done", mode: full.trim() ? "ai" : "fallback" })));
      } catch {
        // 上游中途断流：已收到的内容保留；有内容时发 interrupted 帧让前端标注
        // "回复可能不完整"，没内容时前端会自动走空响应兜底。
        if (full.trim()) {
          controller.enqueue(encoder.encode(sseFrame({ type: "interrupted" })));
        }
        controller.enqueue(encoder.encode(sseFrame({ type: "done", mode: full.trim() ? "ai" : "fallback" })));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
