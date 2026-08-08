"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowUp, Bot, Trash2, X } from "lucide-react";
import { calculatePortfolio } from "../../lib/domain/domain";
import type { PortfolioInsights } from "../../lib/domain/portfolio-insights";
import type { AssistantContext } from "../../lib/ai/assistant";
import { splitAssistantSections, conclusionTone } from "../../lib/ai/assistant";
import { formatDateTimeShanghai, shanghaiIso } from "../../lib/utils/time";
import { MarkdownMessage } from "./MarkdownMessage";

type Analysis = {
  stock: {
    code: string;
    name: string;
    industry: string;
    instrumentType: "stock" | "etf";
  };
  quote: {
    price: number;
    changePercent: number;
    ma20: number;
    support: number;
    resistance: number;
    volatility: number;
    marketTime: string | null;
  };
  financials: {
    revenueGrowth: number | null;
    profitGrowth: number | null;
    debtRatio: number | null;
    pe: number | null;
    pb: number | null;
    roe: number | null;
  };
  explanation: {
    summary: string;
    risks: string[];
    missingInformation: string[];
  };
  volume: unknown;
  oscillators?: unknown;
  source: {
    name: string;
    fetchedAt: string;
  };
  history: Array<{
    date: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    ma5: number | null;
    ma20: number | null;
    ma60: number | null;
  }>;
};

type QuoteEntry = Pick<Analysis, "stock" | "quote" | "history">;
type Position = ReturnType<typeof calculatePortfolio>["positions"][number];

type AssistantMessage = {
  id?: string;
  role: "user" | "assistant";
  content: string;
  mode?: "ai" | "fallback";
  // 标记为开场迎新消息，渲染时跳过「复制 / 换一版」——迎新内容是固定模板，
  // 重生成没有意义、复制也没有价值，只会让页面看起来更杂乱。
  kind?: "primer";
  error?: boolean;
  // 流式生成中：内容逐步追加，渲染时光标动画提示“正在生成”
  streaming?: boolean;
  // 当某条 assistant 消息是失败占位时，保留用户原始问题以便点"重试"复用
  pendingQuestion?: string;
  /** 该回复基于的数据时间（context.source.fetchedAt），渲染时效标注，避免旧快照误导 */
  fetchedAt?: string;
  /** 流式生成被上游中断（已收到部分内容但未正常收尾），渲染"回复可能不完整" */
  interrupted?: boolean;
};

let assistantMessageCounter = 0;
const nextId = () => {
  assistantMessageCounter += 1;
  if (typeof globalThis !== "undefined" && "crypto" in globalThis && "randomUUID" in globalThis.crypto) {
    return `${Date.now().toString(36)}-${globalThis.crypto.randomUUID().slice(0, 8)}`;
  }
  return `${Date.now().toString(36)}-${(assistantMessageCounter).toString(36)}`;
};

export function buildAnalysisContext(
  analysis: Analysis,
  position: Position | null,
  portfolioInsights: PortfolioInsights,
) {
  const positionContext = position ? {
    quantity: position.quantity,
    averageCost: position.averageCostTenThousandths / 10_000,
    returnPercent: ((analysis.quote.price * 10_000 / position.averageCostTenThousandths) - 1) * 100,
    stockPositionPercent: portfolioInsights.positions.find((item) => item.symbol === position.symbol)?.allocationPercent ?? null,
  } : null;
  return {
    stock: {
      code: analysis.stock.code,
      name: analysis.stock.name,
      industry: analysis.stock.industry,
      instrumentType: analysis.stock.instrumentType,
    },
    quote: {
      price: analysis.quote.price,
      changePercent: analysis.quote.changePercent,
      ma20: analysis.quote.ma20,
      support: analysis.quote.support,
      resistance: analysis.quote.resistance,
      volatility: analysis.quote.volatility,
      marketTime: analysis.quote.marketTime,
    },
    financials: {
      revenueGrowth: analysis.financials.revenueGrowth,
      profitGrowth: analysis.financials.profitGrowth,
      debtRatio: analysis.financials.debtRatio,
      pe: analysis.financials.pe,
      pb: analysis.financials.pb,
      roe: analysis.financials.roe,
    },
    summary: analysis.explanation.summary,
    risks: analysis.explanation.risks,
    missingInformation: analysis.explanation.missingInformation,
    volume: analysis.volume,
    oscillators: analysis.oscillators ?? null,
    source: { name: analysis.source.name, fetchedAt: analysis.source.fetchedAt },
    position: positionContext,
    portfolio: {
      totalAssets: portfolioInsights.totalAssetsCents === null ? null : portfolioInsights.totalAssetsCents / 100,
      cash: portfolioInsights.cashCents === null ? null : portfolioInsights.cashCents / 100,
      totalPositionPercent: portfolioInsights.totalPositionPercent,
      totalProfitPercent: portfolioInsights.totalProfitPercent,
    },
  };
}

