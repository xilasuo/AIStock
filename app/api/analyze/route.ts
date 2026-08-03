import { ensureSchema, getDb } from "../../../db";
import { analysisReports } from "../../../db/schema";
import { analyzeStockData, automaticExplanation } from "../../../lib/stocks";
import { getAiConfig } from "../../../lib/ai-config";
import { getCurrentUser, requireApiUser } from "../../../lib/auth";
import { DEFAULT_PREFERENCES, fetchPreferences } from "../../../lib/preferences";
import { isValidContext, type AssistantContext } from "../../../lib/assistant";
import { generateStrategy } from "../../../lib/trading-strategy";
import { shanghaiIso } from "../../../lib/time";

type DeepSeekResponse = {
  choices?: Array<{ message?: { content?: string } }>;
};

type Explanation = ReturnType<typeof automaticExplanation>;

function normalizeExplanation(value: unknown, fallback: Explanation): Explanation {
  if (!value || typeof value !== "object") return fallback;
  const candidate = value as Record<string, unknown>;
  const strings = (input: unknown, limit: number) =>
    Array.isArray(input)
      ? input.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, limit)
      : [];
  const company = strings(candidate.company, 6);
  const risks = strings(candidate.risks, 8);
  const missingInformation = strings(candidate.missingInformation, 8);
  const themes = Array.isArray(candidate.themes)
    ? candidate.themes.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const theme = item as Record<string, unknown>;
        if (typeof theme.name !== "string" || typeof theme.reason !== "string") return [];
        return [{
          name: theme.name,
          confidence: typeof theme.confidence === "string" ? theme.confidence : "待核验",
          reason: theme.reason,
        }];
      }).slice(0, 8)
    : [];

  return {
    summary: typeof candidate.summary === "string" && candidate.summary.trim()
      ? candidate.summary.slice(0, 600)
      : fallback.summary,
    company: company.length ? company : fallback.company,
    risks: risks.length ? risks : fallback.risks,
    themes: themes.length ? themes : fallback.themes,
    missingInformation,
  };
}

function slimFactsForPrompt(facts: Awaited<ReturnType<typeof analyzeStockData>>) {
  const { stock, quote, financials } = facts;
  return {
    stock: {
      code: stock.code,
      name: stock.name,
      industry: stock.industry,
      instrumentType: stock.instrumentType,
      sector: stock.sector ?? null,
    },
    quote: {
      price: quote.price,
      previousClose: quote.previousClose,
      changePercent: quote.changePercent,
      ma5: quote.ma5,
      ma20: quote.ma20,
      ma60: quote.ma60,
      recentHigh: quote.recentHigh,
      recentLow: quote.recentLow,
      support: quote.support,
      resistance: quote.resistance,
      volatility: quote.volatility,
      target1: quote.target1,
      target2: quote.target2,
      marketTime: quote.marketTime,
    },
    financials: {
      revenueGrowth: financials.revenueGrowth,
      profitGrowth: financials.profitGrowth,
      debtRatio: financials.debtRatio,
      marketCap: financials.marketCap,
      pe: financials.pe,
      pb: financials.pb,
      roe: financials.roe,
      grossMargin: financials.grossMargin,
      profitMargin: financials.profitMargin,
    },
    volume: {
      latest: facts.volume.latest,
      ma5: facts.volume.ma5,
      ma20: facts.volume.ma20,
      ratio: facts.volume.ratio,
      divergence: facts.volume.divergence,
      upDaysWithVolume: facts.volume.upDaysWithVolume,
      downDaysWithVolume: facts.volume.downDaysWithVolume,
    },
    oscillators: facts.oscillators,
  };
}

