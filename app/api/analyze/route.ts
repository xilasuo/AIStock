import { ensureSchema, getDb } from "../../../db";
import { analysisReports } from "../../../db/schema";
import { analyzeStockData, automaticExplanation } from "../../../lib/domain/stocks";
import { getAiConfig } from "../../../lib/ai/ai-config";
import { getCurrentUser, requireApiUser } from "../../../lib/auth/auth";
import { DEFAULT_PREFERENCES, fetchPreferences } from "../../../lib/utils/preferences";
import { tradeModePrompt } from "../../../lib/utils/trade-mode";
import { isValidContext, type AssistantContext } from "../../../lib/ai/assistant";
import { generateStrategy } from "../../../lib/ai/trading-strategy";
import { saveStrategySuggestion } from "../../../lib/strategy-suggestions";
import { shanghaiIso } from "../../../lib/utils/time";

type DeepSeekResponse = {
  choices?: Array<{ message?: { content?: string } }>;
};

type Explanation = ReturnType<typeof automaticExplanation>;

/** 空话黑名单：summary 若只含这些词且不带任何数字，判定为无效输出，回退规则版 */
const EMPTY_TALK_RE = /(需注意风险|谨慎|控制仓位|存在不确定性|建议关注|请结合自身情况|仅供参考)/;
const HAS_DIGIT_RE = /\d/;

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
      && !(EMPTY_TALK_RE.test(candidate.summary) && !HAS_DIGIT_RE.test(candidate.summary))
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
  // 预计算「可信数字」：距离百分比等换算在服务端完成，模型只逐字引用、禁止自行计算，
  // 从源头消除模型算错数/编数字的风险。
  const safePct = (numerator: number, denominator: number): number | null =>
    Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0
      ? (numerator / denominator) * 100
      : null;
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
    /** 预计算的位置关系（百分比），供 summary 直接引用 */
    position: {
      priceToSupportPct: safePct(quote.price - quote.support, quote.price),
      priceToResistancePct: safePct(quote.resistance - quote.price, quote.price),
      vsMa20Pct: safePct(quote.price - quote.ma20, quote.ma20),
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
              "summary 是板块的灵魂，必须是一句**有信息增量**的大白话，按以下四要素组织：",
              "① 行业/身份（如“半导体”）；② 价格相对关键位：必须引用 position 字段（priceToSupportPct / priceToResistancePct / vsMa20Pct）给出**带数字的姿态**，如“站上20日线+2.1%、距阻力位仅4.3%”；③ 量能/动能：必须引用 volume.ratio、quote.volatility 等给出带数字的状态，如“量比1.8放量、20日波动3.2%”，并结合 MACD/RSI/KDJ 姿态（金叉/超买/背离）给出**比较级判断**（偏强/偏弱/动能占优/上攻空间有限/风险大于收益）；④ 结尾给一个**可证伪的条件句**（若…则…），如“若放量突破阻力11.7则打开上行空间，否则缩量回踩支撑11.2前不宜追”。",
              "【数字可靠性·硬约束】summary 及所有字段中的数字必须逐字来自用户消息中的结构化数据（quote/position/financials/volume/oscillators），禁止自行换算、四舍五入改值、推算或编造；缺失字段写“数据缺失”。position 字段已由系统算好，直接引用即可，不得重新计算。",
              "【反空话·硬约束】“需注意风险”“谨慎”“控制仓位”“存在不确定性”“建议关注”“请结合自身情况”等空话**禁止单独出现**；使用前必须搭配具体数字或条件（如“距阻力仅4.3%，上攻空间有限”）。summary 若全是空话会被判定为无效输出。",
              "【判断放行】“偏强/偏弱/动能占优/上攻空间有限/风险大于收益/接近超买”等**比较级状态判断是允许且应当给出的**，它们是对事实的解读、不是买卖指令；允许的边界是不出现“买入/卖出/必涨/必跌/抄底/逃顶”等具体指令或确定性涨跌承诺。",
              "【回答风格】所有自然语言字段（summary、risks、themes 的 reason）必须干净利索、不绕弯、不罗嗦：直给要点、不堆砌套话、不用长难句；summary 严格一句有观点的大白话，不展开成段；risks/themes 只列关键项、不凑数量。",
              "5. 量价关系：必须结合 volume.ratio（量比）与 volume.divergence（量价背离）判断强弱。放量突破才可信，缩量上涨或高位放巨量滞涨需提示风险；当 divergence 为“顶背离”时，summary 与 themes 不得给出偏多结论；volume 字段缺失时对应输出写“量能数据缺失”。",
              "6. 摆动指标：facts 中的 oscillators（MACD/RSI/KDJ）仅作技术姿态参考。RSI>70 视为超买、<30 视为超卖，仅提示风险而非方向结论；MACD 金叉/死叉、KDJ 金叉/死叉、顶/底背离只作为“动能强弱”的依据；指标在强趋势中可能钝化失效，必须提示这一局限。超买区不盲目看多、超卖区不盲目看空，禁止据此给出确定性买卖措辞；字段缺失则对应输出写“摆动指标数据缺失”。",
              "7. 【技术面为主，基本面按实际可得性使用】营收增长/利润增长/负债率优先来自麦蕊智数，缺失时由新浪财报三表兜底；PE/PB 来自麦蕊/腾讯/东方财富；ROE/毛利率/净利率优先麦蕊，缺失时由新浪三表现算。凡 facts 中已给出数值的基本面字段必须引用并参与解读，不得预设其缺失、也不得笼统宣称“基本面缺失”；仅对确实为空的项写“数据缺失”，不得编造。summary 与 risks 的解读以走势结构（价格相对均线、支撑阻力）、量能、动能指标为**主要依据**；当基本面确实不足时注明“基本面数据缺失，以下解读以技术面为主”，并照常给出走势、量价、动能层面的解读。",
              "【用户风险偏好与交易纪律（仅供参考，不改变上述不得荐股、不得下达买卖指令的硬约束）】",
              `risk_profile=${prefs.riskProfile}`,
              `max_loss_percent=${prefs.maxLossPercent}`,
              `max_concentration_percent=${prefs.maxConcentrationPercent}`,
              `max_position_percent=${prefs.maxPositionPercent}`,
              `enforce_stop_loss=${prefs.enforceStopLoss ? "是" : "否"}`,
              `discipline_note=${prefs.disciplineNote || "（未填写）"}`,
              "解读时可结合上述风险偏好做个性化表述（例如当前波动是否明显大于其单笔可亏阈值、该股是否可能触及单股集中度上限），但只做提示、不给买卖建议，且不得编造任何数字。",
              tradeModePrompt(prefs.tradeMode, "read"),
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

    // 生成策略且前端已带上一次分析得到的 context 时，直接复用该上下文生成策略，
    // 跳过 analyzeStockData 的整条远程行情链路（避免重复拉取、双重等待）。
    if (payload.strategy && isValidContext(payload.context)) {
      const result: Record<string, unknown> = {};
      try {
        let prefs = DEFAULT_PREFERENCES;
        try {
          await ensureSchema();
          prefs = await fetchPreferences(getDb(), user.id);
        } catch {
          // 偏好缺失时退回默认纪律
        }
        const strategy = await generateStrategy(payload.context as AssistantContext, prefs);
        Object.assign(result, { strategy });
        // 自动入库建议追踪
        try {
          const ctx = payload.context as AssistantContext;
          await saveStrategySuggestion({
            userId: user.id, symbol: ctx.stock.code, name: ctx.stock.name,
            price: ctx.quote.price, result: strategy, context: payload.context,
          });
        } catch { /* 入库失败不影响主流程 */ }
      } catch {
        Object.assign(result, { strategyWarning: "操盘策略暂时无法生成（AI 未配置或服务异常），其余分析不受影响。" });
      }
      return Response.json(result);
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
          Object.assign(result, { strategy });
          // 自动入库建议追踪
          try {
            await saveStrategySuggestion({
              userId: user.id, symbol: facts.stock.code, name: facts.stock.name,
              price: facts.quote.price, result: strategy, context: payload.context,
            });
          } catch { /* 入库失败不影响主流程 */ }
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