// 当浮窗不在分析页时，用占位股票 + 真实账户数据拼一个能通过
// isValidContext 校验的 context。后端与原有 /api/assistant 逻辑完全不改，
// AI 在 system 约束下会如实说明「未关联具体股票」，不会编造个股数字。
function buildPlaceholderContext(
  portfolioInsights: PortfolioInsights,
): AssistantContext {
  const holdingsSummary = portfolioInsights.positions.length > 0
    ? portfolioInsights.positions.map((p) =>
        `${p.name}(${p.symbol}) ${p.allocationPercent?.toFixed(1) ?? "?"}%、回报${p.returnPercent >= 0 ? "+" : ""}${p.returnPercent.toFixed(1)}%`
      ).join("；")
    : "";
  return {
    stock: { code: "", name: "未选择股票", industry: "未关联", instrumentType: "stock" },
    quote: { price: 0, changePercent: 0, ma20: 0, support: 0, resistance: 0, volatility: 0, marketTime: null },
    financials: { revenueGrowth: null, profitGrowth: null, debtRatio: null, pe: null, pb: null, roe: null },
    summary: holdingsSummary
      ? `用户未选中具体股票。当前持有${portfolioInsights.positions.length}只：${holdingsSummary}。账户总仓位${portfolioInsights.totalPositionPercent?.toFixed(1) ?? "?"}%。`
      : "用户未在当前分析页选中具体股票，暂无持仓记录。",
    risks: [],
    missingInformation: ["未关联具体股票，无法提供个股行情与财务"],
    source: { name: "账户记录", fetchedAt: shanghaiIso() },
    position: null,
    holdingsSummary: portfolioInsights.positions.length > 0 ? holdingsSummary : undefined,
    portfolio: {
      totalAssets: portfolioInsights.totalAssetsCents === null ? null : portfolioInsights.totalAssetsCents / 100,
      cash: portfolioInsights.cashCents === null ? null : portfolioInsights.cashCents / 100,
      totalPositionPercent: portfolioInsights.totalPositionPercent,
      totalProfitPercent: portfolioInsights.totalProfitPercent,
    },
  };
}