async function getDeepSeekExplanation(
  facts: Awaited<ReturnType<typeof analyzeStockData>>,
  userId: number,
  screenerContext?: { code: string; name: string; score: number; momentum: number; peTtm: number; pb: number; turnover: number; signals: number; rsi?: number; riskAdjMomentum?: number; trend?: number; factors?: Record<string, number>; sector?: string },
) {
  const fallback = automaticExplanation(facts);
  const ai = getAiConfig();
  if (!ai.configured) {
    return { mode: "automatic" as const, explanation: fallback };
  }

  let prefs = DEFAULT_PREFERENCES;
  try {
    await ensureSchema();
    prefs = await fetchPreferences(getDb(), userId);
  } catch {
    // 偏好缺失时退回默认纪律
  }

  let response: Response;
  try {
    response = await fetch(`${ai.apiBase}/chat/completions`, {
      method: "POST",
      signal: AbortSignal.timeout(20_000),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ai.apiKey}`,
      },
      body: JSON.stringify({
        model: ai.model,
        response_format: { type: "json_object" },
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content: [
              "你是个人股票复盘工具中的信息解释助手，服务于炒股新手。",
              "【硬约束】",
              "1. 只能使用用户提供的 facts 字段中的数字，禁止推算、插值或编造任何估值、价格或结论。",
              "2. facts 中为 null 或缺失的字段，对应输出必须写“数据缺失”，禁止用行业常识填补。",
              "3. 不荐股，不出现“必涨、买入、卖出、抄底、逃顶、必跌”等确定性措辞。",
              "4. 输出严格为 JSON，字段必须包含：summary、company、risks、themes、missingInformation。",
              "【confidence 取值规范】已核验=来自ETF资料或公告级字段；较强=由行情/财务等结构化数据直接得出；中=板块分类推断；待核验=关键词模糊匹配的概念题材，必须注明“需以公告为准”。",
              "【themes 要求】至少输出“行业本身 + 1-2 个概念板块”（如人工智能、新能源、高股息），不要把行业名重复当作概念。",
              "【示例】行业=半导体 时，themes 应类似：[{name:\"半导体\",confidence:\"较强\",reason:\"主营所属行业为半导体\"},{name:\"国产替代\",confidence:\"待核验\",reason:\"与半导体相关的常见概念，需以公告为准\"}]。",
              "summary 用一句有观点的大白话：属于什么行业、价格相对20日均线的位置与强弱、波动大小，并点明当前技术姿态（如“站上均线偏强”或“跌破均线偏弱”）；不下达买卖指令，但可结合下方【用户风险偏好与交易纪律】提示与用户风险承受度或交易计划的关系（如近20日波动是否明显超出其单笔可亏阈值、该股若建仓是否会触及单股集中度上限）。",
              "5. 量价关系：必须结合 volume.ratio（量比）与 volume.divergence（量价背离）判断强弱。放量突破才可信，缩量上涨或高位放巨量滞涨需提示风险；当 divergence 为“顶背离”时，summary 与 themes 不得给出偏多结论；volume 字段缺失时对应输出写“量能数据缺失”。",
              "6. 摆动指标：facts 中的 oscillators（MACD/RSI/KDJ）仅作技术姿态参考。RSI>70 视为超买、<30 视为超卖，仅提示风险而非方向结论；MACD 金叉/死叉、KDJ 金叉/死叉、顶/底背离只作为“动能强弱”的依据；指标在强趋势中可能钝化失效，必须提示这一局限。超买区不盲目看多、超卖区不盲目看空，禁止据此给出确定性买卖措辞；字段缺失则对应输出写“摆动指标数据缺失”。",
              "7. 【技术面为主，基本面按可得性降级】营收增长/利润增长/负债率优先来自麦蕊智数（原生 A 股源），PE/PB 来自腾讯/东方财富，ROE/毛利/净利率来自麦蕊或东财主指标；任一指标缺失即写“数据缺失”，不得编造。summary 与 risks 的解读以走势结构（价格相对均线、支撑阻力）、量能、动能指标为**主要依据**；基本面缺失时不因此拒绝解读，而应注明“基本面数据缺失，以下解读以技术面为主”，并照常给出走势、量价、动能层面的解读。",
              "【用户风险偏好与交易纪律（仅供参考，不改变上述不得荐股、不得下达买卖指令的硬约束）】",
              `risk_profile=${prefs.riskProfile}`,
              `max_loss_percent=${prefs.maxLossPercent}`,
              `max_concentration_percent=${prefs.maxConcentrationPercent}`,
              `max_position_percent=${prefs.maxPositionPercent}`,
              `enforce_stop_loss=${prefs.enforceStopLoss ? "是" : "否"}`,
              `discipline_note=${prefs.disciplineNote || "（未填写）"}`,
              "解读时可结合上述风险偏好做个性化表述（例如当前波动是否明显大于其单笔可亏阈值、该股是否可能触及单股集中度上限），但只做提示、不给买卖建议，且不得编造任何数字。",
              ...(screenerContext ? [
                "",
                "【选股榜单上下文（多因子打分结果）】",
                "以下数据来自用户使用的选股策略扫描结果，代表该股在候选池中的量化表现。你必须在 summary 中结合这些因子数据给出针对性解读，但不得据此给出买卖建议。字段含义与单位：",
                "- screenerScore: 综合选股得分（0~1，越高越优，按策略权重加权各归一化因子得出）",
                "- momentum20d: 20 日动量，小数形式（0.05 表示 20 日涨 5%，可为负）",
                "- rsi: RSI 指标（0~100，>70 超买，<30 超卖）",
                "- riskAdjMomentum: 风险调整动量（0~1，剔除高波动后的动量强度）",
                "- trend: 趋势强度（0~1，越高趋势越明确向上）",
                "- peTtm: 动态市盈率（倍）",
                "- pb: 市净率（倍）",
                "- turnoverPct: 换手率（百分比数值，如 3.5 表示 3.5%）",
                "- signalCount: 该技术策略触发的买卖信号数量（0 表示无信号）",
                "- sector: 所属行业",
                "- factors: 各因子归一化得分字典（0~1，键含 momentum/rsi/macd/trend/value/liquidity/size/quality，值越高代表该因子表现越强）",
                "原始数据：",
                JSON.stringify({
                  screenerScore: screenerContext.score,
                  momentum20d: screenerContext.momentum,
                  rsi: screenerContext.rsi ?? null,
                  riskAdjMomentum: screenerContext.riskAdjMomentum ?? null,
                  trend: screenerContext.trend ?? null,
                  peTtm: screenerContext.peTtm,
                  pb: screenerContext.pb,
                  turnoverPct: screenerContext.turnover,
                  signalCount: screenerContext.signals,
                  sector: screenerContext.sector ?? null,
                  factors: screenerContext.factors ?? null,
                }),
              ] : []),
            ].join("\n"),
          },
          {
            role: "user",
            content: JSON.stringify(slimFactsForPrompt(facts)),
          },
        ],
      }),
    });
  } catch {
    return { mode: "automatic" as const, explanation: fallback };
  }

  if (!response.ok) {
    return { mode: "automatic" as const, explanation: fallback };
  }
  const payload = await response.json().catch(() => null) as DeepSeekResponse | null;
  const content = payload?.choices?.[0]?.message?.content;
  if (!content) {
    return { mode: "automatic" as const, explanation: fallback };
  }

  const cleaned = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    return { mode: "deepseek" as const, explanation: normalizeExplanation(JSON.parse(cleaned), fallback) };
  } catch {
    return { mode: "automatic" as const, explanation: fallback };
  }
}

export async function POST(request: Request) {
  const unauthorized = await requireApiUser();
  if (unauthorized) return unauthorized;
  try {
    const user = await getCurrentUser();
    const payload = await request.json() as {
      query?: string;
      saveHistory?: boolean;
      explain?: boolean;
      strategy?: boolean;
      /** 强制绕过行情缓存，重新拉取最新价（"重新分析"按钮） */
      force?: boolean;
      context?: unknown;
      /** 选股榜单行数据（点击"分析"时传入的因子打分上下文） */
      screenerContext?: {
        code: string; name: string; score: number; momentum: number;
        peTtm: number; pb: number; turnover: number; signals: number;
        rsi?: number; riskAdjMomentum?: number; trend?: number;
        factors?: Record<string, number>; sector?: string;
      };
    };
    const query = payload.query?.trim() ?? "";
    if (!query || query.length > 30) {
      return Response.json({ error: "请输入有效的股票代码或名称" }, { status: 400 });
    }

    // force=true 时绕过行情缓存，强制重新拉取最新价（"重新分析"按钮）
    const facts = await analyzeStockData(query, payload.force === true);
    const analysis = payload.explain === false || facts.stock.instrumentType === "etf"
      ? { mode: "automatic" as const, explanation: automaticExplanation(facts) }
      : await getDeepSeekExplanation(facts, user.id, payload.screenerContext);
    const result = { ...facts, ...analysis };

    if (payload.strategy) {
      if (!isValidContext(payload.context)) {
        Object.assign(result, { strategyWarning: "缺少有效的分析上下文，无法生成操盘策略。" });
      } else {
        try {
          let prefs = DEFAULT_PREFERENCES;
          try {
            await ensureSchema();
            prefs = await fetchPreferences(getDb(), user.id);
          } catch {
            // 偏好缺失时退回默认纪律
          }
          const strategy = await generateStrategy(payload.context as AssistantContext, prefs);
          Object.assign(result, { strategy: { content: strategy.content, mode: strategy.mode } });
        } catch {
          Object.assign(result, { strategyWarning: "操盘策略暂时无法生成（AI 未配置或服务异常），其余分析不受影响。" });
        }
      }
    }

    if (payload.saveHistory) {
      try {
        await ensureSchema();
        await getDb().insert(analysisReports).values({
          userId: user.id,
          symbol: facts.stock.code,
          name: facts.stock.name,
          priceCents: Math.round(facts.quote.price * 100),
          priceMillis: Math.round(facts.quote.price * 1000),
          marketTime: facts.quote.marketTime,
          source: facts.source.name,
          mode: analysis.mode,
          summary: analysis.explanation.summary,
          reportJson: JSON.stringify(result),
          createdAt: shanghaiIso(),
        });
      } catch {
        return Response.json({ ...result, historyWarning: "分析结果正常，但本次历史记录未保存。" });
      }
    }
    return Response.json(result);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("暂时无法按名称识别")) {
      // 用户输入无法识别的股票名/代码：属于客户端错误，返回 400 而非 502
      return Response.json({ error: error.message }, { status: 400 });
    }
    return Response.json(
      { error: "股票分析暂时不可用，请稍后重试" },
      { status: 502 },
    );
  }
}