// 大屏联动模式：仅拿到轻量个股数据（代码/名称/最新价/涨跌幅），
// 用它们构造一个最小合法 context，让 AI 围绕「当前 K 线正在看的这只票」作答。
function buildLinkedContext(
  linked: {
    code: string;
    name: string;
    price?: number;
    changePercent?: number;
    period?: string;
    range?: number;
    keyLevels?: import("../../lib/kline").Markers | null;
    lastBar?: { date: string; open: number; close: number; high: number; low: number } | null;
  },
  portfolioInsights: PortfolioInsights,
): AssistantContext {
  const hasPrice = Number.isFinite(linked.price);
  const changePercent = Number.isFinite(linked.changePercent) ? (linked.changePercent as number) : 0;
  const periodLabel =
    linked.period === "week" ? "周K" : linked.period === "month" ? "月K" : linked.period === "day" ? "日K" : "K线";
  const mk = linked.keyLevels;

  // 把大屏 K 线的全部关键价位/均线/双底结构化进 summary，让 AI 能基于这些指标做联动解读。
  const levelsText = mk
    ? [
        `泡沫顶(泡沫价)${mk.top.price.toFixed(2)}于${mk.top.date}${mk.top.isTrap ? "（上方为套牢陷阱）" : ""}`,
        `突破确认位${mk.breakout.toFixed(2)}`,
        mk.retest ? `回踩位${mk.retest.price.toFixed(2)}于${mk.retest.date}` : "无回踩位",
        `生死支撑${mk.support.toFixed(2)}`,
        `双底${mk.doubleBottom ? `支撑${mk.doubleBottom.support.toFixed(2)}/颈线${mk.doubleBottom.neck.toFixed(2)}（${mk.doubleBottom.dates[0]}~${mk.doubleBottom.dates[1]}）` : "无"}`,
        `均线 MA5/10/20/60/120=${[mk.ma5, mk.ma10, mk.ma20, mk.ma60, mk.ma120].map((v) => v.toFixed(2)).join("/")}`,
        `20MA扣抵位置：${mk.maPos}`,
      ].join("；")
    : "无关键价位数据";

  const lastBarText = linked.lastBar
    ? `最近一根(${linked.lastBar.date}) OHLC：开${linked.lastBar.open.toFixed(2)} 收${linked.lastBar.close.toFixed(2)} 高${linked.lastBar.high.toFixed(2)} 低${linked.lastBar.low.toFixed(2)}`
    : "无最新K线";

  const rangeText = linked.range && linked.range > 0 ? `最近${linked.range}根` : "全部";

  return {
    stock: { code: linked.code, name: linked.name, industry: "大屏联动", instrumentType: "stock" },
    quote: hasPrice
      ? { price: linked.price as number, changePercent, ma20: mk?.ma20 ?? 0, support: mk?.support ?? 0, resistance: mk?.breakout ?? 0, volatility: 0, marketTime: null }
      : { price: 0, changePercent: 0, ma20: mk?.ma20 ?? 0, support: mk?.support ?? 0, resistance: mk?.breakout ?? 0, volatility: 0, marketTime: null },
    financials: { revenueGrowth: null, profitGrowth: null, debtRatio: null, pe: null, pb: null, roe: null },
    summary: `大屏正在以${periodLabel}（${rangeText}）展示 ${linked.name}（${linked.code}），当日最新价 ${hasPrice ? (linked.price as number) : "未知"}，涨跌幅 ${changePercent.toFixed(2)}%。${lastBarText}。关键价位：${levelsText}。仅依据大屏 K 线联动数据作答，无完整财务/持仓分析。`,
    risks: [],
    missingInformation: ["大屏联动模式无完整财务/持仓数据，结论仅供参考；关键价位来自大屏 K 线 markers 自动识别"],
    source: { name: `大屏 K 线联动（${periodLabel}）`, fetchedAt: shanghaiIso() },
    position: null,
    portfolio: {
      totalAssets: portfolioInsights.totalAssetsCents === null ? null : portfolioInsights.totalAssetsCents / 100,
      cash: portfolioInsights.cashCents === null ? null : portfolioInsights.cashCents / 100,
      totalPositionPercent: portfolioInsights.totalPositionPercent,
      totalProfitPercent: portfolioInsights.totalProfitPercent,
    },
  };
}

const SECTION_LABELS: Record<string, string> = {
  conclusion: "结论",
  basis: "依据",
  risk: "风险与缺口",
  next: "下一步",
};

function AssistantAnswer({ content }: { content: string }) {
  const sections = useMemo(() => splitAssistantSections(content), [content]);
  const isStructured = sections.length >= 2 && sections.some((s) => s.kind !== "other");
  const [collapsed, setCollapsed] = useState<Record<number, boolean>>({});

  if (!isStructured) {
    return <MarkdownMessage content={content} />;
  }

  return (
    <div className="assistant-sections">
      {sections.map((section, index) => {
        const tone = section.kind === "conclusion" ? conclusionTone(section.body) : "neutral";
        const isCollapsible = section.kind !== "conclusion";
        const isCollapsed = isCollapsible && collapsed[index];
        return (
          <div
            key={`${section.kind}-${index}`}
            className={`assistant-section assistant-section--${section.kind}${section.kind === "conclusion" ? ` tone-${tone}` : ""}`}
          >
            <button
              type="button"
              className="assistant-section__head"
              onClick={() => isCollapsible && setCollapsed((prev) => ({ ...prev, [index]: !prev[index] }))}
              aria-expanded={!isCollapsed}
            >
              <span className="assistant-section__title">
                {section.kind !== "other" ? (SECTION_LABELS[section.kind] ?? section.title) : section.title}
              </span>
              {section.kind === "conclusion" && (
                <span className={`assistant-section__badge tone-${tone}`}>
                  {tone === "act" ? "可执行" : tone === "warn" ? "注意风险" : "信息"}
                </span>
              )}
              {isCollapsible && (
                <ChevronRightIcon className={`assistant-section__chevron${isCollapsed ? "" : " is-open"}`} />
              )}
            </button>
            {!isCollapsed && (
              <div className="assistant-section__body">
                <MarkdownMessage content={section.body} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ChevronRightIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

export default function SmartAssistant(
  {
    analysis,
    position,
    portfolioInsights,
    quotes,
    floating = false,
    page = false,
    compact = false,
    onClose,
    headerSlot,
    userId,
    onFetchStock,
    linkedStock,
    onFocusStock,
  }: {
    analysis: Analysis | null;
    position: Position | null;
    portfolioInsights: PortfolioInsights;
    /** 页面最新行情快照（每分钟轻量刷新），用于覆盖 context 里的旧价格，避免旧快照误导 */
    quotes?: Record<string, QuoteEntry>;
    floating?: boolean;
    // 移动端全屏对话页模式：占满视口、头部显示返回箭头而非收起叉
    page?: boolean;
    /** 紧凑模式：减小内边距与间距，适合嵌入在侧边窄栏/大屏卡片中 */
    compact?: boolean;
    onClose?: () => void;
    headerSlot?: ReactNode;
    userId?: string | number;
    /** 全局模式下若用户问某持仓股，前端先静默拉取数据再发问 */
    onFetchStock?: (code: string) => Promise<{ analysis: Analysis; position: Position | null } | null>;
    /** 大屏联动：当前 K 线主图正在展示的股票（轻量数据，AI 据此解读但不持有完整分析） */
    linkedStock?: {
      code: string;
      name: string;
      price?: number;
      changePercent?: number;
      period?: string;
      range?: number;
      keyLevels?: import("../../lib/kline").Markers | null;
      lastBar?: { date: string; open: number; close: number; high: number; low: number } | null;
    } | null;
    /** 大屏联动：让 K 线主图跳到指定股票（AI 回答或用户点选时触发） */
    onFocusStock?: (code: string, name: string) => void;
  },
) {
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [primed, setPrimed] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const stockCode = analysis?.stock.code ?? linkedStock?.code ?? "";

  const scrollToBottom = useCallback((smooth = true) => {
    const el = messagesRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }, []);

  // 按用户 + 股票维度构造本地存储 key
  const storageKey = `assistant:${userId ?? "anon"}:${stockCode || "global"}`;

  // 切换股票 / 首次进入：优先从本地恢复历史，无缓存才给引导语
  useEffect(() => {
    if (typeof window === "undefined") return;
    let restored: AssistantMessage[] = [];
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw) restored = JSON.parse(raw) as AssistantMessage[];
    } catch {
      restored = [];
    }
    // 清理遗留的流式占位（如生成中途刷新页面），避免出现空内容气泡
    restored = restored
      .filter((m) => !m.streaming || m.content.trim().length > 0)
      .map((m) => (m.streaming ? { ...m, streaming: false } : m));
    if (restored.length > 0) {
      setMessages(restored);
      setPrimed(true);
    } else {
      setMessages([{
        role: "assistant",
        kind: "primer",
        content: analysis
          ? `${analysis.stock.name}的当前数据已整理好。先记一笔持仓我能说得更准；想买、卖、加减仓随时问。`
          : linkedStock
            ? `当前大屏正在以${linkedStock.period === "week" ? "周K" : linkedStock.period === "month" ? "月K" : linkedStock.period === "day" ? "日K" : "K线"}展示 ${linkedStock.name}（${linkedStock.code}）。我已知晓它的关键价位（泡沫顶/突破位/生死支撑/双底/均线扣抵）与最新K线，可以直接问盘面解读、买卖参考或加减仓，想切到别的票或别的周期说一声我就让大屏跳过去。`
            : "还没选中股票。可以先按账户和持仓说话；要谈某只票，先去「个股分析」跑一遍。",
        id: nextId(),
      }]);
      setPrimed(true);
    }
    // 仅股票维度变化触发恢复；position 变化不再清空历史
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stockCode, storageKey]);

  // 任何消息变化都写回本地，避免刷新/切换丢上下文
  useEffect(() => {
    if (primed && typeof window !== "undefined") {
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(messages));
      } catch {
        /* 容量超限或隐私模式时忽略 */
      }
    }
  }, [messages, primed, storageKey]);

  // 历史/提问长度变化时把消息列表滚到底
  useEffect(() => {
    scrollToBottom(false);
  }, [messages, asking, scrollToBottom]);

  // 监听移动端键盘弹起（visualViewport），让 sheet 高度跟随
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handle = () => {
      const root = messagesRef.current?.closest(".sa") as HTMLElement | null;
      if (!root) return;
      const vv = window.visualViewport;
      if (!vv) return;
      const offset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      root.style.setProperty("--keyboard-inset", `${Math.round(offset)}px`);
    };
    handle();
    window.visualViewport?.addEventListener("resize", handle);
    window.visualViewport?.addEventListener("scroll", handle);
    return () => {
      window.visualViewport?.removeEventListener("resize", handle);
      window.visualViewport?.removeEventListener("scroll", handle);
    };
  }, []);

  function buildContext() {
    if (!analysis && linkedStock) return buildLinkedContext(linkedStock, portfolioInsights);
    if (!analysis) return buildPlaceholderContext(portfolioInsights);
    const context = buildAnalysisContext(analysis, position, portfolioInsights);
    // 行情增量：用页面最新报价（每分钟轻量刷新）覆盖快照里的价格/涨跌幅/行情时间，
    // 其余字段（支撑阻力/财务/指标）保留快照——它们是日级数据，短时间不变。
    const latest = quotes?.[analysis.stock.code]?.quote;
    if (latest && Number.isFinite(latest.price)) {
      context.quote = {
        ...context.quote,
        price: latest.price,
        changePercent: latest.changePercent,
        marketTime: latest.marketTime,
      };
      if (context.position && position && position.averageCostTenThousandths > 0) {
        context.position = {
          ...context.position,
          returnPercent: ((latest.price * 10_000 / position.averageCostTenThousandths) - 1) * 100,
        };
      }
    }
    return context;
  }

  async function ask(text: string, opts?: { replaceAssistantId?: string }) {
    const clean = text.trim();
    if (!clean || asking) return;
    const userMessage = { role: "user" as const, content: clean, id: nextId() };
    const replaceId = opts?.replaceAssistantId;
    // 重新生成：去掉旧 assistant 气泡，但保留其前面的 user 提问
    if (replaceId) {
      setMessages((current) => current.filter((m) => m.id !== replaceId));
    } else {
      setMessages((current) => [...current, userMessage]);
    }
    setQuestion("");
    setAsking(true);
    setRegeneratingId(replaceId ? null : regeneratingId);
    // 先插入一条空的 assistant 占位，流式内容逐块追加进去
    const placeholderId = nextId();
    setMessages((current) => [...current, { role: "assistant", content: "", id: placeholderId, streaming: true }]);
    try {
      // 全局模式：若用户问某只持仓股，先静默拉取行情数据再发问，避免 AI 因缺数据只能回"数据缺失"
      let context = buildContext();
      if (analysis === null && portfolioInsights.positions.length > 0) {
        const matched = portfolioInsights.positions.find((p) =>
          clean.includes(p.name) || clean.includes(p.symbol)
        );
        if (matched) {
          // 大屏联动：让 K 线主图跳到用户提到的这只票
          if (onFocusStock) onFocusStock(matched.symbol, matched.name);
          if (onFetchStock) {
            const fetched = await onFetchStock(matched.symbol);
            if (fetched) {
              context = buildAnalysisContext(fetched.analysis, fetched.position, portfolioInsights);
            }
          }
        }
      }
      // 多给几条历史（最多 30 条），由后端在历史过长时自动做摘要压缩
      const historyMessages = messages
        .filter((m) => !m.error && !m.streaming && m.kind !== "primer")
        .slice(-30)
        .map((m) => ({ role: m.role, content: m.content }));
      // 记录本次回复基于的数据时间（用于时效标注；行情已用最新 quotes 覆盖）
      const dataTime = context.source?.fetchedAt ?? context.quote?.marketTime ?? null;
      const response = await fetch("/api/assistant", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          question: clean,
          messages: historyMessages,
          context,
        }),
      });
      if (!response.ok || !response.body) {
        const payload = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(payload?.error ?? "这次追问暂时没有回答，请稍后重试。");
      }
      // 流式解析 SSE：data: {type:"delta"|"done"|"interrupted", content, mode}
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let accumulated = "";
      let finalMode: "ai" | "fallback" = "fallback";
      let done = false;
      let receivedDone = false;
      let interrupted = false;
      const patch = (content: string, streaming: boolean, extra?: Partial<AssistantMessage>) => {
        setMessages((current) => current.map((m) =>
          m.id === placeholderId ? { ...m, content, streaming, mode: finalMode, ...extra } : m
        ));
      };
      while (!done) {
        const { done: readDone, value } = await reader.read();
        if (readDone) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const rawLine of chunk.split("\n")) {
          const line = rawLine.trim();
          if (!line.startsWith("data:")) continue;
          const payloadText = line.slice(5).trim();
          if (!payloadText) continue;
          try {
            const frame = JSON.parse(payloadText) as { type?: string; content?: string; mode?: "ai" | "fallback" };
            if (frame.type === "delta" && typeof frame.content === "string") {
              accumulated += frame.content;
              patch(accumulated, true);
            } else if (frame.type === "interrupted") {
              interrupted = true;
            } else if (frame.type === "done") {
              finalMode = frame.mode ?? (accumulated.trim() ? "ai" : "fallback");
              receivedDone = true;
              done = true;
            }
          } catch {
            // 忽略无法解析的帧
          }
        }
      }
      // 上游断流：循环自然结束但没收到 done（或后端明确发了 interrupted），
      // 已收到的内容保留，并标记"回复可能不完整"，不再静默吞掉。
      if (!receivedDone && accumulated.trim()) interrupted = true;
      if (!accumulated.trim()) {
        throw new Error("这次追问暂时没有回答，请稍后重试。");
      }
      patch(accumulated, false, {
        fetchedAt: dataTime ?? undefined,
        interrupted: interrupted || undefined,
      });
    } catch (error) {
      setMessages((current) => current
        .filter((m) => m.id !== placeholderId)
        .concat([{
          role: "assistant",
          content: error instanceof Error ? error.message : "这次追问暂时没有回答，请稍后重试。",
          id: nextId(),
          error: true,
          // 失败时把原问题挂到消息上，点"重试"就能重发
          pendingQuestion: clean,
        }]));
    } finally {
      setAsking(false);
      setRegeneratingId(null);
    }
  }

  function retry(messageId: string) {
    const target = messages.find((m) => m.id === messageId);
    if (!target?.pendingQuestion) return;
    // 移除失败气泡，重新发起提问
    setMessages((current) => current.filter((m) => m.id !== messageId));
    void ask(target.pendingQuestion);
  }

  function regenerate(messageId: string) {
    if (asking || regeneratingId) return;
    // 找到该 assistant 回复之前最近的一条 user 提问
    const idx = messages.findIndex((m) => m.id === messageId);
    if (idx <= 0) return;
    let userQuestion = "";
    for (let i = idx - 1; i >= 0; i -= 1) {
      if (messages[i].role === "user") { userQuestion = messages[i].content; break; }
    }
    if (!userQuestion) return;
    setRegeneratingId(messageId);
    void ask(userQuestion, { replaceAssistantId: messageId });
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    void ask(question);
  }

  // —— 复制单条回复 ——
  async function copyMessage(text: string, id?: string) {
    if (!id) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopiedId(id);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopiedId(null), 1800);
    } catch {
      /* 忽略复制失败 */
    }
  }

  function clearHistory() {
    if (typeof window !== "undefined") {
      try { window.localStorage.removeItem(storageKey); } catch { /* ignore */ }
    }
    setMessages([{
      role: "assistant",
      kind: "primer",
      content: analysis
        ? `${analysis.stock.name}的当前数据已整理好。先记一笔持仓我能说得更准；想买、卖、加减仓随时问。`
        : "还没选中股票。可以先按账户和持仓说话；要谈某只票，先去「个股分析」跑一遍。",
      id: nextId(),
    }]);
  }

  const targetLabel = analysis?.stock.name ?? "账户总览";
  const prompts = analysis
    ? (position
      ? ["这只仓位还能加吗？", "结合我的成本怎么看？", "主要风险是什么？"]
      : ["这只票现在能买吗？", "主要风险是什么？", "财务数据说明了什么？"])
    : ["总仓位是多少？", "还能加多少现金？", "账户整体收益如何？"];

  // 仅在尚未正式对话 / 正在等待回答时展示提示问题，避免反复出现打扰阅读
  const showPrompts = primed && (asking || messages.filter((m) => m.role === "user").length === 0);

  return (
    <section className={`sa${floating ? " sa--floating" : ""}${page ? " sa--page" : ""}${compact ? " sa--compact" : ""}`}>
      <div className="sa-head">
        {headerSlot}
        <div className="sa-head__title">
          <span className="sa-eyebrow">聊</span>
          <span className="sa-target" title={targetLabel}>{targetLabel}</span>
        </div>
        <div className="sa-head__actions">
          {primed && messages.length > 1 && (
            <button
              type="button"
              className="sa-iconbtn"
              onClick={clearHistory}
              aria-label="清空本轮对话"
              title="清空对话"
            >
              <Trash2 size={13} />
            </button>
          )}
          {(floating || page) && onClose && (
            <button
              type="button"
              className={`sa-iconbtn ${page ? "sa-iconbtn--back" : "sa-iconbtn--close"}`}
              onClick={onClose}
              aria-label={page ? "返回" : "收起助手"}
              title={page ? "返回" : "收起"}
            >
              {page ? <ArrowLeft size={16} /> : <X size={14} />}
            </button>
          )}
        </div>
      </div>
      <div className="sa-msgs" ref={messagesRef} aria-live="polite">
        {!primed && (
          <div className="sa-msg sa-msg--assistant">
            <div className="sa-msg__avatar" aria-hidden><Bot size={16} /></div>
            <div className="sa-msg__body">…</div>
          </div>
        )}
        {messages.map((message) => {
          if (message.role === "user") {
            return (
              <div key={message.id} className="sa-msg sa-msg--user">
                <div className="sa-msg__body">{message.content}</div>
              </div>
            );
          }
          const regen = regeneratingId === message.id;
          return (
            <div key={message.id} className={`sa-msg sa-msg--assistant${message.error ? " is-error" : ""}`}>
              <div className="sa-msg__avatar" aria-hidden><Bot size={16} /></div>
              <div className="sa-msg__main">
                {regen ? (
                  <span className="sa-dots" aria-label="正在重新生成"><span /><span /><span /></span>
                ) : message.streaming && !message.content ? (
                  // 正在思考：内容还没到，显示三点
                  <span className="sa-dots" aria-label="正在思考"><span /><span /><span /></span>
                ) : message.streaming ? (
                  // 正在生成：纯文本逐块追加 + 末尾光标（markdown 结构不完整，先不切结构化渲染）
                  <div className="sa-streaming">
                    <span className="sa-stream-text">{message.content}</span>
                    <span className="sa-caret" aria-hidden />
                  </div>
                ) : (
                  <AssistantAnswer content={message.content} />
                )}
                {!regen && !message.streaming && (
                  <div className="sa-msg__meta">
                    {message.error ? (
                      message.pendingQuestion && (
                        <button
                          type="button"
                          className="sa-link"
                          onClick={() => message.id && retry(message.id)}
                          disabled={asking}
                        >
                          重试
                        </button>
                      )
                    ) : (
                      <>
                        {message.interrupted && <span className="sa-msg__warn">回复可能不完整</span>}
                        {message.fetchedAt && <span className="sa-msg__time">基于 {formatDateTimeShanghai(message.fetchedAt)} 数据</span>}
                        <button
                          type="button"
                          className="sa-link"
                          onClick={() => message.id && copyMessage(message.content, message.id)}
                          aria-label="复制这条回复"
                          title="复制"
                        >
                          {copiedId === message.id ? "已复制" : "复制"}
                        </button>
                        <span className="sa-sep" aria-hidden>·</span>
                        <button
                          type="button"
                          className="sa-link"
                          onClick={() => message.id && regenerate(message.id)}
                          disabled={asking || regeneratingId === message.id}
                          aria-label="换一版回复"
                          title="换一版"
                        >
                          换一版
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* 快捷提问固定在输入框上方并贴底，开场白保留在消息流顶部 */}
      {showPrompts && prompts.length > 0 && (
        <div className={`sa-anchored${compact ? "" : " sa-anchored--relaxed"}`}>
          <div className="sa-prompts" role="group" aria-label="推荐提问">
            {prompts.map((prompt) => (
              <button
                key={prompt}
                type="button"
                className="sa-prompt"
                disabled={asking}
                onClick={() => void ask(prompt)}
              >
                {prompt}
              </button>
            ))}
          </div>
        </div>
      )}

      <form className="sa-form" onSubmit={submit}>
        <input
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          maxLength={300}
          placeholder={analysis ? `问${analysis.stock.name}…` : "问账户、持仓、收益…"}
          aria-label="向助手提问"
        />
        <button
          type="submit"
          className="sa-send"
          disabled={asking || !question.trim()}
          aria-label="发送"
          title="发送"
        >
          <ArrowUp size={15} />
        </button>
      </form>
    </section>
  );
}
