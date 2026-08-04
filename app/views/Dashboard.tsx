"use client";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useSearchParams, usePathname } from "next/navigation";
import { SectionHeader, Badge, Stat, Button, IconButton, Field, Input, Select, Textarea, Banner, Hint, LoadingState, ConfirmDialog, StockSearch, type StockSuggestionGroup, type StockSuggestion } from "../components/ui";
import { Sparkline } from "../components/charts";
import { AnalyticsView } from "./AnalyticsView";
import { ImportPanel } from "./ImportPanel";
import { MarkdownMessage } from "../components/MarkdownMessage";
import { StrategyScanView, type StrategyScanResponse } from "./StrategyScanView";
import { WritebackView } from "./WritebackView";
import { UsersAdmin } from "../components/UsersAdmin";
import {
  ArrowDown,
  ArrowUp,
  ArrowLeftRight,
  ArrowLeft,
  Bell,
  CalendarDays,
  ChevronRight,
  ChevronDown,
  TrendingUp,
  Upload,
  Trash2,
  CheckCircle2,
  MessageCircle,
  ClipboardList,
  Database,
  Settings as SettingsIcon,
  Home as HomeIcon,
  Lock,
  Search,
  NotebookPen,
  Pencil,
  Plus,
  ScanLine,
  SlidersHorizontal,
  MessageSquare,
  ShieldCheck,
  ShieldAlert,
  RefreshCw,
  LogOut,
  Target,
  ClipboardCheck,
  Scale,
  ArrowRightCircle,
  Star,
  Wallet,
  Users,
  AlertTriangle,
  X,
  ChevronUp,
  RotateCw,
  Zap,
  type LucideIcon,
} from "lucide-react";
import {
  aggregateMarketHistory,
  buildTradeCycles,
  calculatePortfolio,
  localIsoDate,
  type CapitalFlow,
  type MarketBar,
  type MarketPeriod,
  type Trade,
  type TradeCycle,
} from "../../lib/domain/domain";
import type { SectorHeatmap as SectorHeatmapData } from "../../lib/market/sectors";
import { calculatePortfolioInsights, type PortfolioInsights } from "../../lib/domain/portfolio-insights";
import { calculateTradeStatistics } from "../../lib/domain/trade-statistics";
import { TAKE_PROFIT_1_R, TAKE_PROFIT_2_R } from "../../lib/domain/trade-import";
import { baseCloseSince, resolveStock, type Oscillators } from "../../lib/domain/stocks";
import {
  DEFAULT_PREFERENCES,
  RISK_PRESETS,
  RISK_PROFILE_LABELS,
  type RiskProfile,
  type TradingPreferences,
} from "../../lib/utils/preferences";
import type { AssistantContext } from "../../lib/ai/assistant";
import { splitAssistantSections, conclusionTone } from "../../lib/ai/assistant";
import { formatDateShanghai, formatDateTimeShanghai } from "../../lib/utils/time";
import { readCache, writeCache, removeCache, readKeyedCache, writeKeyedCache } from "../../lib/utils/client-cache";

type View = "home" | "watchlist" | "trades" | "settings" | "analytics" | "analysis" | "scan" | "writeback";
type TradeMode = "buy" | "sell";
const VALID_VIEWS: View[] = ["home", "analysis", "watchlist", "trades", "settings", "analytics", "scan", "writeback"];

type WatchItem = {
  id: number;
  symbol: string;
  name: string;
  note: string;
  conditionText: string;
  status: "研究中" | "等待条件" | "已买入" | "暂停";
  lastReviewedAt: string | null;
  updatedAt: string;
  createdAt: string;
  conditionMetric: "price" | "change" | null;
  conditionDirection: "above" | "below" | null;
  conditionValue: number | null;
};

type AlertRule = {
  id: number;
  symbol: string;
  name: string;
  type: "止损" | "止盈一" | "止盈二";
  targetPriceCents: number;
  targetPriceMillis: number | null;
  enabled: boolean;
  acknowledgedAt: string | null;
  triggeredAt: string | null;
};

type Review = {
  id: number;
  symbol: string;
  name: string;
  cycleEndTradeId: number | null;
  followedPlan: boolean;
  lesson: string;
  resultCents: number;
  tags: string[];
  deviationReason: string;
};

type Explanation = {
  summary: string;
  company: string[];
  risks: string[];
  themes: Array<{ name: string; confidence: string; reason: string }>;
  missingInformation: string[];
};

type FundProfile = {
  manager: string;
  trackingIndex: string;
  exchange: string;
  category: string;
  inceptionDate: string;
  sourceName: string;
  sourceUrl: string;
};

type Analysis = {
  historyWarning?: string;
  stock: {
    code: string;
    name: string;
    industry: string;
    instrumentType: "stock" | "etf";
    fund: FundProfile | null;
    marketSymbol: string;
    sector?: string | null;
    businessSummary?: string | null;
  };
  quote: {
    price: number;
    previousClose: number;
    changePercent: number;
    ma5: number;
    ma20: number;
    ma60: number;
    recentHigh: number;
    recentLow: number;
    support: number;
    resistance: number;
    volatility: number;
    target1: number;
    target2: number;
    marketTime: string | null;
  };
  financials: {
    revenueGrowth: number | null;
    profitGrowth: number | null;
    debtRatio: number | null;
    marketCap: number | null;
    pe: number | null;
    pb: number | null;
    roe: number | null;
    grossMargin: number | null;
    profitMargin: number | null;
    operatingCashflow: number | null;
    series: Record<string, Array<{ date: string; value: number }>>;
    /** 营收/利润/负债率全部缺失（麦蕊未取到且无兜底）时置为 true，前端提示「以技术面为主」而非显示 0 */
    fundamentalsUnavailable?: boolean;
    /** PE/PB 取数失败原因，便于线上排查 */
    profileError?: string | null;
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
  volumeHighlight: {
    date: string;
    close: number;
    volume: number;
  } | null;
  volume: {
    latest: number;
    ma5: number;
    ma20: number;
    ratio: number | null;
    divergence: "顶背离" | "底背离" | "无明显背离" | null;
    upDaysWithVolume: number;
    downDaysWithVolume: number;
  } | null;
  oscillators?: Oscillators | null;
  source: { name: string; url: string; fetchedAt: string };
  mode: "deepseek" | "automatic";
  explanation: Explanation;
  strategy?: { content: string; mode: "deepseek" | "automatic" } | null;
  strategyWarning?: string;
};

/**
 * 行情快照条目。
 *
 * 注意：写入 localStorage 时只保留 stock/quote/history 三个字段（见 writeKeyedCache 调用处），
 * 因此刷新页面后从缓存恢复的对象并不具备完整 Analysis 的其余字段。此前该状态被标注为
 * Record<string, Analysis>，属于类型契约破坏——类型声称字段存在而运行时为 undefined。
 * 这里显式收窄为实际持久化的字段集合，让类型与运行时一致。
 */
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
  // 当某条 assistant 消息是失败占位时，保留用户原始问题以便点"重试"复用
  pendingQuestion?: string;
};

let assistantMessageCounter = 0;
const nextId = () => {
  assistantMessageCounter += 1;
  if (typeof globalThis !== "undefined" && "crypto" in globalThis && "randomUUID" in globalThis.crypto) {
    return `${Date.now().toString(36)}-${globalThis.crypto.randomUUID().slice(0, 8)}`;
  }
  return `${Date.now().toString(36)}-${(assistantMessageCounter).toString(36)}`;
};

// 视口断点：≤ breakpoint 视为移动端。用于区分「PC 浮窗」与「移动端全屏对话页」。
// 客户端组件内初始化即用 matchMedia 取值，避免首帧闪烁；并在断点变化时实时更新。
function useIsMobile(breakpoint = 768) {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== "undefined" && window.matchMedia(`(max-width: ${breakpoint}px)`).matches,
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia(`(max-width: ${breakpoint}px)`);
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [breakpoint]);
  return isMobile;
}

type Status = {
  deepseekConfigured: boolean;
  aiProvider?: string;
  dataSource: string;
  mairuiEnabled?: boolean;
  reminderMode: string;
};

type User = {
  id: number;
  username: string;
  displayName: string;
  role: "super_admin" | "user";
  email?: string;
};

const navItems: Array<{ id: View; label: string; icon: LucideIcon }> = [
  { id: "home", label: "首页", icon: HomeIcon },
  { id: "analysis", label: "个股分析", icon: Search },
  { id: "watchlist", label: "我的关注", icon: Star },
  { id: "trades", label: "交易记录", icon: ArrowLeftRight },
  { id: "analytics", label: "复盘总结", icon: TrendingUp },
  { id: "settings", label: "系统设置", icon: SettingsIcon },
  { id: "scan", label: "策略扫描", icon: ScanLine },
  { id: "writeback", label: "回写结果", icon: Upload },
];

const buyReasons = ["看好公司业绩", "看好行业题材", "价格回调", "突破买入", "朋友或网络推荐", "担心错过", "冲动买入", "其他"];
const sellReasons = ["达到止盈目标", "触发止损", "买入逻辑失效", "害怕利润回吐", "临时需要资金", "看到其他股票", "不知道为什么卖", "其他"];

function money(cents: number) {
  return `¥${(cents / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function price(value: number) {
  const digits = Math.abs(value) < 10 ? 3 : 2;
  return `¥${value.toLocaleString("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

function millisPrice(millis: number) {
  return price(millis / 1000);
}

function tenThousandthsPrice(value: number) {
  return `¥${(value / 10_000).toLocaleString("zh-CN", {
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  })}`;
}

function alertPrice(alert: AlertRule) {
  const value = millisPrice(alert.targetPriceMillis ?? alert.targetPriceCents * 10);
  return alert.targetPriceMillis === null || alert.targetPriceMillis === undefined ? `约${value}` : value;
}

function tradePrice(trade: Trade) {
  if (trade.priceTenThousandths !== null && trade.priceTenThousandths !== undefined) {
    return tenThousandthsPrice(trade.priceTenThousandths);
  }
  const value = millisPrice(trade.priceMillis ?? trade.priceCents * 10);
  return trade.priceMillis === null || trade.priceMillis === undefined ? `约${value}` : value;
}

function compactAmount(value: number) {
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1)}亿`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(1)}万`;
  return value.toLocaleString("zh-CN");
}

function compactVolume(value: number) {
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(2)}亿`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(1)}万`;
  return value.toLocaleString("zh-CN");
}

function latestWeekday() {
  const date = new Date();
  while (date.getDay() === 0 || date.getDay() === 6) date.setDate(date.getDate() - 1);
  return localIsoDate(date);
}

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new Error("网络连接中断，请稍后重试");
  }
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? "请求失败");
  return payload;
}

export function Dashboard({ user, signOutUrl }: { user: User; signOutUrl: string }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [view, setView] = useState<View>(() => {
    const target = searchParams.get("view");
    return target && VALID_VIEWS.includes(target as View) ? target as View : "home";
  });
  const [query, setQuery] = useState("");
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  // 最近分析与行情快照从 localStorage 恢复，刷新页面时避免首屏空白；
  // 行情快照 TTL 较短（10 分钟），过期数据会在后续轮询中被自动覆盖。
  const [recentAnalyses, setRecentAnalyses] = useState<Analysis[]>(() => readCache<Analysis[]>("recent") ?? []);
  const [quotes, setQuotes] = useState<Record<string, QuoteEntry>>(() => readKeyedCache<QuoteEntry>("quotes", 10 * 60 * 1000) ?? {});
  const [trades, setTrades] = useState<Trade[]>([]);
  const [watchlist, setWatchlist] = useState<WatchItem[]>([]);
  const [alerts, setAlerts] = useState<AlertRule[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [initialCapitalCents, setInitialCapitalCents] = useState<number | null>(null);
  const [capitalFlows, setCapitalFlows] = useState<CapitalFlow[]>([]);
  const [preferences, setPreferences] = useState<TradingPreferences | null>(null);
  const [strategyScan, setStrategyScan] = useState<StrategyScanResponse | null>(null);
  const [tradeMode, setTradeMode] = useState<TradeMode | null>(null);
  const [reviewCycleEndTradeId, setReviewCycleEndTradeId] = useState<number | null>(null);
  const [settingsSection, setSettingsSection] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [toast, setToast] = useState("");
  const [error, setError] = useState("");
  const notified = useRef(new Set<number>());
  const pendingQuotes = useRef(new Set<string>());
  /** 每个 symbol 最近一次拉取行情的时间戳，用于 TTL 判断是否需要刷新 */
  const quoteFetchedAt = useRef<Record<string, number>>({});
  /** 行情刷新 TTL：超过该时长即视为过期，进入轮询时会重新拉取 */
  const QUOTE_TTL_MS = 5 * 60 * 1000;
  /** 选股榜单点击"分析"时暂存的行数据，fetchAnalysis 消费后清空 */
  const pendingScreenerContext = useRef<import("./StrategyScanView").ScanSelected | null>(null);

  function navigate(nextView: View, symbolOverride?: string) {
    setView(nextView);
    // 仅更新地址栏 URL，不触发 Next.js 路由/服务端重渲染，
    // 否则 force-dynamic 的 page.tsx 会重新执行并让 Dashboard 重新挂载，
    // 导致 view 先重置为 home 再被 URL 恢复，表现为“先闪首页再跳转”。
    const params = new URLSearchParams(searchParams.toString());
    if (nextView === "home") {
      params.delete("view");
      params.delete("symbol");
    } else {
      params.set("view", nextView);
      const symbol = symbolOverride?.trim() || query.trim();
      if (nextView === "analysis" && symbol) params.set("symbol", symbol);
      else params.delete("symbol");
    }
    const queryString = params.toString();
    const url = queryString ? `${pathname}?${queryString}` : pathname;
    window.history.replaceState(window.history.state, "", url);
  }

  const portfolio = useMemo(() => calculatePortfolio(trades), [trades]);
  const portfolioInsights = useMemo(() => calculatePortfolioInsights(
    trades,
    Object.fromEntries(Object.entries(quotes).map(([symbol, item]) => [symbol, item.quote.price])),
    Object.fromEntries(Object.entries(quotes).map(([symbol, item]) => [symbol, item.history])),
    initialCapitalCents,
    capitalFlows,
  ), [initialCapitalCents, capitalFlows, quotes, trades]);
  const tradeCycles = useMemo(() => buildTradeCycles(trades), [trades]);
  const closedCycles = tradeCycles.filter((cycle) => cycle.endTradeId !== null);
  const reviewedCycleIds = useMemo(() => {
    const ids = new Set(reviews.flatMap((review) => review.cycleEndTradeId ? [review.cycleEndTradeId] : []));
    for (const review of reviews.filter((item) => item.cycleEndTradeId === null)) {
      const legacyCycle = [...closedCycles]
        .reverse()
        .find((cycle) => cycle.symbol === review.symbol && cycle.endTradeId && !ids.has(cycle.endTradeId));
      if (legacyCycle?.endTradeId) ids.add(legacyCycle.endTradeId);
    }
    return ids;
  }, [closedCycles, reviews]);
  const pendingReviews = closedCycles.filter((cycle) =>
    cycle.endTradeId !== null && !reviewedCycleIds.has(cycle.endTradeId)
  );

  const flash = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  }, []);

  const clearLocalCache = useCallback(() => {
    // 清空浏览器本地保存的最近分析与行情快照缓存
    removeCache("quotes");
    removeCache("recent");
    setRecentAnalyses([]);
    flash("本地分析缓存已清空");
  }, [flash]);

  const removeRecentAnalysis = useCallback((code: string) => {
    setRecentAnalyses((current) => {
      const next = current.filter((item) => item.stock.code !== code);
      writeCache("recent", next);
      return next;
    });
  }, []);

  const loadData = useCallback(async () => {
    try {
      const [tradeData, watchData, alertData, reviewData, statusData, accountData, preferencesData] = await Promise.all([
        jsonRequest<{ trades: Trade[] }>("/api/trades"),
        jsonRequest<{ items: WatchItem[] }>("/api/watchlist"),
        jsonRequest<{ alerts: AlertRule[] }>("/api/alerts"),
        jsonRequest<{ reviews: Review[] }>("/api/reviews"),
        jsonRequest<Status>("/api/status"),
        jsonRequest<{ initialCapitalCents: number | null; capitalFlows: CapitalFlow[] }>("/api/account"),
        jsonRequest<TradingPreferences>("/api/preferences"),
      ]);
      setTrades(tradeData.trades);
      setWatchlist(watchData.items);
      setAlerts(alertData.alerts);
      setReviews(reviewData.reviews);
      setStatus(statusData);
      setInitialCapitalCents(accountData.initialCapitalCents);
      setCapitalFlows(accountData.capitalFlows);
      setPreferences(preferencesData);
      setError("");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "个人数据暂时无法读取");
    } finally {
      setLoading(false);
    }
    // 预取策略扫描结果（无历史数据时接口返回非 2xx，属正常情况，静默忽略）
    try {
      const scanData = await jsonRequest<StrategyScanResponse>("/api/strategy-scan");
      setStrategyScan(scanData);
    } catch {
      setStrategyScan(null);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadData(), 0);
    return () => window.clearTimeout(timer);
  }, [loadData]);

  // 隐身模式：根据偏好给根节点挂 class，CSS 变量切换低存在感配色
  useEffect(() => {
    const root = document.documentElement;
    if (preferences?.stealthMode) root.classList.add("stealth");
    else root.classList.remove("stealth");
  }, [preferences?.stealthMode]);

  const savePreferences = useCallback(async (next: TradingPreferences) => {
    const result = await jsonRequest<TradingPreferences>("/api/preferences", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(next),
    });
    setPreferences(result);
    flash("风险偏好与交易纪律已保存");
  }, [setPreferences, flash]);

  // 老板键：按 Esc 在隐身模式间快速切换（办公室摸鱼防暴露）
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && preferences) {
        e.preventDefault();
        const next = { ...preferences, stealthMode: !preferences.stealthMode };
        setPreferences(next);
        void savePreferences(next);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [preferences, savePreferences]);

  const fetchAnalysis = useCallback(async (stockQuery: string, showResult = true, force = false) => {
    if (showResult) {
      setAnalyzing(true);
      setError("");
      setAnalysis(null);
    }
    // 取出并清空选股榜单上下文（一次性消费）
    const screenerCtx = pendingScreenerContext.current;
    pendingScreenerContext.current = null;
    try {
      const result = await jsonRequest<Analysis>("/api/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: stockQuery,
          saveHistory: showResult,
          explain: showResult,
          force,
          ...(screenerCtx ? { screenerContext: screenerCtx } : {}),
        }),
      });
      quoteFetchedAt.current[result.stock.code] = Date.now();
      setQuotes((current) => {
        const next = { ...current, [result.stock.code]: result };
        // 写入缓存时只保留展示必需字段（stock/quote/history），避免单文件撑爆 localStorage
        // 导致缓存静默失效；逐项 TTL 与条目上限在 writeKeyedCache 内保证。
        const trimmed: Record<string, Pick<Analysis, "stock" | "quote" | "history">> = {};
        for (const [code, item] of Object.entries(next)) {
          trimmed[code] = { stock: item.stock, quote: item.quote, history: item.history };
        }
        writeKeyedCache("quotes", trimmed, 60);
        return next;
      });
      if (showResult) {
        setAnalysis(result);
        setQuery(result.stock.code);
        setRecentAnalyses((current) => {
          const next = [
            result,
            ...current.filter((item) => item.stock.code !== result.stock.code),
          ].slice(0, 6);
          writeCache("recent", next);
          return next;
        });
        if (result.historyWarning) flash(result.historyWarning);
      }
      return result;
    } catch (analyzeError) {
      const message = analyzeError instanceof Error ? analyzeError.message : "股票分析失败";
      if (showResult) {
        setError(message);
        flash(message);
      }
      return null;
    } finally {
      if (showResult) setAnalyzing(false);
    }
  }, [flash]);

  /** 判断某 symbol 的行情是否需要刷新（缺失或已过期） */
  const quoteStale = useCallback((symbol: string) => {
    const fetchedAt = quoteFetchedAt.current[symbol];
    return !fetchedAt || Date.now() - fetchedAt > QUOTE_TTL_MS;
  }, [QUOTE_TTL_MS]);

  const refreshQuote = useCallback((symbol: string) => {
    if (pendingQuotes.current.has(symbol)) return;
    pendingQuotes.current.add(symbol);
    void fetchAnalysis(symbol, false).finally(() => pendingQuotes.current.delete(symbol));
  }, [fetchAnalysis]);

  // 首屏与每次状态变化后：为缺失或已过期的持仓/关注/提醒行情发起拉取
  useEffect(() => {
    const symbols = new Set([
      ...portfolio.positions.map((position) => position.symbol),
      ...alerts.filter((alert) => alert.enabled).map((alert) => alert.symbol),
      ...watchlist.map((item) => item.symbol),
    ]);
    const timer = window.setTimeout(() => {
      for (const symbol of symbols) {
        if (quoteStale(symbol)) refreshQuote(symbol);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [alerts, portfolio.positions, watchlist, quotes, quoteStale, refreshQuote]);

  const markAlertTriggered = useCallback(async (alert: AlertRule, current: number, target: number) => {
    const message = `${alert.name}已触发${alert.type}提醒：当前${price(current)}，目标${price(target)}`;
    flash(message);
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification("我的复盘助手", { body: message });
    }
    try {
      const result = await jsonRequest<{ alert: AlertRule }>("/api/alerts", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: alert.id, action: "trigger" }),
      });
      setAlerts((prev) => prev.map((a) => (a.id === result.alert.id ? { ...a, triggeredAt: result.alert.triggeredAt } : a)));
    } catch {
      /* 提示已发出；写入失败会在下次刷新时基于行情重新提醒 */
    }
  }, [flash, setAlerts]);

  const checkAlerts = useCallback(() => {
    for (const alert of alerts) {
      if (!alert.enabled || alert.acknowledgedAt || alert.triggeredAt || notified.current.has(alert.id)) continue;
      const current = quotes[alert.symbol]?.quote.price;
      if (!current) continue;
      const target = (alert.targetPriceMillis ?? alert.targetPriceCents * 10) / 1000;
      const triggered = alert.type === "止损" ? current <= target : current >= target;
      if (!triggered) continue;
      notified.current.add(alert.id);
      void markAlertTriggered(alert, current, target);
    }
  }, [alerts, quotes, markAlertTriggered]);

  useEffect(() => {
    const firstCheck = window.setTimeout(checkAlerts, 0);
    // 周期轮询：对持仓/关注/提醒统一刷新行情（带 TTL 判定），同时检查止损/止盈是否触发。
    // 注意：必须在每次轮询里调用 checkAlerts()，否则提醒只在页面加载时检查一次、
    // 之后价格触达也不再提醒（历史遗漏，已修复）。轮询间隔与 QUOTE_TTL_MS 一致，
    // 确保每次轮询时 TTL 已过期、行情必然刷新，提醒判断基于最新价。
    const timer = window.setInterval(() => {
      const symbols = new Set([
        ...portfolio.positions.map((position) => position.symbol),
        ...alerts.filter((item) => item.enabled).map((item) => item.symbol),
        ...watchlist.map((item) => item.symbol),
      ]);
      for (const symbol of symbols) {
        if (quoteStale(symbol)) refreshQuote(symbol);
      }
      checkAlerts();
    }, QUOTE_TTL_MS);
    return () => {
      window.clearTimeout(firstCheck);
      window.clearInterval(timer);
    };
  }, [alerts, checkAlerts, portfolio.positions, quoteStale, refreshQuote, watchlist, QUOTE_TTL_MS]);

  async function analyzeStock(event?: React.FormEvent, overrideQuery?: string) {
    event?.preventDefault();
    const target = (overrideQuery ?? query).trim();
    if (!target) {
      flash("请输入股票代码或名称");
      return;
    }
    // 防止并发：正在分析时忽略重复触发，避免按钮连点 / 自动分析与手动重叠
    if (analyzing) return;
    if (overrideQuery) setQuery(overrideQuery);
    await fetchAnalysis(target);
  }

  // 重新分析：强制绕过行情缓存，拉取最新价并重新计算（供分析页"重新分析"按钮）
  const reanalyzeStock = useCallback(async () => {
    if (!query.trim()) {
      flash("请先输入股票代码或名称");
      return;
    }
    await fetchAnalysis(query, true, true);
    flash("已重新拉取最新行情并更新分析");
  }, [query, fetchAnalysis, flash]);

  async function analyzeAndOpen(symbol: string, screenerContext?: import("./StrategyScanView").ScanSelected) {
    setQuery(symbol);
    // 将选股榜单行数据暂存，供 fetchAnalysis 携带至 AI 分析接口
    pendingScreenerContext.current = screenerContext ?? null;
    navigate("analysis", symbol);
    // 关键修复：从选股榜单/关注/持仓列表点「分析」时，必须真正拉取该股票的分析，
    // 否则 analysis 仍是上一次的股票，「记录买入」对话框的技术面建议（支撑位/1R/2R）会停留在旧股票。
    await fetchAnalysis(symbol, true);
  }

  async function addWatch(stock = analysis?.stock) {
    if (!stock) {
      flash("请先分析一只股票");
      return;
    }
    try {
      const result = await jsonRequest<{ existed?: boolean }>("/api/watchlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ symbol: stock.code, name: stock.name, note: "等待自己的买入条件" }),
      });
      await loadData();
      flash(result?.existed ? `${stock.name}已在关注列表中` : `${stock.name}已加入关注`);
    } catch (saveError) {
      flash(saveError instanceof Error ? saveError.message : "加入关注失败");
    }
  }

  async function saveTrade(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const side = tradeMode === "sell" ? "卖出" : "买入";
    const payload = {
      symbol: String(data.get("symbol")),
      name: String(data.get("name")),
      side,
      price: Number(data.get("price")),
      quantity: Number(data.get("quantity")),
      tradeDate: String(data.get("tradeDate")),
      reason: String(data.get("reason")),
      otherReason: String(data.get("otherReason") || ""),
      maxLoss: Number(data.get("maxLoss") || 0),
      fee: Number(data.get("fee") || 0),
      stopLoss: data.get("stopLoss") ? Number(data.get("stopLoss")) : undefined,
      takeProfit1: data.get("takeProfit1") ? Number(data.get("takeProfit1")) : undefined,
      takeProfit2: data.get("takeProfit2") ? Number(data.get("takeProfit2")) : undefined,
    };

    try {
      const saved = await jsonRequest<{ trade: Trade }>("/api/trades", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });

      setTradeMode(null);
      await loadData();
      flash(`${payload.name}的${side}记录已保存`);
      if (side === "卖出") {
        const closedCycle = buildTradeCycles([...trades, saved.trade]).find(
          (cycle) => cycle.endTradeId === saved.trade.id
        );
        if (closedCycle?.endTradeId) setReviewCycleEndTradeId(closedCycle.endTradeId);
      }
    } catch (saveError) {
      flash(saveError instanceof Error ? saveError.message : "交易记录保存失败");
    }
  }

  async function updateAlert(id: number, action = "acknowledge") {
    try {
      await jsonRequest("/api/alerts", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, action }),
      });
      await loadData();
      flash(action === "disable" ? "提醒已停用" : "提醒已确认");
    } catch (updateError) {
      flash(updateError instanceof Error ? updateError.message : "提醒更新失败");
    }
  }

  async function updateAlertPrice(id: number, targetPrice: number) {
    try {
      await jsonRequest("/api/alerts", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, action: "update", targetPrice }),
      });
      // 服务端已清空该提醒的触发状态，本地去重集合也要同步清掉，
      // 否则本次会话内改价后的提醒不会再次触发。
      notified.current.delete(id);
      await loadData();
      flash("目标价已更新");
    } catch (updateError) {
      flash(updateError instanceof Error ? updateError.message : "目标价更新失败");
    }
  }

  async function deleteTrade(id: number) {
    try {
      await jsonRequest(`/api/trades?id=${id}`, { method: "DELETE" });
      await loadData();
      flash("交易记录已删除");
    } catch (deleteError) {
      flash(deleteError instanceof Error ? deleteError.message : "交易记录删除失败");
    }
  }

  async function requestNotifications() {
    if (!("Notification" in window)) {
      flash("当前浏览器不支持系统通知");
      return;
    }
    const permission = await Notification.requestPermission();
    flash(permission === "granted" ? "浏览器通知已开启" : "浏览器通知未开启");
    setSettingsSection("alerts");
  }

  async function saveInitialCapital(initialCapital: number) {
    const result = await jsonRequest<{ initialCapitalCents: number }>("/api/account", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ initialCapital }),
    });
    setInitialCapitalCents(result.initialCapitalCents);
    await reloadAccount();
    flash("账户初始资金已保存");
  }

  async function reloadAccount() {
    try {
      const accountData = await jsonRequest<{ initialCapitalCents: number | null; capitalFlows: CapitalFlow[] }>("/api/account");
      setInitialCapitalCents(accountData.initialCapitalCents);
      setCapitalFlows(accountData.capitalFlows);
    } catch { /* 静默忽略 */ }
  }

  async function handleAddFlow(amountCents: number, flowDate: string, note: string) {
    await jsonRequest<{ ok: boolean }>("/api/account", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "create_flow", amountCents, flowDate, note }),
    });
    await reloadAccount();
  }

  async function handleDeleteFlow(flowId: number) {
    await jsonRequest<{ ok: boolean }>("/api/account", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "delete_flow", flowId }),
    });
    await reloadAccount();
  }

  const analyzedPosition = portfolio.positions.find((position) => position.symbol === analysis?.stock.code);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const currentTradeStock = tradeMode === "sell"
    ? analyzedPosition ?? portfolio.positions[0] ?? null
    : analysis?.stock ?? null;
  const reviewCycle = reviewCycleEndTradeId === null
    ? null
    : closedCycles.find((cycle) => cycle.endTradeId === reviewCycleEndTradeId) ?? null;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button className="brand" onClick={() => navigate("home")}>
          <span className="brand-mark">股</span>
          <span><strong>我的复盘助手</strong><small>看懂 · 记录 · 复盘</small></span>
        </button>
        <nav aria-label="主导航">
          {navItems.map((item) => {
            const NavIcon = item.icon;
            return (
              <button key={item.id} className={view === item.id ? "nav-item active" : "nav-item"} onClick={() => navigate(item.id)}>
                <span><NavIcon size={19} /></span>{item.label}
              </button>
            );
          })}
        </nav>
        <div className="safety-note">
          <span>给新手的提醒</span>
          <p>本应用只负责解释信息，不替你决定买卖。重要止损请同时在券商App设置。</p>
        </div>
        <div className="source-status">
          <i />
          <span><b>{status?.deepseekConfigured ? "在线分析" : "自动解释模式"}</b><small>{status?.mairuiEnabled ? "麦蕊智数(优先) + 腾讯/东方财富" : (status?.dataSource ?? "正在检查数据源")}</small></span>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="topbar-brand">
            <span className="mobile-brand">我的复盘助手</span>
            <h1>{navItems.find((item) => item.id === view)?.label}</h1>
            <span className="privacy-pill"><ShieldCheck size={14} />私有个人空间</span>
          </div>
          <div className="top-actions">
            <button className="account-button" onClick={() => setConfirming("logout")} title={`当前账号：${user.email}`}>
              <span className="avatar">{(user.displayName || "?").slice(0, 1).toUpperCase()}</span>
              <b>{user.displayName}</b>
              <LogOut size={15} aria-label="退出" />
            </button>
            <Button variant="primary" iconLeft={<Plus size={16} />} onClick={() => setTradeMode("buy")}>记录买入</Button>
          </div>
        </header>

        {error && (
          <div className="global-error-bar">
            <Banner tone="danger" onDismiss={() => setError("")}>{error}</Banner>
          </div>
        )}
        {loading ? <LoadingState label="正在读取你的个人记录…" /> : (
          <>
            {view === "home" && (
              <Home
                portfolio={portfolio}
                portfolioInsights={portfolioInsights}
                quotes={quotes}
                alerts={alerts}
                pendingReviews={pendingReviews}
                trades={trades}
                reviews={reviews}
                onBuy={() => setTradeMode("buy")}
                onNavigate={navigate}
                onReview={setReviewCycleEndTradeId}
                onAlertPlan={() => { setSettingsSection("alerts"); navigate("settings"); }}
                onAcknowledge={(id) => void updateAlert(id)}
                onCapitalSettings={() => { setSettingsSection("account"); navigate("settings"); }}
              />
            )}
            {view === "analysis" && (
              <StockAnalysisPanel
                query={query}
                setQuery={setQuery}
                analysis={analysis}
                analyzing={analyzing}
                portfolio={portfolio}
                portfolioInsights={portfolioInsights}
                watched={analysis ? watchlist.some((item) => item.symbol === analysis.stock.code) : false}
                watchlist={watchlist}
                recentAnalyses={recentAnalyses}
                initialSymbol={searchParams.get("symbol") ?? ""}
                onPickRecent={(item) => void fetchAnalysis(item.stock.code, true)}
                onRemoveRecent={removeRecentAnalysis}
                onAnalyze={analyzeStock}
                onReanalyze={reanalyzeStock}
                onBuy={() => setTradeMode("buy")}
                onSell={() => setTradeMode("sell")}
                onWatch={() => void addWatch()}
              />
            )}
            {view === "analytics" && portfolioInsights && (
              <div className="page-content inner-page">
                <AnalyticsView
                  trades={trades}
                  capitalFlows={capitalFlows}
                  reviews={reviews}
                  portfolioInsights={portfolioInsights}
                  initialCapitalCents={initialCapitalCents}
                />
              </div>
            )}
            {view === "watchlist" && (
              <Watchlist
                items={watchlist}
                quotes={quotes}
                onSearch={() => navigate("analysis")}
                onAnalyze={(symbol) => void analyzeAndOpen(symbol)}
                onSaved={() => void loadData()}
              />
            )}
            {view === "trades" && (
              <Trades
                trades={trades}
                reviews={reviews}
                alerts={alerts}
                capitalFlows={capitalFlows}
                initialCapitalCents={initialCapitalCents}
                onBuy={() => setTradeMode("buy")}
                onSell={() => setTradeMode("sell")}
                onReview={setReviewCycleEndTradeId}
                onDeleteTrade={(id) => void deleteTrade(id)}
              />
            )}
            {view === "settings" && (
              <Settings
                status={status}
                initialCapitalCents={initialCapitalCents}
                capitalFlows={capitalFlows}
                alerts={alerts}
                section={settingsSection}
                onSection={setSettingsSection}
                onDisable={(id) => void updateAlert(id, "disable")}
                onAcknowledge={(id) => void updateAlert(id, "acknowledge")}
                onUpdateAlert={(id, targetPrice) => void updateAlertPrice(id, targetPrice)}
                onNotifications={() => void requestNotifications()}
                onSaveCapital={saveInitialCapital}
                onAddFlow={handleAddFlow}
                onDeleteFlow={handleDeleteFlow}
                preferences={preferences}
                onSavePreferences={savePreferences}
                onImported={loadData}
                onClearCache={() => setConfirming("clearCache")}
                currentUser={user}
              />
            )}
            {view === "scan" && (
              <div className="page-content inner-page">
                <StrategyScanView
                  initialData={strategyScan}
                  watchlistItems={watchlist}
                  onAddWatch={async (code, name) => {
                    try {
                      const result = await jsonRequest<{ existed?: boolean }>("/api/watchlist", {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({ symbol: code, name, note: "选股榜单加入" }),
                      });
                      flash(result?.existed ? `${name}(${code}) 已在关注列表中` : `已将 ${name}(${code}) 加入关注`);
                      await loadData();
                    } catch (e) {
                      flash(`加入关注失败: ${e instanceof Error ? e.message : String(e)}`);
                    }
                  }}
                  onAnalyze={(symbol) => void analyzeAndOpen(symbol)}
                />
              </div>
            )}
            {view === "writeback" && <div className="page-content inner-page"><WritebackView /></div>}
          </>
        )}
      </main>

      <nav className="mobile-nav" aria-label="移动端导航">
        {navItems.map((item) => {
          const NavIcon = item.icon;
          return (
            <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => navigate(item.id)}>
              <NavIcon size={20} />{item.label}
            </button>
          );
        })}
      </nav>

      {tradeMode && (
        <TradeModal
          mode={tradeMode}
          stock={currentTradeStock}
          positions={portfolio.positions}
          analysisQuote={tradeMode === "buy" ? analysis?.quote ?? null : null}
          onClose={() => setTradeMode(null)}
          onSubmit={saveTrade}
          onSwitchStock={async (symbol) => { await fetchAnalysis(symbol, true); }}
        />
      )}
      {reviewCycle && (
        <ReviewModal
          cycle={reviewCycle}
          onClose={() => setReviewCycleEndTradeId(null)}
          onSaved={async () => { setReviewCycleEndTradeId(null); await loadData(); flash("复盘已保存"); }}
        />
      )}
      {toast && <div className="toast" role="status" aria-live="polite"><CheckCircle2 size={19} />{toast}</div>}
      <FloatingAssistantLauncher
        open={assistantOpen}
        onToggle={() => setAssistantOpen((value) => !value)}
        analysis={analysis}
        position={analyzedPosition ?? null}
        portfolioInsights={portfolioInsights}
        portfolio={portfolio}
        watchlist={watchlist}
        recentAnalyses={recentAnalyses}
        fetchAnalysis={fetchAnalysis}
        userId={user.id}
        strategyScan={strategyScan}
      />
      <ConfirmDialog
        open={confirming === "logout"}
        eyebrow="确认操作"
        title="退出登录？"
        message="退出后需要重新登录才能使用。确定要退出吗？"
        confirmLabel="确认退出"
        tone="danger"
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          // 退出登录时清空本地行情/最近分析缓存，避免不同账号间数据残留
          removeCache("quotes");
          removeCache("recent");
          window.location.href = signOutUrl;
        }}
      />
      <ConfirmDialog
        open={confirming === "clearCache"}
        eyebrow="确认操作"
        title="清空本地分析缓存？"
        message="将清除浏览器中保存的最近 6 条分析记录与行情快照，不影响服务器上的交易、关注、复盘等数据。确定要清空吗？"
        confirmLabel="确认清空"
        tone="danger"
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          clearLocalCache();
          setConfirming(null);
        }}
      />
    </div>
  );
}

const REVIEW_THEMES: Array<{ key: string; label: string; words: string[] }> = [
  { key: "stop", label: "止损纪律", words: ["止损", "割肉", "砍仓", "止损线", "破位"] },
  { key: "size", label: "仓位控制", words: ["仓位", "满仓", "轻仓", "重仓", "加仓", "补仓", "资金"] },
  { key: "chase", label: "追涨杀跌", words: ["追涨", "追高", "追", "杀跌", "抄底", "跟风"] },
  { key: "panic", label: "情绪管理", words: ["慌", "恐慌", "恐惧", "焦虑", "贪婪", "冲动", "上头", "怕"] },
  { key: "plan", label: "交易计划", words: ["计划", "纪律", "规则", "预案", "策略", "条件"] },
  { key: "freq", label: "频繁交易", words: ["频繁", "短线", "来回", "做t", "日内", "炒"] },
  { key: "hold", label: "持仓耐心", words: ["持有", "拿住", "耐心", "过早", "卖飞"] },
];

function getCycleSummary(cycle: TradeCycle) {
  const buys = cycle.trades.filter((trade) => trade.side === "买入");
  const sells = cycle.trades.filter((trade) => trade.side === "卖出");
  const buyQty = buys.reduce((sum, trade) => sum + trade.quantity, 0);
  const sellQty = sells.reduce((sum, trade) => sum + trade.quantity, 0);
  const buyCostCents = buys.reduce(
    (sum, trade) => sum + ((trade.priceTenThousandths ?? 0) / 10000) * trade.quantity * 100 + trade.feeCents,
    0,
  );
  const sellProceedsCents = sells.reduce(
    (sum, trade) => sum + ((trade.priceTenThousandths ?? 0) / 10000) * trade.quantity * 100 - trade.feeCents,
    0,
  );
  const buyAvgPrice = buyQty ? buyCostCents / buyQty / 100 : 0;
  const sellAvgPrice = sellQty ? sellProceedsCents / sellQty / 100 : 0;
  const realizedCents = cycle.realizedCents;
  const returnPct = buyCostCents ? (realizedCents / buyCostCents) * 100 : null;
  const start = new Date(cycle.startDate);
  const end = cycle.endDate ? new Date(cycle.endDate) : null;
  const holdingDays = end ? Math.max(0, Math.round((end.getTime() - start.getTime()) / 86400000)) : 0;
  const planLossCents = buys.reduce((max, trade) => Math.max(max, trade.maxLossCents ?? 0), 0);
  const hasPlan = planLossCents > 0;
  const withinPlan = hasPlan ? realizedCents >= -planLossCents : null;
  return { buyAvgPrice, sellAvgPrice, realizedCents, returnPct, holdingDays, planLossCents, hasPlan, withinPlan };
}

function summarizeReviews(reviews: Review[], completedCycles: TradeCycle[], pendingReviews: TradeCycle[]) {
  const reviewedEndIds = new Set(reviews.map((review) => review.cycleEndTradeId));
  const reviewedCycles = completedCycles.filter(
    (cycle) => cycle.endTradeId !== null && reviewedEndIds.has(cycle.endTradeId),
  );
  const planRate = reviews.length
    ? Math.round((reviews.filter((review) => review.followedPlan).length / reviews.length) * 100)
    : 0;

  const counts: Record<string, { label: string; count: number }> = {};
  for (const review of reviews) {
    const text = review.lesson ?? "";
    for (const theme of REVIEW_THEMES) {
      if (theme.words.some((word) => text.includes(word))) {
        if (!counts[theme.key]) counts[theme.key] = { label: theme.label, count: 0 };
        counts[theme.key].count += 1;
      }
    }
  }
  const top = Object.values(counts).sort((a, b) => b.count - a.count)[0] ?? null;

  let avgHoldingDays: number | null = null;
  let avgReturnPct: number | null = null;
  if (reviewedCycles.length) {
    const days = reviewedCycles.reduce((sum, cycle) => sum + getCycleSummary(cycle).holdingDays, 0);
    avgHoldingDays = Math.round(days / reviewedCycles.length);
    const pcts = reviewedCycles
      .map((cycle) => getCycleSummary(cycle).returnPct)
      .filter((value): value is number => value !== null);
    avgReturnPct = pcts.length ? pcts.reduce((a, b) => a + b, 0) / pcts.length : null;
  }

  let advice: string;
  let headline: string;
  if (reviews.length === 0) {
    advice = "继续记录，等完成一轮完整买卖后再总结，不凭一笔输赢下结论。";
    headline = "暂无复盘";
  } else if (pendingReviews.length && reviews.length < 3) {
    advice = "完成最近一笔待复盘，只找一个最值得改的动作。";
    headline = "先做复盘";
  } else if (top && top.count >= 2) {
    advice = `你最近 ${reviews.length} 次复盘里，有 ${top.count} 次提到「${top.label}」，这是当前最值得死磕的一件事。先把这一条变成下一笔交易的检查项，比记十条都管用。`;
    headline = `高频主题：${top.label}`;
  } else {
    const latest = reviews[0];
    advice = `最近一次复盘你写：「${latest.lesson}」。把这一条先落实到下一笔交易，再谈优化其他。`;
    headline = latest.lesson.length > 22 ? `${latest.lesson.slice(0, 22)}…` : latest.lesson;
  }
  return { advice, headline, planRate, avgHoldingDays, avgReturnPct, topTheme: top };
}

function StockAnalysisPanel({
  query,
  setQuery,
  analysis,
  analyzing,
  portfolio,
  portfolioInsights,
  watched,
  recentAnalyses,
  initialSymbol,
  onPickRecent,
  onRemoveRecent,
  onAnalyze,
  onReanalyze,
  onBuy,
  onSell,
  onWatch,
  watchlist,
}: {
  query: string;
  setQuery: (value: string) => void;
  analysis: Analysis | null;
  analyzing: boolean;
  portfolio: ReturnType<typeof calculatePortfolio>;
  portfolioInsights: PortfolioInsights;
  watched: boolean;
  watchlist: WatchItem[];
  recentAnalyses: Analysis[];
  initialSymbol: string;
  onPickRecent: (item: Analysis) => void;
  onRemoveRecent: (code: string) => void;
  onAnalyze: (event?: React.FormEvent, overrideQuery?: string) => Promise<void>;
  onReanalyze: () => Promise<void>;
  onBuy: () => void;
  onSell: () => void;
  onWatch: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  // 由 URL 带入的股票代码（关注列表 / 策略扫描 / 直接分享链接）只需在首次挂载时自动分析一次；
  // 用 ref 兜底，避免 <Suspense> 下 Dashboard 双挂载导致重复触发，也防止后续重渲染无谓请求。
  const didAutoAnalyze = useRef(false);
  useEffect(() => {
    if (!initialSymbol?.trim()) return;
    if (didAutoAnalyze.current) return;
    didAutoAnalyze.current = true;
    setQuery(initialSymbol.trim());
    inputRef.current?.focus();
    void onAnalyze(undefined, initialSymbol.trim());
  }, [initialSymbol, onAnalyze, setQuery]);

  // 合并「关注列表 + 最近分析」作为搜索联想来源，按分组返回
  const searchSuggestions = useMemo((): StockSuggestionGroup[] => {
    const groups: StockSuggestionGroup[] = [];

    // 关注列表
    const watchItems: StockSuggestion[] = [];
    const watchSeen = new Set<string>();
    for (const item of watchlist) {
      if (watchSeen.has(item.symbol)) continue;
      watchSeen.add(item.symbol);
      watchItems.push({ symbol: item.symbol, name: item.name });
    }
    if (watchItems.length > 0) {
      groups.push({ label: "关注列表", items: watchItems });
    }

    // 最近分析（排除已在关注中的）
    const recentItems: StockSuggestion[] = [];
    for (const item of recentAnalyses) {
      if (watchSeen.has(item.stock.code)) continue;
      recentItems.push({ symbol: item.stock.code, name: item.stock.name });
    }
    if (recentItems.length > 0) {
      groups.push({ label: "最近分析", items: recentItems.slice(0, 10) });
    }

    return groups;
  }, [watchlist, recentAnalyses]);

  return (
    <div className="page-content inner-page">
      {recentAnalyses.length > 0 && (
        <div className="recent-bar">
          <span className="recent-bar__label">最近查询</span>
          <div className="recent-bar__chips">
            {recentAnalyses.map((item) => (
              <span
                key={item.stock.code}
                className={analysis && analysis.stock.code === item.stock.code ? "recent-chip is-active" : "recent-chip"}
              >
                <button
                  type="button"
                  className="recent-chip__content"
                  onClick={() => onPickRecent(item)}
                >
                  {item.stock.name} <span className="recent-chip__code">{item.stock.code}</span>
                </button>
                <button
                  type="button"
                  className="recent-chip__close"
                  onClick={(event) => {
                    event.stopPropagation();
                    onRemoveRecent(item.stock.code);
                  }}
                  aria-label={`移除 ${item.stock.name}`}
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        </div>
      )}
      <section className={analysis ? "search-hero compact" : "search-hero"}>
        {!analysis && <span className="eyebrow">公开数据 + 自动解读 · 你来做决定</span>}
        <h2>{analysis ? "继续查" : "输入代码，先把它看懂。"}</h2>
        {!analysis && <p>输入股票代码或名称，系统自动整理行情、财务与题材，你负责最后的判断。</p>}
        <StockSearch
          compact={!!analysis}
          value={query}
          onChange={setQuery}
          onSubmit={() => { void onAnalyze(); }}
          onSelect={(symbol) => { void onAnalyze(undefined, symbol); }}
          loading={analyzing}
          suggestions={searchSuggestions}
          inputRef={inputRef}
        />
        <div className="search-meta"><span>无需股票数据账号</span><i /><span>结果标明数据时间</span><i /><span>不提供买卖建议</span></div>
      </section>

      {analysis ? (
        <AnalysisView
          analysis={analysis}
          position={portfolio.positions.find((position) => position.symbol === analysis.stock.code) ?? null}
          portfolioInsights={portfolioInsights}
          watched={watched}
          canSell={portfolio.positions.some((position) => position.symbol === analysis.stock.code)}
          analyzing={analyzing}
          onWatch={onWatch}
          onBuy={onBuy}
          onSell={onSell}
          onReanalyze={onReanalyze}
        />
      ) : (
        <div className="empty-state analysis-empty">还没有分析记录。输入一只股票代码，系统会整理它的行情、财务与题材，帮你把这只股票先看懂。</div>
      )}
    </div>
  );
}

function Home({
  portfolio, portfolioInsights, quotes, alerts, pendingReviews,
  trades, reviews, onBuy, onNavigate,
  onReview, onAlertPlan, onAcknowledge, onCapitalSettings,
}: {
  portfolio: ReturnType<typeof calculatePortfolio>;
  portfolioInsights: PortfolioInsights;
  quotes: Record<string, QuoteEntry>;
  alerts: AlertRule[];
  pendingReviews: TradeCycle[];
  trades: Trade[];
  reviews: Review[];
  onBuy: () => void;
  onNavigate: (view: View) => void;
  onReview: (cycleEndTradeId: number) => void;
  onAlertPlan: () => void;
  onAcknowledge: (id: number) => void;
  onCapitalSettings: () => void;
}) {
  const activeAlerts = alerts.filter((alert) => alert.enabled && !alert.acknowledgedAt);
  const completedCycles = buildTradeCycles(trades).filter((cycle) => cycle.endTradeId !== null);
  const winningCycles = completedCycles.filter((cycle) => cycle.realizedCents > 0).length;
  const winRate = completedCycles.length ? Math.round((winningCycles / completedCycles.length) * 100) : 0;
  const planRate = reviews.length ? Math.round((reviews.filter((review) => review.followedPlan).length / reviews.length) * 100) : 0;
  const reviewSummary = summarizeReviews(reviews, completedCycles, pendingReviews);

  return (
    <div className="page-content inner-page">
      {!trades.length && <BeginnerStart onBuy={onBuy} />}
      <div className="home-cols">
            <div className="home-main">
              <PortfolioOverview insights={portfolioInsights} onConfigure={onCapitalSettings} />
              <SectionHeader title="我的持仓" actions={<Button variant="link" size="sm" iconRight={<ChevronRight size={14} />} onClick={() => onNavigate("trades")}>查看交易记录</Button>} />
              {portfolio.positions.length ? (
                <div className={`holding-grid${portfolio.positions.length <= 2 ? " holding-grid-few" : ""}`}>
                  {portfolio.positions.map((position) => {
                    const quote = quotes[position.symbol]?.quote.price;
                    const insight = portfolioInsights.positions.find((item) => item.symbol === position.symbol);
                    const profitCents = insight?.unrealizedCents ?? 0;
                    const rate = quote ? insight?.returnPercent ?? null : null;
                    const stop = activeAlerts.find((item) => item.symbol === position.symbol && item.type === "止损");
                    const take1 = activeAlerts.find((item) => item.symbol === position.symbol && item.type === "止盈一");
                    const take2 = activeAlerts.find((item) => item.symbol === position.symbol && item.type === "止盈二");
                    return (
                      <article className="holding-card" key={position.symbol}>
                        <div className="holding-top">
                          <span className="stock-avatar">{position.name.slice(0, 1)}</span>
                          <div><h4>{position.name}<small>{position.symbol}</small></h4><p>{position.quantity}股 · 成本{position.legacyPrecision ? "约" : ""}{tenThousandthsPrice(position.averageCostTenThousandths)}</p></div>
                          <strong className={(rate ?? 0) >= 0 ? "up" : "down"}>{rate === null ? "行情更新中" : `${rate >= 0 ? "+" : ""}${rate.toFixed(2)}%`}</strong>
                        </div>
                        <div className="risk-line"><span>{insight?.allocationPercent !== null && insight?.allocationPercent !== undefined ? `${portfolioInsights.configured ? "账户仓位" : "持仓内部占比"} ${insight.allocationPercent.toFixed(1)}%` : "按当前参考价计算"}</span><b>{quote ? money(profitCents) : "暂无"}</b></div>
                        <div className="holding-alerts">
                          <span className={`holding-status ${stop ? "amber" : ""}`}><i />{stop ? `止损 ${alertPrice(stop)}` : "未设止损"}</span>
                          <span className="holding-status take">{take1 ? `止盈一 ${alertPrice(take1)}` : "无止盈一"}</span>
                          <span className="holding-status take">{take2 ? `止盈二 ${alertPrice(take2)}` : "无止盈二"}</span>
                        </div>
                      </article>
                    );
                  })}
                </div>
              ) : <div className="empty-state">还没有持仓。先查一只股票，或记录你的第一笔买入。</div>}

              <div className="summary-strip home-summary">
                <div><span>已实现盈亏</span><strong className={portfolio.realizedCents >= 0 ? "up" : "down"}>{money(portfolio.realizedCents)}</strong></div>
                <div><span>完整交易胜率</span><strong>{completedCycles.length ? `${winRate}%` : "暂无"}</strong></div>
                <div><span>按计划复盘</span><strong>{reviews.length ? `${planRate}%` : "暂无"}</strong></div>
                <div><span>复盘洞察</span><strong className="summary-lesson">{reviewSummary.headline}</strong></div>
              </div>

              {!!trades.length && (
                <BehaviorCoach
                  trades={trades}
                  completedCycles={completedCycles}
                  reviews={reviews}
                  pendingReviews={pendingReviews}
                  onReview={onReview}
                />
              )}

              {/* 大盘行情：指数 + 板块热力，占通栏两列，宽度充足更易读 */}
              <div className="home-market">
                <MarketIndices />
                <SectorHeatmap />
              </div>
            </div>

            <aside className="home-side">
              <section className="panel reminder-panel">
                <SectionHeader title="价格提醒" subtitle="页面打开期间每5分钟检查" />
                {[...activeAlerts]
                  .sort((a, b) => (a.triggeredAt ? 0 : 1) - (b.triggeredAt ? 0 : 1))
                  .slice(0, 3)
                  .map((alert) => {
                    const quote = quotes[alert.symbol]?.quote;
                    const triggered = !!alert.triggeredAt;
                    return (
                      <div className={`reminder ${triggered ? "triggered" : ""}`} key={alert.id}>
                        <span className={`reminder-icon ${alert.type === "止损" ? "red" : "amber"}`}>!</span>
                        <div>
                          <b>{alert.name} · {alert.type}</b>
                          <p>目标价 {alertPrice(alert)} · 免费行情可能延迟</p>
                          {triggered && <p className="triggered-line">{quote ? `已触发，当前 ${price(quote.price)}` : "已触发，行情待更新"}</p>}
                          {triggered && <span className="triggered-badge">已触发</span>}
                        </div>
                        <div className="reminder-actions">
                          <Button variant="ghost" size="sm" onClick={onAlertPlan}>查看计划</Button>
                          <Button variant="ghost" size="sm" onClick={() => onAcknowledge(alert.id)}>我知道了</Button>
                        </div>
                      </div>
                    );
                  })}
                {!activeAlerts.length && <div className="empty-inline">暂无提醒。记录买入并填写最大亏损后会自动生成。</div>}
              </section>
              <section className="panel review-panel">
                <SectionHeader title="待复盘" subtitle="卖出后只回答三个问题" />
                {pendingReviews.slice(0, 3).map((cycle) => {
                  return (
                    <div className="review-item" key={cycle.endTradeId}>
                      <span className="stock-avatar pale">{cycle.name.slice(0, 1)}</span>
                      <div><b>{cycle.name}</b><p>{cycle.startDate} 至 {cycle.endDate} · 持有 {getCycleSummary(cycle).holdingDays} 天 · {money(cycle.realizedCents)}</p></div>
                      <Button variant="ghost" size="sm" iconRight={<ChevronRight size={14} />} onClick={() => onReview(cycle.endTradeId!)}>开始复盘</Button>
                    </div>
                  );
                })}
                {!pendingReviews.length && <div className="empty-inline">目前没有待复盘交易。</div>}
                <div className="simple-rule"><span>复盘不考试</span><p>只看：为什么买、为什么卖、有没有按计划。</p></div>
              </section>
            </aside>
          </div>
    </div>
  );
}

function PortfolioOverview({ insights, onConfigure }: { insights: PortfolioInsights; onConfigure: () => void }) {
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const points = insights.history;
  const width = 900;
  const height = 210;
  const assets = points.map((point) => point.totalAssetsCents);
  const minAssets = Math.min(...assets, 0);
  const maxAssets = Math.max(...assets, 1);
  const assetRange = Math.max(maxAssets - minAssets, 1);
  const x = (index: number) => points.length <= 1 ? 0 : index / (points.length - 1) * width;
  const assetY = (value: number) => 12 + (maxAssets - value) / assetRange * 150;
  const positionY = (value: number) => 12 + (100 - Math.max(0, Math.min(100, value))) / 100 * 150;
  const assetLine = points.map((point, index) => `${x(index).toFixed(1)},${assetY(point.totalAssetsCents).toFixed(1)}`).join(" ");
  const positionLine = points.map((point, index) => `${x(index).toFixed(1)},${positionY(point.positionPercent).toFixed(1)}`).join(" ");
  const selectedPoint = selectedIndex === null ? null : points[selectedIndex];
  const selectedMarketValue = selectedPoint
    ? Math.round(selectedPoint.totalAssetsCents * selectedPoint.positionPercent / 100)
    : 0;
  const selectedCash = selectedPoint ? selectedPoint.totalAssetsCents - selectedMarketValue : 0;
  const previousAssets = selectedIndex !== null && selectedIndex > 0 ? points[selectedIndex - 1].totalAssetsCents : null;
  const selectedDailyProfit = selectedPoint && previousAssets !== null
    ? selectedPoint.totalAssetsCents - previousAssets
    : null;
  const tooltipX = selectedIndex === null ? 0 : x(selectedIndex) > width / 2 ? x(selectedIndex) - 242 : x(selectedIndex) + 12;

  function selectAtPointer(event: ReactPointerEvent<SVGSVGElement>) {
    const matrix = event.currentTarget.getScreenCTM();
    if (!matrix || !points.length) return;
    const point = event.currentTarget.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const pointer = point.matrixTransform(matrix.inverse());
    if (pointer.x < 0 || pointer.x > width || pointer.y < 0 || pointer.y > 170) {
      setSelectedIndex(null);
      return;
    }
    const index = points.length <= 1
      ? 0
      : Math.round(Math.max(0, Math.min(width, pointer.x)) / width * (points.length - 1));
    setSelectedIndex(index);
  }

  function navigateChart(event: ReactKeyboardEvent<SVGSVGElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End", "Escape"].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "Escape") return setSelectedIndex(null);
    if (event.key === "Home") return setSelectedIndex(0);
    if (event.key === "End") return setSelectedIndex(points.length - 1);
    const current = selectedIndex ?? points.length - 1;
    setSelectedIndex(Math.max(0, Math.min(points.length - 1, current + (event.key === "ArrowLeft" ? -1 : 1))));
  }

  return (
    <section className="panel portfolio-overview">
      <SectionHeader eyebrow="账户全景" title="我的仓位与盈亏" actions={!insights.configured && <Button variant="primary" onClick={onConfigure}>设置账户初始资金</Button>} />
      <div className="portfolio-metrics">
        <Stat label="总资产" value={insights.totalAssetsCents === null ? "待设置" : money(insights.totalAssetsCents)} hint="现金 + 当前持仓市值" />
        <Stat label="总仓位" value={insights.totalPositionPercent === null ? "待设置" : `${insights.totalPositionPercent.toFixed(1)}%`} hint="持仓市值 ÷ 总资产" />
        <Stat label="持仓市值" value={money(insights.marketValueCents)} hint={insights.completePrices ? "按当前参考价" : "部分行情仍在更新"} />
        <Stat label="可用现金" value={insights.cashCents === null ? "待设置" : money(insights.cashCents)} hint="按初始资金和交易流水估算" />
        <Stat label="持仓浮盈亏" value={<span className={insights.unrealizedCents >= 0 ? "up" : "down"}>{money(insights.unrealizedCents)}</span>} hint="当前市值 - 持仓成本" />
        <Stat label="账户总盈亏" value={<span className={(insights.totalProfitCents ?? 0) >= 0 ? "up" : "down"}>{insights.totalProfitCents === null ? "待设置" : money(insights.totalProfitCents)}</span>} hint={insights.totalProfitPercent === null ? "需要资金基准" : `${insights.totalProfitPercent >= 0 ? "+" : ""}${insights.totalProfitPercent.toFixed(2)}%`} />
      </div>
      {points.length >= 2 ? (
        <div className="portfolio-chart-wrap">
          <div className="portfolio-chart-legend"><span className="asset">总资产</span><span className="position">总仓位</span></div>
          <p className="chart-interaction-hint">移动鼠标或点按查看每天的资产、现金与仓位，键盘可使用左右方向键。</p>
          <svg
            className="portfolio-chart"
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            tabIndex={0}
            aria-label="账户总资产和总仓位历史走势图。移动鼠标、点按或使用左右方向键查看每天明细。"
            onPointerMove={selectAtPointer}
            onPointerDown={selectAtPointer}
            onPointerLeave={(event) => { if (event.pointerType !== "touch") setSelectedIndex(null); }}
            onKeyDown={navigateChart}
          >
            <line x1="0" y1="162" x2={width} y2="162" className="portfolio-axis" />
            <polyline points={assetLine} className="portfolio-asset-line" />
            <polyline points={positionLine} className="portfolio-position-line" />
            {selectedPoint && selectedIndex !== null && (
              <g className="portfolio-selection" pointerEvents="none">
                <line x1={x(selectedIndex)} x2={x(selectedIndex)} y1="5" y2="162" className="chart-crosshair" />
                <line x1="0" x2={width} y1={assetY(selectedPoint.totalAssetsCents)} y2={assetY(selectedPoint.totalAssetsCents)} className="chart-crosshair chart-crosshair-horizontal" />
                <circle cx={x(selectedIndex)} cy={assetY(selectedPoint.totalAssetsCents)} r="4" className="portfolio-asset-dot" />
                <circle cx={x(selectedIndex)} cy={positionY(selectedPoint.positionPercent)} r="4" className="portfolio-position-dot" />
                <g transform={`translate(${tooltipX}, 8)`} className="chart-tooltip portfolio-tooltip">
                  <rect width="230" height="132" rx="9" />
                  <text x="12" y="19" className="chart-tooltip-date">{selectedPoint.date}</text>
                  <text x="12" y="40">总资产 <tspan x="218" textAnchor="end">{money(selectedPoint.totalAssetsCents)}</tspan></text>
                  <text x="12" y="59">总仓位 <tspan x="218" textAnchor="end">{selectedPoint.positionPercent.toFixed(1)}%</tspan></text>
                  <text x="12" y="78">持仓市值 <tspan x="218" textAnchor="end">{money(selectedMarketValue)}</tspan></text>
                  <text x="12" y="97">可用现金 <tspan x="218" textAnchor="end">{money(selectedCash)}</tspan></text>
                  <text x="12" y="116">当日资产变化 <tspan x="218" textAnchor="end" className={(selectedDailyProfit ?? 0) >= 0 ? "chart-tooltip-up" : "chart-tooltip-down"}>{selectedDailyProfit === null ? "首日" : `${selectedDailyProfit >= 0 ? "+" : ""}${money(selectedDailyProfit)}`}</tspan></text>
                </g>
              </g>
            )}
            <text x="0" y="190">{points[0].date}</text>
            <text x={width} y="190" textAnchor="end">{points.at(-1)?.date}</text>
          </svg>
        </div>
      ) : (
        <p className="portfolio-chart-empty">{insights.configured ? "持仓行情加载后生成资产与仓位走势。" : "设置初始资金后，系统会根据交易流水生成总资产和仓位走势。"}</p>
      )}
      <p className="portfolio-method">计算口径：初始资金减买入、加卖出并扣除费用，再叠加当前持仓市值。若有场外转入转出，请更新资金基准。</p>
    </section>
  );
}

function BeginnerStart({ onBuy }: { onBuy: () => void }) {
  const [showExample, setShowExample] = useState(false);

  return (
    <section className="panel beginner-start">
      <SectionHeader layout="stack" size="lg" eyebrow="第一次使用，从这里开始" title="完成一轮真实记录，复盘才有价值。" subtitle="不用一次学会所有指标。先按三个步骤走完一笔交易，软件会开始总结你的行为。" />
      <div className="beginner-steps" aria-label="新手三步上手">
        <div><b>1</b><span><strong>先查清楚</strong><small>输入股票，读公司、风险和缺失信息。</small></span></div>
        <div><b>2</b><span><strong>买前写计划</strong><small>记录买入理由和最多接受亏损。</small></span></div>
        <div><b>3</b><span><strong>清仓后复盘</strong><small>只回答为什么买、为什么卖、是否按计划。</small></span></div>
      </div>
      <div className="beginner-actions">
        <Button variant="primary" iconLeft={<Plus size={16} />} onClick={onBuy}>记录第一笔买入</Button>
        <Button variant="link" onClick={() => setShowExample((value) => !value)}>
          {showExample ? "收起示例 ↑" : "先看一份完整示例 →"}
        </Button>
      </div>
      {showExample && (
        <div className="review-example">
          <div><span>示例结果</span><strong className="down">−8.6%</strong></div>
          <dl>
            <div><dt>为什么买？</dt><dd>朋友推荐后担心错过，没有先核验风险。</dd></div>
            <div><dt>为什么卖？</dt><dd>跌破原定风险线后又拖了两天，亏损继续扩大。</dd></div>
            <div><dt>按计划了吗？</dt><dd>没有。知道退出条件，但没有当天执行。</dd></div>
            <div><dt>下次只改一件事</dt><dd>买入前写好退出条件；触发后当天执行，不向下移动。</dd></div>
          </dl>
          <p>示例只展示复盘方法，不代表任何真实股票或收益。</p>
        </div>
      )}
    </section>
  );
}

function BehaviorCoach({
  trades,
  completedCycles,
  reviews,
  pendingReviews,
  onReview,
}: {
  trades: Trade[];
  completedCycles: TradeCycle[];
  reviews: Review[];
  pendingReviews: TradeCycle[];
  onReview: (cycleEndTradeId: number) => void;
}) {
  const buyTrades = trades.filter((trade) => trade.side === "买入");
  const plannedBuys = buyTrades.filter((trade) => (trade.maxLossCents ?? 0) > 0);
  const reasonCounts = new Map<string, number>();
  for (const trade of buyTrades) {
    reasonCounts.set(trade.reason, (reasonCounts.get(trade.reason) ?? 0) + 1);
  }
  const topReason = [...reasonCounts.entries()].sort((a, b) => b[1] - a[1])[0];

  const lossReasonCounts = new Map<string, number>();
  for (const cycle of completedCycles.filter((item) => item.realizedCents < 0)) {
    for (const trade of cycle.trades.filter((item) => item.side === "买入")) {
      lossReasonCounts.set(trade.reason, (lossReasonCounts.get(trade.reason) ?? 0) + 1);
    }
  }
  const lossPattern = [...lossReasonCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  const followedPlans = reviews.filter((review) => review.followedPlan).length;
  const summary = summarizeReviews(reviews, completedCycles, pendingReviews);

  return (
    <section className="panel behavior-coach">
      <SectionHeader layout="stack" size="lg" eyebrow="你的记录正在说什么" title="行为复盘" subtitle="样本少时只描述事实，不把偶然输赢当成规律。" />
      <div className="behavior-grid">
        <Stat label="买入计划覆盖" value={`${plannedBuys.length}/${buyTrades.length}`} hint="填写了最多接受亏损" />
        <Stat label="最常见买入原因" value={topReason?.[0] ?? "暂无"} hint={topReason ? `出现 ${topReason[1]} 次` : "继续记录后生成"} />
        <Stat label="亏损交易共性" value={lossPattern?.[0] ?? "暂无样本"} hint={lossPattern ? `${lossPattern[1]} 次亏损周期涉及此原因` : "完成亏损交易后再判断"} />
        <Stat label="按计划执行" value={reviews.length ? `${summary.planRate}%` : "暂无"} hint={reviews.length ? `${followedPlans}/${reviews.length} 次复盘` : "完成清仓复盘后生成"} />
      </div>
      {reviews.length > 0 && (
        <div className="review-insight-dims">
          {summary.avgHoldingDays !== null && <span>平均持有 {summary.avgHoldingDays} 天</span>}
          {summary.avgReturnPct !== null && <span>平均盈亏 {summary.avgReturnPct >= 0 ? "+" : ""}{summary.avgReturnPct.toFixed(1)}%</span>}
          {summary.topTheme && <span className="hot">复盘高频主题「{summary.topTheme.label}」</span>}
        </div>
      )}
      <div className="weekly-advice">
        <span>下一笔只改这一件事</span>
        <p>{summary.advice}</p>
        {!!pendingReviews.length && <Button variant="ghost" size="sm" iconRight={<ChevronRight size={14} />} onClick={() => onReview(pendingReviews[0].endTradeId!)}>现在去复盘</Button>}
      </div>
    </section>
  );
}

type MarketIndex = { code: string; name: string; price: number; changePercent: number; change: number };
type IndicesPayload = { indices: MarketIndex[]; source: { name: string; url: string; fetchedAt: string } };

function MarketIndices() {
  const [payload, setPayload] = useState<IndicesPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;
    jsonRequest<IndicesPayload>("/api/indices")
      .then((result) => { if (active) setPayload(result); })
      .catch((err) => { if (active) setMessage(err instanceof Error ? err.message : "大盘指数获取失败"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const formatPrice = (value: number) =>
    value.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <section className="panel market-indices-card" aria-label="大盘指数">
      <SectionHeader eyebrow="市场温度" title="大盘指数" subtitle="主要指数实时表现" />
      {loading && <div className="market-indices-state">正在获取大盘行情…</div>}
      {!loading && message && <div className="market-indices-state error" role="alert">{message}</div>}
      {!loading && payload && (
        <>
          <div className="index-strip">
            {payload.indices.map((index) => {
              const dir = index.changePercent > 0 ? "up" : index.changePercent < 0 ? "down" : "";
              return (
                <div className={`index-strip__item ${dir}`} key={`strip-${index.code}`}>
                  <span className="index-name">{index.name}</span>
                  <span className="index-price">{formatPrice(index.price)}</span>
                  <span className="index-change">
                    {index.changePercent >= 0 ? "+" : ""}{index.changePercent.toFixed(2)}%
                  </span>
                </div>
              );
            })}
          </div>
          <div className="market-indices-foot">
            <span>数据时间 {formatDateTimeShanghai(payload.source.fetchedAt)}</span>
            <a href={payload.source.url} target="_blank" rel="noreferrer">数据来源：{payload.source.name} ↗</a>
          </div>
        </>
      )}
    </section>
  );
}

function SectorHeatmap() {
  const [date, setDate] = useState(latestWeekday);
  const [data, setData] = useState<SectorHeatmapData | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");

  const load = useCallback(async (selectedDate: string) => {
    setLoading(true);
    setMessage("");
    try {
      const heatmap = await jsonRequest<SectorHeatmapData>(
        `/api/sector-heatmap?date=${encodeURIComponent(selectedDate)}&limit=9`,
      );
      setData(heatmap);
    } catch (loadError) {
      setData(null);
      setMessage(loadError instanceof Error ? loadError.message : "板块行情获取失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(date), 0);
    return () => window.clearTimeout(timer);
  }, [date, load]);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    void load(date);
  }

  return (
    <section className="panel sector-heatmap-card" aria-labelledby="sector-heatmap-title">
      <SectionHeader
        eyebrow={data?.basis === "etf-proxy" ? "行业主题ETF代理 · 前9名" : "板块异动 · 前9名"}
        title="板块异动热力图"
        subtitle="以代表性行业ETF观察板块强弱，按涨跌幅绝对值排序。"
        actions={
          <form className="sector-date-form" onSubmit={submit}>
            <label htmlFor="sector-date">查看日期</label>
            <div className="sector-date-input-wrap">
              <input
                id="sector-date"
                type="date"
                min="2018-01-01"
                max={localIsoDate()}
                value={date}
                onChange={(event) => setDate(event.target.value)}
              />
              <CalendarDays size={14} className="sector-date-icon" />
            </div>
            <button type="submit" disabled={loading}>{loading ? "加载中…" : "查看异动"}</button>
          </form>
        }
      />

      {loading && <div className="sector-heatmap-state" role="status">正在汇总行业板块行情…</div>}
      {!loading && message && (
        <div className="sector-heatmap-state error" role="alert">
          <b>暂时无法显示这一天的数据</b>
          <span>{message}</span>
        </div>
      )}
      {!loading && data && (
        <>
          <div className="sector-heatmap-grid">
            {data.sectors.map((sector, index) => {
              const direction = sector.changePercent > 0 ? "up-sector" : sector.changePercent < 0 ? "down-sector" : "flat-sector";
              return (
                <article className={`sector-tile ${direction} rank-${index + 1}`} key={sector.code}>
                  <div className="sector-tile-top">
                    <span className="sector-rank">#{index + 1}</span>
                    <small className="sector-arrow">{sector.changePercent >= 0 ? <ArrowUp size={12} /> : <ArrowDown size={12} />}</small>
                  </div>
                  <h4 className="sector-name">{sector.name}</h4>
                  <strong className="sector-change">{sector.changePercent >= 0 ? "+" : ""}{sector.changePercent.toFixed(2)}%</strong>
                  <p className="sector-amount">成交额 {compactAmount(sector.amount)}</p>
                </article>
              );
            })}
          </div>
          <div className="sector-heatmap-foot">
            <span>{data.date} · 覆盖 {data.sampleSize} 只代表性行业ETF</span>
            <a href={data.source.url} target="_blank" rel="noreferrer">数据来源：{data.source.name} ↗</a>
          </div>

        </>
      )}
    </section>
  );
}

function AnalysisView({ analysis, position, portfolioInsights, watched, canSell, analyzing, onWatch, onBuy, onSell, onReanalyze }: {
  analysis: Analysis;
  position: Position | null;
  portfolioInsights: PortfolioInsights;
  watched: boolean;
  canSell: boolean;
  analyzing: boolean;
  onWatch: () => void;
  onBuy: () => void;
  onSell: () => void;
  onReanalyze: () => Promise<void>;
}) {
  const [showRaw, setShowRaw] = useState(false);
  const { stock, quote, financials, explanation } = analysis;
  const isEtf = stock.instrumentType === "etf" && stock.fund;
  const companyLabels = isEtf
    ? ["基金产品", "跟踪指数", "基金管理人", "交易属性"]
    : ["是什么", "数据代码", "还要核验", "板块"];
  const quoteDate = quote.marketTime ? formatDateTimeShanghai(quote.marketTime) : "数据源未提供";

  return (
    <div className="analysis-page">
      <section className="stock-summary panel">
        <div className="stock-identity">
          <span className="stock-avatar large">{stock.name.slice(0, 1)}</span>
          <div><Badge tone="accent">{analysis.mode === "deepseek" ? "在线解读" : "自动解读"}</Badge><h2>{stock.name} <small>{stock.code}</small></h2><p>{stock.industry}{stock.sector ? ` · ${stock.sector}` : ""}</p></div>
        </div>
        <div className="price-block">
          <strong>{price(quote.price)}</strong>
          <span className={quote.changePercent >= 0 ? "up" : "down"}>{quote.changePercent >= 0 ? "+" : ""}{quote.changePercent.toFixed(2)}%</span>
          <small>行情时间 {quoteDate}</small>
        </div>
        <div className="summary-actions">
          <Button variant={watched ? "primary" : "ghost"} iconLeft={watched ? <CheckCircle2 size={15} /> : <Star size={15} />} onClick={onWatch}>
            {watched ? "已关注" : "加入关注"}
          </Button>
          <Button variant="primary" onClick={onBuy}>记录买入</Button>
        </div>
      </section>

      <section className="verdict">
        <span className="verdict-mark">{analysis.mode === "deepseek" ? "在线" : "本地"}</span>
        <div><span>一句话看懂</span><h3>{explanation.summary}</h3><p>只基于页面所列公开数据整理，不构成投资建议。</p></div>
      </section>

      <StrategyCard analysis={analysis} position={position} portfolioInsights={portfolioInsights} />
      <EvidencePanel analysis={analysis} position={position} />

      <MarketChart analysis={analysis} />

      {/* 分析区段锚点导航：长页一键跳转，避免滚动找重点 */}
      <nav className="analysis-tabs" aria-label="分析区段导航">
        {[
          ["01", "公司与行业", "analysis-card-company"],
          ["02", isEtf ? "基金资料" : "财务体检", "analysis-card-finance"],
          ["03", "价格位置", "analysis-card-position"],
          ["04", isEtf ? "指数与特征" : "题材信息", "analysis-card-theme"],
          ["05", "主要风险", "analysis-card-risk"],
          ["06", "价格参考", "analysis-card-plan"],
        ].map(([num, label, target]) => (
          <button
            key={target}
            type="button"
            className="analysis-tabs__btn"
            onClick={() => document.getElementById(target)?.scrollIntoView({ behavior: "smooth", block: "start" })}
          >
            <span>{num}</span>{label}
          </button>
        ))}
        <button
          type="button"
          className="analysis-tabs__btn analysis-tabs__btn--refresh"
          disabled={analyzing}
          onClick={() => void onReanalyze()}
          title="重新拉取最新行情并重新分析"
        >
          <RotateCw size={13} />
          {analyzing ? "分析中…" : "重新分析"}
        </button>
      </nav>

      <div className="analysis-grid">
        <section className="panel analysis-card" id="analysis-card-company">
          <SectionHeader number="01" title={isEtf ? "基金与指数" : "公司与行业"} subtitle={isEtf ? "基金官方资料" : "通俗解释"} bordered />
          <div className="plain-points">
            {explanation.company.map((item, index) => <p key={item}><b>{companyLabels[index] ?? "信息"}</b><span>{item}</span></p>)}
          </div>
          {!isEtf && stock.businessSummary && (
            <p className="company-brief">公司简介：{stock.businessSummary.length > 90 ? `${stock.businessSummary.slice(0, 90)}…` : stock.businessSummary}</p>
          )}
        </section>

        <section className="panel analysis-card" id="analysis-card-finance">
          <SectionHeader number="02" title={isEtf ? "基金资料" : "财务体检"} subtitle={isEtf ? "基金官方资料" : "麦蕊/东方财富/腾讯 多源"} bordered />
          {isEtf ? (
            <>
              <div className="fund-facts">
                <Stat label="基金管理人" value={stock.fund!.manager} />
                <Stat label="标的指数" value={stock.fund!.trackingIndex} />
                <Stat label="产品类型" value={stock.fund!.category} />
                <Stat label="上市市场" value={stock.fund!.exchange} />
              </div>
              <p className="source-warning">净值、折溢价、规模和跟踪误差尚未接入，页面不会用公司财务指标代替。</p>
              <Button variant="link" onClick={() => window.open(stock.fund!.sourceUrl, "_blank", "noreferrer")}>查看{stock.fund!.sourceName}官方资料 ↗</Button>
            </>
          ) : (
            <>
              <div className="metric-row">
                <Metric label="营收变化" value={financials.revenueGrowth} suffix="%" />
                <Metric label="利润变化" value={financials.profitGrowth} suffix="%" />
                <Metric label="负债率" value={financials.debtRatio} suffix="%" />
              </div>
              <div className="metric-row">
                <Metric label="总市值" value={financials.marketCap} marketCapValue />
                <Metric label="市盈率" value={financials.pe} suffix="" help="股价相对公司利润的倍数" />
                <Metric label="市净率" value={financials.pb} suffix="" help="股价相对净资产的倍数" />
              </div>
              <div className="metric-row">
                <Metric label="ROE" value={financials.roe} percentValue help="公司使用股东资金赚钱的能力" />
                <Metric label="毛利率" value={financials.grossMargin} percentValue />
                <Metric label="净利率" value={financials.profitMargin} percentValue />
              </div>
              {fundamentalsNote(financials)}
              {financials.pe == null && financials.profileError ? (
                <div className="profile-error">市盈率/市净率暂未取到：{financials.profileError}</div>
              ) : null}
              <Button variant="link" onClick={() => setShowRaw((value) => !value)} iconRight={showRaw ? <ChevronUp size={14} /> : <ChevronRight size={14} />}>{showRaw ? "收起原始数字" : "展开查看原始数字"}</Button>
              {showRaw && (
                <div className="raw-data">
                  {Object.entries(financials.series).map(([key, rows]) => (
                    <div key={key}><b>{key}</b>{rows.length ? rows.map((row) => <span key={row.date}>{row.date}: {row.value.toLocaleString("zh-CN")}</span>) : <span>暂无数据</span>}</div>
                  ))}
                  {!Object.keys(financials.series).length && <p>数据源暂未返回财务明细。</p>}
                </div>
              )}
            </>
          )}
        </section>

        <section className="panel analysis-card" id="analysis-card-position">
          <SectionHeader number="03" title="价格位置" subtitle="程序计算" bordered />
          <div className="metric-row">
            <Metric label="20日均线" value={quote.ma20} moneyValue help="近20个交易日收盘价的平均值" />
            <Metric label="近60日高点" value={quote.recentHigh} moneyValue />
            <Metric label="平均日波动" value={quote.volatility} suffix="%" help="近期每天涨跌幅度的平均水平" />
          </div>
          <p className="card-note">价格位于20日均线{quote.price >= quote.ma20 ? "上方" : "下方"}。价格位置只能辅助制定计划，不能单独决定买卖。</p>
          {analysis.volume && (
            <p className="card-note">
              量比 {analysis.volume.ratio === null ? "—" : analysis.volume.ratio.toFixed(2)}（{analysis.volume.ratio === null ? "量能数据缺失" : analysis.volume.ratio >= 1.5 ? "明显放量" : analysis.volume.ratio < 0.6 ? "明显缩量" : "量能常态"}）；
              量价关系：{analysis.volume.divergence ?? "未知"}。
            </p>
          )}
        </section>

        <section className="panel analysis-card" id="analysis-card-theme">
          <SectionHeader number="04" title={isEtf ? "指数与产品特征" : "题材信息"} subtitle={isEtf ? "基金资料已核验" : "候选信息 · 需核验"} bordered />
          <div className="theme-list">
            {explanation.themes.map((theme) => <div key={theme.name}><b>{theme.name}</b><Badge tone="amber">{theme.confidence}</Badge><p>{theme.reason}</p></div>)}
          </div>
          <p className="source-warning">{isEtf ? "指数成份不等于基金实时持仓，请结合基金定期报告和指数编制方案核验。" : "题材不等于业绩事实，请结合公司公告核验。"}</p>
        </section>

        <section className="panel analysis-card risks-card" id="analysis-card-risk">
          <SectionHeader number="05" title="主要风险" subtitle="按数据可见范围整理" bordered />
          <ol>{explanation.risks.map((risk, index) => <li key={risk}><span>{index + 1}</span><div><p>{risk}</p></div></li>)}</ol>
          {explanation.missingInformation.length > 0 && <p className="source-warning">仍缺少：{explanation.missingInformation.join("、")}</p>}
        </section>

        <section className="panel analysis-card price-plan-card" id="analysis-card-plan">
          <SectionHeader number="06" title="价格参考" subtitle="参考情景，不是买卖建议" bordered />
          <p className="risk-unit-note"><b>先看风险，再看目标：</b>1R就是当前价到风险观察线的距离，2R是这段距离的两倍。</p>
          <div className="price-scenarios">
            <div className="risk"><span>20日风险观察线</span><strong>{price(quote.support)}</strong><p>近期低点，跌破后重新检查原判断。</p></div>
            <div><span>第一目标参考</span><strong>{price(quote.target1)}</strong><p>以当前价到风险线的距离计算1R。</p></div>
            <div><span>第二目标参考</span><strong>{price(quote.target2)}</strong><p>以相同风险距离计算2R。</p></div>
          </div>
          <Hint>数据来源：<a href={analysis.source.url} target="_blank" rel="noreferrer">{analysis.source.name}</a> · 获取于 {formatDateTimeShanghai(analysis.source.fetchedAt)}</Hint>
        </section>
      </div>

      <div className="research-grid">
        <AnalysisHistory symbol={stock.code} currentPrice={quote.price} />
        <AnnouncementPanel stock={stock} />
      </div>

      <section className="decision-bar">
        <SectionHeader
          eyebrow="现在由你决定"
          title="这只股票下一步怎么处理？"
          actions={
            <>
              <Button variant={watched ? "primary" : "ghost"} iconLeft={watched ? <CheckCircle2 size={15} /> : <Star size={15} />} onClick={onWatch}>{watched ? "已关注" : "加入关注"}</Button>
              {canSell && <Button variant="ghost" onClick={onSell}>记录卖出</Button>}
              <Button variant="primary" onClick={onBuy}>我已买入</Button>
            </>
          }
        />
      </section>
    </div>
  );
}

function EvidencePanel({ analysis, position }: { analysis: Analysis; position: Position | null }) {
  const { quote, financials, source } = analysis;
  const evidence = [
    {
      label: "行情位置",
      value: `${price(quote.price)} · 20日均线${price(quote.ma20)}`,
      detail: `当前价位于20日均线${quote.price >= quote.ma20 ? "上方" : "下方"}，行情时间${quote.marketTime ? formatDateTimeShanghai(quote.marketTime) : "未提供"}。`,
      confidence: "高",
      source: source.name,
    },
    {
      label: "风险尺度",
      value: `观察线${price(quote.support)} · 波动${quote.volatility.toFixed(2)}%`,
      detail: "观察线来自近期低点，波动率来自近期日涨跌幅，均为程序计算。",
      confidence: "高",
      source: "公开行情 · 程序计算",
    },
    {
      label: "财务完整度",
      value: [financials.revenueGrowth, financials.profitGrowth, financials.pe, financials.roe].filter((value) => value !== null).length >= 3 ? "主要字段可用" : "部分字段缺失",
      detail: "营收/利润/负债率优先来自麦蕊；PE/PB 来自腾讯/东方财富；ROE/毛利/净利率来自麦蕊或东财主指标。缺失字段不影响技术面判断。",
      confidence: "中",
      source: "麦蕊/腾讯/东财 多源",
    },
  ];

  if (position) {
    const returnPercent = ((quote.price * 10_000 / position.averageCostTenThousandths) - 1) * 100;
    evidence.unshift({
      label: "我的持仓",
      value: `${position.quantity}股 · 成本${tenThousandthsPrice(position.averageCostTenThousandths)}`,
      detail: `按当前参考价估算为${returnPercent >= 0 ? "+" : ""}${returnPercent.toFixed(2)}%，不含未来费用和滑点。`,
      confidence: "高",
      source: "我的交易记录",
    });
  }

  return (
    <section className="panel evidence-panel">
      <SectionHeader layout="stack" eyebrow="结论从哪里来" title="关键证据与可信度" subtitle="数字、时间和缺口分开呈现，避免把推测当事实。" />
      <div className="evidence-grid">
        {evidence.map((item) => (
          <article key={item.label}>
            <div><span>{item.label}</span><b className={item.confidence === "高" ? "high" : "medium"}>{item.confidence}可信</b></div>
            <strong>{item.value}</strong>
            <p>{item.detail}</p>
            <small>来源：{item.source}</small>
          </article>
        ))}
      </div>
    </section>
  );
}

function buildAnalysisContext(
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

const STRATEGY_BLOCK_META: Record<string, { icon: React.ReactNode; cls: string; label: string }> = {
  结论: { icon: <Target size={15} />, cls: "strategy-block--verdict", label: "结论" },
  依据: { icon: <ClipboardCheck size={15} />, cls: "strategy-block--basis", label: "依据" },
  建议仓位: { icon: <Scale size={15} />, cls: "strategy-block--position", label: "建议仓位" },
  仓位与止损: { icon: <Scale size={15} />, cls: "strategy-block--position", label: "仓位与止损" },
  风险与缺口: { icon: <ShieldAlert size={15} />, cls: "strategy-block--risk", label: "风险与缺口" },
  下一步: { icon: <ArrowRightCircle size={15} />, cls: "strategy-block--next", label: "下一步" },
};

function StrategyBlocks({ content }: { content: string }) {
  const knownLabels = Object.keys(STRATEGY_BLOCK_META);
  const blocks: { label?: string; body: string }[] = [];

  for (const rawLine of content.split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      // 保留空行以维持段落/表格间距
      if (blocks.length > 0) {
        blocks[blocks.length - 1].body += "\n";
      }
      continue;
    }
    const matchedLabel = knownLabels.find(
      (label) => trimmed.startsWith(`${label}：`) || trimmed.startsWith(`${label}:`)
    );
    if (matchedLabel) {
      const sepIndex = trimmed.indexOf("：") !== -1 ? trimmed.indexOf("：") : trimmed.indexOf(":");
      const body = trimmed.slice(sepIndex + 1).trim();
      blocks.push({ label: matchedLabel, body });
    } else if (blocks.length === 0) {
      blocks.push({ body: rawLine });
    } else {
      blocks[blocks.length - 1].body += "\n" + rawLine;
    }
  }

  return (
    <div className="strategy-blocks">
      {blocks.map((block, index) => {
        const meta = block.label ? STRATEGY_BLOCK_META[block.label] : undefined;
        if (!meta) {
          return (
            <div key={index} className="strategy-block strategy-block--plain">
              <div className="strategy-block__body strategy-table-wrap">
                <MarkdownMessage content={block.body.trim()} />
              </div>
            </div>
          );
        }
        return (
          <div key={index} className={`strategy-block ${meta.cls}`}>
            <div className="strategy-block__head">
              <span className="strategy-block__icon">{meta.icon}</span>
              <span className="strategy-block__label">{meta.label}</span>
            </div>
            <div className="strategy-block__body strategy-table-wrap">
              <MarkdownMessage content={block.body.trim()} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function StrategyCard({ analysis, position, portfolioInsights }: {
  analysis: Analysis;
  position: Position | null;
  portfolioInsights: PortfolioInsights;
}) {
  const [strategy, setStrategy] = useState<{ content: string; mode: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function generate() {
    if (loading) return;
    setLoading(true);
    setError("");
    setStrategy(null);
    try {
      const context = buildAnalysisContext(analysis, position, portfolioInsights);
      const result = await jsonRequest<Analysis>("/api/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: analysis.stock.code, strategy: true, explain: false, saveHistory: false, context }),
      });
      setStrategy(result.strategy ?? null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "操盘策略生成失败，请稍后重试");
    } finally {
      setLoading(false);
    }
  }

  const modeLabel = strategy
    ? (strategy.mode === "deepseek" || strategy.mode === "openai") ? "在线生成" : "规则兜底"
    : undefined;

  return (
    <section className="panel strategy-card">
      <SectionHeader
        eyebrow="操盘手视角 · 结合我的账户"
        title="当前交易策略"
        subtitle={strategy ? "基于你的持仓、账户资金与交易纪律生成" : "结合持仓成本与交易纪律，给出可执行建议"}
        actions={modeLabel ? <Badge tone="accent">{modeLabel}</Badge> : undefined}
      />
      {!strategy && !error && (
        <div className="strategy-empty">
          <div className="strategy-empty__icon">
            <SlidersHorizontal size={28} />
          </div>
          <div className="strategy-empty__text">
            <p>结合你的账户资金、持仓成本与交易纪律，生成个性化买卖策略。</p>
            <span className="strategy-empty__hint">策略会给出是否买入/加仓/持有/减仓/清仓、建议仓位与止损位。</span>
          </div>
          <Button
            variant="primary"
            block
            disabled={loading}
            onClick={() => void generate()}
            iconLeft={<SlidersHorizontal size={16} />}
          >
            {loading ? "正在生成…" : "结合我的持仓生成策略"}
          </Button>
        </div>
      )}
      {loading && (
        <div className="strategy-loading">
          <span className="strategy-loading__dot" />
          <span>正在结合你的持仓、账户资金与交易纪律生成策略…</span>
        </div>
      )}
      {error && (
        <div className="strategy-error">
          <ShieldAlert size={18} />
          <span>{error}</span>
        </div>
      )}
      {!loading && !error && strategy && (
        <div className="strategy-content">
          <StrategyBlocks content={strategy.content} />
          <div className="strategy-footer">
            <p className="strategy-disclaimer">
              <ShieldCheck size={14} />
              策略仅基于当前页面数据、个人记录与交易纪律生成，不构成投资建议，最终由你确认执行。
            </p>
            <Button
              variant="ghost"
              size="sm"
              disabled={loading}
              onClick={() => void generate()}
              iconLeft={<RefreshCw size={14} />}
            >
              重新生成
            </Button>
          </div>
        </div>
      )}
      {!strategy && (
        <p className="strategy-disclaimer strategy-disclaimer--bottom">
          <ShieldCheck size={14} />
          策略仅基于当前页面数据、个人记录与交易纪律生成，不构成投资建议，最终由你确认执行。
        </p>
      )}
    </section>
  );
}

// 当浮窗不在分析页时，用占位股票 + 真实账户数据拼一个能通过
// isValidContext 校验的 context。后端与原有 /api/assistant 逻辑完全不改，
// AI 在 system 约束下会如实说明「未关联具体股票」，不会编造个股数字。
function buildPlaceholderContext(portfolioInsights: PortfolioInsights): AssistantContext {
  return {
    stock: { code: "", name: "未选择股票", industry: "未关联", instrumentType: "stock" },
    quote: { price: 0, changePercent: 0, ma20: 0, support: 0, resistance: 0, volatility: 0, marketTime: null },
    financials: { revenueGrowth: null, profitGrowth: null, debtRatio: null, pe: null, pb: null, roe: null },
    summary: "用户未在当前分析页选中具体股票，仅提供账户级上下文。",
    risks: [],
    missingInformation: ["未关联具体股票，无法提供个股行情与财务"],
    source: { name: "账户记录", fetchedAt: new Date().toISOString() },
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
                <ChevronRight size={14} className={`assistant-section__chevron${isCollapsed ? "" : " is-open"}`} />
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

function SmartAssistant(
  {
    analysis,
    position,
    portfolioInsights,
    floating = false,
    page = false,
    onClose,
    headerSlot,
    userId,
  }: {
    analysis: Analysis | null;
    position: Position | null;
    portfolioInsights: PortfolioInsights;
    floating?: boolean;
    // 移动端全屏对话页模式：占满视口、头部显示返回箭头而非收起叉
    page?: boolean;
    onClose?: () => void;
    headerSlot?: ReactNode;
    userId?: string | number;
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
  const stockCode = analysis?.stock.code ?? "";

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
    if (restored.length > 0) {
      setMessages(restored);
      setPrimed(true);
    } else {
      setMessages([{
        role: "assistant",
        kind: "primer",
        content: analysis
          ? `${analysis.stock.name}的当前数据已整理好。先记一笔持仓我能说得更准；想买、卖、加减仓随时问。`
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
    return analysis
      ? buildAnalysisContext(analysis, position, portfolioInsights)
      : buildPlaceholderContext(portfolioInsights);
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
    try {
      const result = await jsonRequest<{ answer: string; mode: "ai" | "fallback" }>("/api/assistant", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          question: clean,
          messages: messages.slice(-8),
          context: buildContext(),
        }),
      });
      setMessages((current) => [...current, {
        role: "assistant",
        content: result.answer,
        id: nextId(),
        mode: result.mode,
      }]);
    } catch (error) {
      setMessages((current) => [...current, {
        role: "assistant",
        content: error instanceof Error ? error.message : "这次追问暂时没有回答，请稍后重试。",
        id: nextId(),
        error: true,
        // 失败时把原问题挂到消息上，点"重试"就能重发
        pendingQuestion: clean,
      }]);
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
    <section className={`sa${floating ? " sa--floating" : ""}${page ? " sa--page" : ""}`}>
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
              {regen ? (
                <span className="sa-dots" aria-label="正在重新生成"><span /><span /><span /></span>
              ) : (
                <AssistantAnswer content={message.content} />
              )}
              {!regen && message.kind !== "primer" && (
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
          );
        })}
        {asking && (
          <div className="sa-msg sa-msg--assistant sa-msg--typing" aria-label="助手正在思考">
            <span className="sa-dots"><span /><span /><span /></span>
          </div>
        )}
        {showPrompts && prompts.length > 0 && (
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
        )}
      </div>
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

function FloatingAssistantLauncher(
  { open, onToggle, analysis, position, portfolioInsights, portfolio, watchlist, recentAnalyses, fetchAnalysis, userId, strategyScan }: {
    open: boolean;
    onToggle: () => void;
    analysis: Analysis | null;
    position: Position | null;
    portfolioInsights: PortfolioInsights;
    portfolio: ReturnType<typeof calculatePortfolio>;
    watchlist: WatchItem[];
    recentAnalyses: Analysis[];
    fetchAnalysis: (query: string, showResult?: boolean) => Promise<Analysis | null>;
    userId?: string | number;
    strategyScan?: StrategyScanResponse | null;
  },
) {
  // 浮窗内关联的股票分析（与主页面 analysis 解耦，不影响主页视图）
  const [linked, setLinked] = useState<Analysis | null>(null);
  const [linking, setLinking] = useState(false);
  const [linkError, setLinkError] = useState("");
  const [linkerOpen, setLinkerOpen] = useState(false);
  const linkerRef = useRef<HTMLDivElement | null>(null);

  // 关闭浮窗时自动收起选择器，避免下次打开时残留
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!open) setLinkerOpen(false);
  }, [open]);

  // 视口判断：移动端用全屏对话页，PC 用浮窗
  const isMobile = useIsMobile();

  // 移动端打开全屏页时锁背景滚动，避免 iOS 橡皮筋穿透到底层页面
  useEffect(() => {
    if (!open || !isMobile || typeof document === "undefined") return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [open, isMobile]);

  // 点击选择器外部关闭
  useEffect(() => {
    if (!linkerOpen) return;
    const onMouseDown = (event: MouseEvent) => {
      if (!linkerRef.current?.contains(event.target as Node)) setLinkerOpen(false);
    };
    window.addEventListener("mousedown", onMouseDown);
    return () => window.removeEventListener("mousedown", onMouseDown);
  }, [linkerOpen]);

  // 新形态：侧栏位置固定右侧，FAB / 胶囊不再需要拖动与定位同步

  const activeAnalysis = linked ?? analysis;
  const activePosition = linked ? (portfolio.positions.find((p) => p.symbol === linked.stock.code) ?? null) : position;

  // 状态胶囊数据：今日信号数 + 市场风险度（复用 Dashboard 已拉取的 strategyScan）
  const scanData = strategyScan?.scan;
  const signalCount = scanData?.selected?.length ?? 0;
  const marketState = scanData?.marketState?.state;
  const marketLabel =
    marketState === "bull" ? "偏多"
    : marketState === "bear" ? "偏空"
    : marketState === "neutral" ? "中性"
    : marketState === "unknown" ? "未知"
    : "—";
  const marketTone: "up" | "down" | "flat" =
    marketState === "bull" ? "up" : marketState === "bear" ? "down" : "flat";
  const hasScan = !!scanData;

  async function linkStock(value: string) {
    const code = value.trim();
    if (!code) return;
    setLinking(true);
    setLinkError("");
    try {
      const result = await fetchAnalysis(code, false);
      if (result) {
        setLinked(result);
        setLinkerOpen(false);
      } else {
        setLinkError("未找到该股票的分析");
      }
    } catch {
      setLinkError("关联失败，请检查代码后重试");
    } finally {
      setLinking(false);
    }
  }

  // 旧形态遗留占位：当前侧栏由 CSS 固定右侧定位，不再需要 inline style


  // 股票关联下拉：浮窗与移动端全屏页共用，抽成变量避免两端重复
  const linkerSlot = (
    <div className="sa-linker" ref={linkerRef}>
      <button
        type="button"
        className={`sa-linker__btn${linkerOpen ? " is-open" : ""}${linked ? " is-active" : ""}`}
        onClick={() => setLinkerOpen((value) => !value)}
        aria-expanded={linkerOpen}
        aria-haspopup="dialog"
        title={linked ? `已关联：${linked.stock.name}${linked.stock.code ? `（${linked.stock.code}）` : ""}` : "关联其它股票来分析问答"}
      >
        <ChevronDown size={12} className={`sa-linker__chev${linkerOpen ? " is-open" : ""}`} />
        <span className="sa-linker__label">{linked ? "已关联" : "切换股票"}</span>
      </button>
      {linkerOpen && (
        <div className="sa-linker__pop" role="dialog" aria-label="股票关联">
          {watchlist.length > 0 && (
            <div className="sa-linker__group">
              <small>自选股</small>
              <div className="sa-linker__chips">
                {watchlist.map((item) => {
                  const isActive = activeAnalysis?.stock.code === item.symbol;
                  const labelText = item.name && item.name !== item.symbol ? item.name : item.symbol;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={`sa-linker__chip${isActive ? " is-active" : ""}`}
                      onClick={() => void linkStock(item.symbol)}
                      disabled={linking}
                      title={item.symbol}
                    >
                      <span className="sa-linker__chip-name">{labelText}</span>
                      {labelText !== item.symbol && <span className="sa-linker__chip-code">{item.symbol}</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {recentAnalyses.length > 0 && (
            <div className="sa-linker__group">
              <small>最近分析</small>
              <div className="sa-linker__chips">
                {recentAnalyses
                  .filter((item) => !watchlist.some((w) => w.symbol === item.stock.code))
                  .map((item) => {
                    const isActive = activeAnalysis?.stock.code === item.stock.code;
                    const labelText = item.stock.name && item.stock.name !== item.stock.code ? item.stock.name : item.stock.code;
                    return (
                      <button
                        key={item.stock.code}
                        type="button"
                        className={`sa-linker__chip${isActive ? " is-active" : ""}`}
                        onClick={() => void linkStock(item.stock.code)}
                        disabled={linking}
                        title={item.stock.code}
                      >
                        <span className="sa-linker__chip-name">{labelText}</span>
                        {labelText !== item.stock.code && <span className="sa-linker__chip-code">{item.stock.code}</span>}
                      </button>
                    );
                  })}
              </div>
            </div>
          )}
          <div className="sa-linker__group">
            <small>输入代码</small>
            <input
              placeholder={linking ? "分析中…" : "例如 600519"}
              disabled={linking}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  const target = event.currentTarget;
                  const v = target.value.trim();
                  if (v) {
                    void linkStock(v).then(() => { target.value = ""; });
                  }
                }
              }}
              aria-label="输入股票代码关联"
            />
          </div>
          {linked && (
            <button
              type="button"
              className="sa-linker__clear"
              onClick={() => { setLinked(null); setLinkerOpen(false); }}
            >
              解除关联，回到当前页
            </button>
          )}
          {linkError && <small className="sa-linker__error">{linkError}</small>}
        </div>
      )}
    </div>
  );

  return (
    <>
      <div
        className={`scan-status-pill${hasScan ? "" : " is-empty"}${marketTone !== "flat" ? ` tone-${marketTone}` : ""}`}
        role="button"
        tabIndex={0}
        aria-label={hasScan ? `今日 ${signalCount} 只信号，市场${marketLabel}` : "暂无选股扫描结果"}
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onToggle();
          }
        }}
      >
        <span className="scan-status-pill__dot" aria-hidden />
        <span className="scan-status-pill__text">
          {hasScan ? `${signalCount} 只信号` : "暂无扫描"}
          {hasScan && <em>· {marketLabel}</em>}
        </span>
      </div>
      {isMobile ? (
        // 移动端：全屏对话页（始终挂载 SmartAssistant；锁滚动仅打开时）
        <div
          className={`assistant-page${open ? " is-open" : ""}`}
          role="dialog"
          aria-label="复盘助手"
          aria-hidden={!open}
        >
          <SmartAssistant
            page
            analysis={activeAnalysis}
            position={activePosition}
            portfolioInsights={portfolioInsights}
            userId={userId}
            onClose={onToggle}
            headerSlot={linkerSlot}
          />
        </div>
      ) : (
        // 桌面端：右滑出侧栏（始终挂载 SmartAssistant；transform 控制滑入；非模态、不挡主页）
        <div
          className={`assistant-fab-panel${open ? " is-open" : ""}`}
          role="dialog"
          aria-label="复盘助手"
          aria-hidden={!open}
        >
          <SmartAssistant
            floating
            analysis={activeAnalysis}
            position={activePosition}
            portfolioInsights={portfolioInsights}
            userId={userId}
            onClose={onToggle}
            headerSlot={linkerSlot}
          />
        </div>
      )}
      <button
        type="button"
        className={`assistant-fab${open ? " is-open" : ""}`}
        onClick={onToggle}
        aria-label={open ? "收起复盘助手" : "打开复盘助手"}
        title={open ? "收起助手" : "复盘助手"}
      >
        <MessageSquare size={20} />
      </button>
    </>
  );
}

function MarketChart({ analysis }: { analysis: Analysis }) {
  const [period, setPeriod] = useState<MarketPeriod>("day");
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [pointerPrice, setPointerPrice] = useState<number | null>(null);
  const [chartActive, setChartActive] = useState(false);
  const rows = useMemo(
    () => aggregateMarketHistory(analysis.history, period).slice(-60),
    [analysis.history, period],
  );
  const width = 900;
  const priceHeight = 190;
  const volumeTop = 215;
  const chartVolumeHeight = 55;
  const minPrice = Math.min(...rows.map((row) => row.low));
  const maxPrice = Math.max(...rows.map((row) => row.high));
  const priceRange = Math.max(maxPrice - minPrice, 0.01);
  const maxVolume = Math.max(...rows.map((row) => row.volume), 1);
  const volumeHighlight = rows.length
    ? rows.reduce((largest, row) => row.volume > largest.volume ? row : largest)
    : null;
  const extremes = useMemo(() => {
    if (!rows.length) return { maxIndex: -1, minIndex: -1, max: null as MarketBar | null, min: null as MarketBar | null };
    let maxIndex = 0;
    let minIndex = 0;
    for (let index = 1; index < rows.length; index += 1) {
      if (rows[index].high > rows[maxIndex].high) maxIndex = index;
      if (rows[index].low < rows[minIndex].low) minIndex = index;
    }
    return { maxIndex, minIndex, max: rows[maxIndex], min: rows[minIndex] };
  }, [rows]);
  const step = width / Math.max(rows.length, 1);
  const candleWidth = Math.max(2, step * 0.55);
  const x = (index: number) => index * step + step / 2;
  const y = (value: number) => 12 + ((maxPrice - value) / priceRange) * (priceHeight - 24);
  const linePoints = (key: "ma5" | "ma20" | "ma60") => rows
    .map((row, index) => row[key] === null ? null : `${x(index).toFixed(1)},${y(row[key] as number).toFixed(1)}`)
    .filter(Boolean)
    .join(" ");
  const selectedRow = selectedIndex === null ? null : rows[selectedIndex];
  const previousClose = selectedIndex !== null && selectedIndex > 0 ? rows[selectedIndex - 1].close : null;
  const selectedChange = selectedRow && previousClose
    ? ((selectedRow.close / previousClose) - 1) * 100
    : null;
  const tooltipX = selectedIndex === null
    ? 0
    : x(selectedIndex) > width / 2 ? x(selectedIndex) - 230 : x(selectedIndex) + 12;
  const crosshairPrice = pointerPrice ?? selectedRow?.close ?? null;
  const crosshairY = crosshairPrice === null ? null : y(crosshairPrice);
  const crosshairLabel = crosshairPrice === null ? "" : price(crosshairPrice);
  const priceLabelWidth = Math.max(62, crosshairLabel.length * 7 + 14);
  const periodLabel = period === "day" ? "日K" : period === "week" ? "周K" : "月K";
  const latestRow = rows.at(-1);
  const showExtremes = chartActive || selectedIndex !== null;

  function selectAtPointer(event: ReactPointerEvent<SVGSVGElement>) {
    const matrix = event.currentTarget.getScreenCTM();
    if (!matrix) return;
    const point = event.currentTarget.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const pointer = point.matrixTransform(matrix.inverse());
    if (pointer.x < 0 || pointer.x > width) {
      setSelectedIndex(null);
      setPointerPrice(null);
      return;
    }
    const index = Math.min(rows.length - 1, Math.floor(Math.min(pointer.x, width - Number.EPSILON) / step));
    setSelectedIndex(index);
    const priceTop = 12;
    const priceBottom = priceHeight - 12;
    if (pointer.y < priceTop || pointer.y > priceBottom) {
      setPointerPrice(null);
      return;
    }
    const value = maxPrice - ((pointer.y - priceTop) / (priceBottom - priceTop)) * priceRange;
    setPointerPrice(Math.max(minPrice, Math.min(maxPrice, value)));
  }

  function navigateChart(event: ReactKeyboardEvent<SVGSVGElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End", "Escape"].includes(event.key)) return;
    event.preventDefault();
    setPointerPrice(null);
    if (event.key === "Escape") return setSelectedIndex(null);
    if (event.key === "Home") return setSelectedIndex(0);
    if (event.key === "End") return setSelectedIndex(rows.length - 1);
    const current = selectedIndex ?? rows.length - 1;
    setSelectedIndex(Math.max(0, Math.min(rows.length - 1, current + (event.key === "ArrowLeft" ? -1 : 1))));
  }

  function changePeriod(nextPeriod: MarketPeriod) {
    setPeriod(nextPeriod);
    setSelectedIndex(null);
    setPointerPrice(null);
  }

  return (
    <section className="panel market-chart-card">
      <SectionHeader
        eyebrow={`${periodLabel} · 近${rows.length}根`}
        title="K线与成交量"
        actions={
          <div className="chart-heading-actions">
            <div className="chart-period-tabs" aria-label="K线周期">
              {(["day", "week", "month"] as MarketPeriod[]).map((item) => (
                <button
                  type="button"
                  key={item}
                  className={period === item ? "active" : ""}
                  aria-pressed={period === item}
                  onClick={() => changePeriod(item)}
                >
                  {item === "day" ? "日K" : item === "week" ? "周K" : "月K"}
                </button>
              ))}
            </div>
            <div className="chart-legend"><span className="ma5">MA5</span><span className="ma20">MA20</span><span className="ma60">MA60</span></div>
          </div>
        }
      />
      <p className="chart-interaction-hint">移动鼠标查看日期与水平线对应价格，点按或使用左右方向键切换K线。</p>
      <svg
        className="market-chart"
        viewBox={`0 0 ${width} 280`}
        role="img"
        tabIndex={0}
        aria-label={`${analysis.stock.name}${periodLabel}、成交量和均线。移动鼠标、点按或使用左右方向键查看每根K线数据。`}
        onPointerMove={(event) => {
          setChartActive(true);
          selectAtPointer(event);
        }}
        onPointerDown={selectAtPointer}
        onPointerEnter={() => setChartActive(true)}
        onPointerLeave={(event) => {
          if (event.pointerType === "touch") return;
          setChartActive(false);
          setSelectedIndex(null);
          setPointerPrice(null);
        }}
        onFocus={() => setChartActive(true)}
        onBlur={() => setChartActive(false)}
        onKeyDown={navigateChart}
      >
        <line x1="0" y1={priceHeight} x2={width} y2={priceHeight} className="chart-axis" />
        {rows.map((row, index) => {
          const rising = row.close >= row.open;
          const candleY = Math.min(y(row.open), y(row.close));
          const candleHeight = Math.max(1.5, Math.abs(y(row.open) - y(row.close)));
          const barHeight = row.volume / maxVolume * chartVolumeHeight;
          return (
            <g key={row.date}>
              <line x1={x(index)} x2={x(index)} y1={y(row.high)} y2={y(row.low)} className={rising ? "candle-up" : "candle-down"} />
              <rect x={x(index) - candleWidth / 2} y={candleY} width={candleWidth} height={candleHeight} className={rising ? "candle-up" : "candle-down"} />
              <rect x={x(index) - candleWidth / 2} y={volumeTop + chartVolumeHeight - barHeight} width={candleWidth} height={barHeight} className={rising ? "volume-up" : "volume-down"} />
            </g>
          );
        })}
        <polyline points={linePoints("ma5")} className="ma-line ma5-line" />
        <polyline points={linePoints("ma20")} className="ma-line ma20-line" />
        <polyline points={linePoints("ma60")} className="ma-line ma60-line" />
        {showExtremes && extremes.max && extremes.maxIndex >= 0 && (
          <g className="chart-extreme chart-extreme-max" pointerEvents="none">
            <line x1="0" x2={width} y1={y(extremes.max.high)} y2={y(extremes.max.high)} className="chart-extreme-line" />
            <circle cx={x(extremes.maxIndex)} cy={y(extremes.max.high)} r="3.5" className="chart-extreme-dot" />
            <g transform={`translate(0, ${Math.max(2, Math.min(priceHeight - 22, y(extremes.max.high) - 10))})`} className="chart-extreme-tag">
              <rect width="72" height="20" rx="5" />
              <text x="7" y="14">高 {price(extremes.max.high)}</text>
            </g>
          </g>
        )}
        {showExtremes && extremes.min && extremes.minIndex >= 0 && (
          <g className="chart-extreme chart-extreme-min" pointerEvents="none">
            <line x1="0" x2={width} y1={y(extremes.min.low)} y2={y(extremes.min.low)} className="chart-extreme-line" />
            <circle cx={x(extremes.minIndex)} cy={y(extremes.min.low)} r="3.5" className="chart-extreme-dot" />
            <g transform={`translate(0, ${Math.max(2, Math.min(priceHeight - 22, y(extremes.min.low) - 10))})`} className="chart-extreme-tag">
              <rect width="72" height="20" rx="5" />
              <text x="7" y="14">低 {price(extremes.min.low)}</text>
            </g>
          </g>
        )}
        {selectedRow && selectedIndex !== null && (
          <g className="chart-selection" pointerEvents="none">
            <line x1={x(selectedIndex)} x2={x(selectedIndex)} y1="4" y2="270" className="chart-crosshair" />
            {crosshairY !== null && (
              <>
                <line x1="0" x2={width} y1={crosshairY} y2={crosshairY} className="chart-crosshair chart-crosshair-horizontal" />
                <g
                  transform={`translate(${width - priceLabelWidth}, ${Math.max(2, Math.min(priceHeight - 22, crosshairY - 10))})`}
                  className="chart-price-label"
                >
                  <rect width={priceLabelWidth} height="20" rx="5" />
                  <text x={priceLabelWidth - 7} y="14" textAnchor="end">{crosshairLabel}</text>
                </g>
              </>
            )}
            <circle cx={x(selectedIndex)} cy={y(selectedRow.close)} r="4" className="chart-selection-dot" />
            <g transform={`translate(${tooltipX}, 8)`} className="chart-tooltip">
              <rect width="218" height="126" rx="9" />
              <text x="12" y="20" className="chart-tooltip-date">{selectedRow.date}</text>
              <text x="206" y="20" textAnchor="end" className={selectedChange !== null && selectedChange < 0 ? "chart-tooltip-down" : "chart-tooltip-up"}>
                {selectedChange === null ? "—" : `${selectedChange >= 0 ? "+" : ""}${selectedChange.toFixed(2)}%`}
              </text>
              <text x="12" y="43">开 <tspan>{price(selectedRow.open)}</tspan></text>
              <text x="112" y="43">高 <tspan>{price(selectedRow.high)}</tspan></text>
              <text x="12" y="63">低 <tspan>{price(selectedRow.low)}</tspan></text>
              <text x="112" y="63">收 <tspan>{price(selectedRow.close)}</tspan></text>
              <text x="12" y="84">成交量 <tspan>{compactVolume(selectedRow.volume)}</tspan></text>
              <text x="12" y="106" className="chart-tooltip-ma5">MA5 <tspan>{selectedRow.ma5 === null ? "—" : price(selectedRow.ma5)}</tspan></text>
              <text x="82" y="106" className="chart-tooltip-ma20">MA20 <tspan>{selectedRow.ma20 === null ? "—" : price(selectedRow.ma20)}</tspan></text>
              <text x="158" y="106" className="chart-tooltip-ma60">MA60 <tspan>{selectedRow.ma60 === null ? "—" : price(selectedRow.ma60)}</tspan></text>
            </g>
          </g>
        )}
      </svg>
      <div className="chart-summary">
        {selectedRow ? (
          <>
            <span>选中日期 <b>{selectedRow.date}</b></span>
            <span>开盘 / 收盘 <b>{price(selectedRow.open)} / {price(selectedRow.close)}</b></span>
            <span>最高 / 最低 <b>{price(selectedRow.high)} / {price(selectedRow.low)}</b></span>
            <span>成交量 <b>{compactVolume(selectedRow.volume)}</b></span>
          </>
        ) : (
          <>
            <span>MA5 <b>{latestRow?.ma5 === null || latestRow?.ma5 === undefined ? "暂无" : price(latestRow.ma5)}</b></span>
            <span>MA20 <b>{latestRow?.ma20 === null || latestRow?.ma20 === undefined ? "暂无" : price(latestRow.ma20)}</b></span>
            <span>MA60 <b>{latestRow?.ma60 === null || latestRow?.ma60 === undefined ? "暂无" : price(latestRow.ma60)}</b></span>
            <span>最大成交量日 <b>{volumeHighlight?.date ?? "暂无"}</b></span>
            <span>区间最高 <b>{extremes.max ? `${price(extremes.max.high)} · ${extremes.max.date}` : "暂无"}</b></span>
            <span>区间最低 <b>{extremes.min ? `${price(extremes.min.low)} · ${extremes.min.date}` : "暂无"}</b></span>
          </>
        )}
      </div>
    </section>
  );
}

type HistoryReport = {
  id: number;
  priceCents: number;
  priceMillis: number | null;
  marketTime: string | null;
  source: string;
  mode: string;
  summary: string;
  createdAt: string;
};

function AnalysisHistory({ symbol, currentPrice }: { symbol: string; currentPrice: number }) {
  const [reports, setReports] = useState<HistoryReport[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(async () => {
      try {
        const result = await jsonRequest<{ reports: HistoryReport[] }>(`/api/analysis-history?symbol=${symbol}`);
        setReports(result.reports);
      } catch (historyError) {
        setError(historyError instanceof Error ? historyError.message : "分析历史读取失败");
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [symbol]);

  return (
    <section className="panel research-card">
      <SectionHeader number="07" title="历史分析" subtitle="保存当时的价格与判断" bordered />
      {reports.length ? reports.slice(0, 5).map((report) => {
        const change = report.priceMillis === null
          ? null
          : ((currentPrice * 1000 / report.priceMillis) - 1) * 100;
        return (
          <article className="history-item" key={report.id}>
            <div><b>{formatDateTimeShanghai(report.createdAt)}</b><span>{report.mode === "deepseek" ? "在线" : "自动解释"} · {report.priceMillis === null
              ? <>旧记录约{money(report.priceCents)} · <i className="legacy-precision">精度不足，不计算涨跌</i></>
              : <>当时{millisPrice(report.priceMillis)} · 至今<span className={(change ?? 0) >= 0 ? "up" : "down"}>{(change ?? 0) >= 0 ? "+" : ""}{(change ?? 0).toFixed(2)}%</span></>
            }</span></div>
            <p>{report.summary}</p>
          </article>
        );
      }) : <div className="empty-inline">{error || "首次分析已保存，重新进入后可在这里对比。"}</div>}
    </section>
  );
}

type AnnouncementNote = {
  id: number;
  title: string;
  sourceUrl: string;
  totalPages: number;
  summary: string;
  risks: string[];
  mode: string;
  createdAt: string;
};

function AnnouncementPanel({ stock }: { stock: Analysis["stock"] }) {
  const [notes, setNotes] = useState<AnnouncementNote[]>([]);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState("");

  const loadNotes = useCallback(async () => {
    try {
      const result = await jsonRequest<{ notes: AnnouncementNote[] }>(`/api/announcements?symbol=${stock.code}`);
      setNotes(result.notes);
    } catch (noteError) {
      setMessage(noteError instanceof Error ? noteError.message : "公告摘要读取失败");
    }
  }, [stock.code]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadNotes(), 0);
    return () => window.clearTimeout(timer);
  }, [loadNotes]);

  async function summarize(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setUploading(true);
    setMessage("");
    const form = new FormData(event.currentTarget);
    form.set("symbol", stock.code);
    form.set("name", stock.name);
    try {
      const response = await fetch("/api/announcements", { method: "POST", body: form });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "公告摘要失败");
      event.currentTarget.reset();
      await loadNotes();
      setMessage("公告摘要已保存");
    } catch (summaryError) {
      setMessage(summaryError instanceof Error ? summaryError.message : "公告摘要失败");
    } finally {
      setUploading(false);
    }
  }

  async function removeNote(id: number) {
    try {
      await jsonRequest(`/api/announcements?symbol=${stock.code}&id=${id}`, { method: "DELETE" });
      await loadNotes();
      setMessage("公告摘要已删除");
    } catch (removeError) {
      setMessage(removeError instanceof Error ? removeError.message : "公告摘要删除失败");
    }
  }

  return (
    <section className="panel research-card announcement-card">
      <SectionHeader number="08" title="官方公告" subtitle="官方原文优先 · 系统只做摘要" bordered />
      <div className="official-links">
        <a href={`https://www.cninfo.com.cn/new/fulltextSearch?keyWord=${stock.code}`} target="_blank" rel="noreferrer">巨潮资讯</a>
        <a href="https://www.sse.com.cn/disclosure/listedinfo/announcement/" target="_blank" rel="noreferrer">上交所公告</a>
        <a href="https://www.szse.cn/disclosure/listed/notice/index.html" target="_blank" rel="noreferrer">深交所公告</a>
      </div>
      <form className="announcement-form" onSubmit={summarize}>
        <Field label="公告标题">
          <Input name="title" required maxLength={120} placeholder="例如：2026年半年度报告" />
        </Field>
        <Field label="官方PDF链接（可选）">
          <Input name="sourceUrl" type="url" placeholder="仅支持巨潮、上交所、深交所HTTPS链接" />
        </Field>
        <Field label="或上传PDF（8MB以内）">
          <Input name="file" type="file" accept="application/pdf" />
        </Field>
        <Button variant="primary" disabled={uploading}>{uploading ? "正在提取并总结…" : "生成公告摘要"}</Button>
      </form>
      {message && <p className="form-message" role="status">{message}</p>}
      <div className="announcement-list">
        {notes.slice(0, 3).map((note) => (
          <article key={note.id}>
            <div><b>{note.title}</b><span>{note.mode === "deepseek" ? "在线摘要" : "自动摘要"} · {note.totalPages}页</span></div>
            <p>{note.summary}</p>
            {note.risks.length > 0 && <small>需要核验：{note.risks.join("；")}</small>}
            <div className="announcement-actions">
              {note.sourceUrl && <a className="link-arrow" href={note.sourceUrl} target="_blank" rel="noreferrer">查看原文<ChevronRight size={14} /></a>}
              <button type="button" onClick={() => void removeNote(note.id)}>删除摘要</button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function formatMarketCap(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "—";
  if (value >= 1e12) return `${(value / 1e12).toFixed(2)}万亿`;
  if (value >= 1e8) return `${(value / 1e8).toFixed(2)}亿`;
  if (value >= 1e4) return `${(value / 1e4).toFixed(2)}万`;
  return value.toLocaleString("zh-CN");
}

/**
 * 财务体检的数据说明：根据麦蕊 / 多源兜底的实际覆盖情况，给出人性化提示。
 * 麦蕊优先提供营收/利润/负债率；PE/PB 由腾讯/东财；ROE/毛利/净利率由麦蕊或东财主指标。
 * 只有当核心字段大面积缺失时才提示"数据暂缺"，并区分缺失范围，避免一刀切的过时文案。
 */
function fundamentalsNote(financials: {
  revenueGrowth: number | null;
  profitGrowth: number | null;
  debtRatio: number | null;
  pe: number | null;
  pb: number | null;
  roe: number | null;
  grossMargin: number | null;
  profitMargin: number | null;
}) {
  const growthFields = [financials.revenueGrowth, financials.profitGrowth, financials.debtRatio];
  const growthOk = growthFields.filter((v) => v !== null).length;
  const hasPePb = financials.pe !== null || financials.pb !== null;
  const hasRoeMargin = financials.roe !== null || financials.grossMargin !== null || financials.profitMargin !== null;

  // 全部字段都有：一句正向说明即可
  if (growthOk === 3 && hasPePb && hasRoeMargin) {
    return <p className="source-warning">以上为最新一期的公开财务数据：营收/利润/负债率优先来自麦蕊，PE/PB 来自腾讯/东方财富。数据为快照，报告口径以公司公告为准。</p>;
  }
  // 多数可用：个别缺失提示缺什么，但不贬低整体
  if (growthOk >= 1 || hasPePb || hasRoeMargin) {
    const missing: string[] = [];
    if (growthOk === 0) missing.push("营收/利润/负债率（麦蕊未能返回或该指标暂缺）");
    if (!hasPePb) missing.push("市盈率/市净率");
    if (!hasRoeMargin) missing.push("ROE/毛利率/净利率");
    return (
      <p className="source-warning">
        部分财务数据暂缺：{missing.join("、")}。可用指标仍可作为初筛参考；
        {growthOk > 0 && "营收/利润/负债率优先来自麦蕊，"}
        {hasPePb && "PE/PB 来自腾讯/东方财富，"}
        判断以技术面（均线/量能/支撑阻力）与仓位纪律为主。
      </p>
    );
  }
  // 几乎全缺：明确说明，引导用技术面，不制造焦虑
  return (
    <p className="source-warning">
      本次未取到该股财务指标，不凭印象补数。技术面（走势/量能/支撑阻力）仍稳定可用，可据此并结合仓位纪律做判断；若有明确的基本面信息，也可在对话里补充核对。
    </p>
  );
}

function Metric({ label, value, suffix = "", moneyValue = false, marketCapValue = false, percentValue = false, help }: {
  label: string;
  value: number | null;
  suffix?: string;
  moneyValue?: boolean;
  marketCapValue?: boolean;
  percentValue?: boolean;
  help?: string;
}) {
  let content = "暂无";
  if (value !== null) {
    if (marketCapValue) content = formatMarketCap(value);
    else if (percentValue) content = `${(value * 100).toFixed(1)}%`;
    else if (moneyValue) content = price(value);
    else content = `${value >= 0 && suffix === "%" ? "+" : ""}${value.toFixed(1)}${suffix}`;
  }
  return <div><span>{label}</span><strong className={value !== null && value < 0 ? "down" : "neutral"}>{content}</strong><small>{help ?? (value === null ? "本次未取到" : "最新公开数据")}</small></div>;
}

/**
 * 关注状态对应的视觉令牌：避免"已买入"误用红色（红在 A 股代表涨/买入）
 * 用图标 + 文字双通道呈现，对色觉障碍更友好。
 */
const watchStatusMap: Record<"研究中" | "等待条件" | "已买入" | "暂停", {
  tone: "neutral" | "accent" | "red" | "green" | "amber" | "inverse";
  icon: LucideIcon;
  label: string;
}> = {
  "研究中": { tone: "amber", icon: Search, label: "研究中" },
  "等待条件": { tone: "accent", icon: ClipboardList, label: "等待条件" },
  "已买入": { tone: "inverse", icon: CheckCircle2, label: "已买入" },
  "暂停": { tone: "neutral", icon: NotebookPen, label: "暂停" },
};

function Watchlist({ items, quotes, onSearch, onAnalyze, onSaved }: {
  items: WatchItem[];
  quotes: Record<string, QuoteEntry>;
  onSearch: () => void;
  onAnalyze: (symbol: string) => void;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);

  async function saveCondition(event: React.FormEvent<HTMLFormElement>, symbol: string) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const metric = ((data.get("conditionMetric") as string | null) ?? "").trim();
    const direction = ((data.get("conditionDirection") as string | null) ?? "").trim();
    const valueRaw = data.get("conditionValue");
    const valueNumber = valueRaw !== null && `${valueRaw}`.trim() !== "" ? Number(valueRaw) : null;
    if (metric && (valueNumber === null || !Number.isFinite(valueNumber) || valueNumber <= 0)) {
      setMessage("触发阈值需要是一个大于 0 的数字");
      return;
    }
    try {
      await jsonRequest("/api/watchlist", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          symbol,
          conditionText: data.get("conditionText"),
          status: data.get("status"),
          conditionMetric: metric || undefined,
          conditionDirection: metric ? direction : undefined,
          conditionValue: metric ? valueNumber : undefined,
        }),
      });
      setEditing(null);
      setMessage("观察条件已更新");
      onSaved();
    } catch (saveError) {
      setMessage(saveError instanceof Error ? saveError.message : "观察条件保存失败");
    }
  }

  async function confirmRemove(symbol: string) {
    setConfirming(null);
    try {
      await jsonRequest(`/api/watchlist?symbol=${symbol}`, { method: "DELETE" });
      onSaved();
      setMessage("已移出关注");
    } catch (removeError) {
      setMessage(removeError instanceof Error ? removeError.message : "移出关注失败");
    }
  }

  const watchConditionMet = (item: WatchItem, quotePrice: number | undefined, todayChange: number | null): boolean => {
    const metric = item.conditionMetric;
    const direction = item.conditionDirection;
    const value = item.conditionValue;
    if (!metric || !direction || value === null) return false;
    if (metric === "price") {
      if (!quotePrice) return false;
      return direction === "above" ? quotePrice >= value : quotePrice <= value;
    }
    if (metric === "change") {
      if (todayChange === null) return false;
      return direction === "above" ? todayChange >= value : todayChange <= value;
    }
    return false;
  };

  const watchConditionDesc = (item: WatchItem): string => {
    if (!item.conditionMetric || !item.conditionDirection || item.conditionValue === null) return "";
    const metricLabel = item.conditionMetric === "price" ? "现价" : "今日涨跌幅";
    const dirLabel = item.conditionDirection === "above" ? "≥" : "≤";
    const unit = item.conditionMetric === "price" ? "" : "%";
    return `${metricLabel} ${dirLabel} ${item.conditionValue}${unit}`;
  };

  // 实时行情刷新节奏感：基础时间戳 + 相对文案
  const today = new Date();

  return (
    <div className="page-content inner-page">
      <SectionHeader
        as="h2"
        size="xl"
        eyebrow="先研究，再决定"
        title="我的关注"
        subtitle="每只股票都保留一个明确的等待条件。"
        actions={<Button variant="primary" iconLeft={<Plus size={16} />} onClick={onSearch}>查找股票</Button>}
      />
      {items.length ? (
        <div className="watch-cards">
          {items.map((item) => {
            const quote = quotes[item.symbol]?.quote;
            const history = quotes[item.symbol]?.history ?? [];
            const stockMeta = quotes[item.symbol]?.stock;
            const baseClose = quote && history.length ? baseCloseSince(history, item.createdAt) : null;
            const sinceChange = quote && baseClose ? ((quote.price - baseClose) / baseClose) * 100 : null;
            const todayChange = quote ? quote.changePercent : null;
            const met = watchConditionMet(item, quote?.price, todayChange);
            const conditionDesc = watchConditionDesc(item);
            const status = watchStatusMap[item.status] ?? watchStatusMap["等待条件"];
            const StatusIcon = status.icon;
            const industryLabel = stockMeta?.industry || "行业信息待补充";
            const isEtf = stockMeta?.instrumentType === "etf";
            const reviewedDate = item.lastReviewedAt
              ? formatDateShanghai(item.lastReviewedAt)
              : null;
            const watchedDays = Math.max(0, Math.round((today.getTime() - new Date(item.createdAt).getTime()) / 86_400_000));
            return (
              <article className="panel watch-card" key={item.symbol}>
                <header className="watch-card-head">
                  <div className="watch-card-id">
                    <span className="stock-avatar" aria-hidden="true">
                      {isEtf ? "F" : item.name?.slice(0, 1) || item.symbol.slice(-2)}
                    </span>
                    <div className="watch-card-titles">
                      <h3>
                        {item.name || item.symbol}
                        <small>{item.symbol}</small>
                      </h3>
                      <p className="watch-card-subtitle">
                        <span className={`watch-card-tag ${isEtf ? "is-etf" : "is-stock"}`}>{isEtf ? "ETF" : "股票"}</span>
                        <span>{industryLabel}</span>
                      </p>
                    </div>
                  </div>
                  <Badge tone={status.tone} className="watch-card-status">
                    <StatusIcon size={12} />
                    {status.label}
                  </Badge>
                </header>

                <div className="watch-card-price">
                  <div className="watch-card-price-main">
                    {quote ? (
                      <strong className={todayChange !== null && todayChange < 0 ? "down" : "up"}>{price(quote.price)}</strong>
                    ) : <strong className="quote-pending">行情待更新</strong>}
                    {todayChange !== null && quote && (
                      <span className={`watch-card-change ${todayChange >= 0 ? "up" : "down"}`}>
                        {todayChange >= 0 ? <ArrowUp size={14} /> : <ArrowDown size={14} />}
                        {Math.abs(todayChange).toFixed(2)}%
                      </span>
                    )}
                  </div>
                  <div className="watch-card-since">
                    <span>加入关注以来</span>
                    <strong className={sinceChange !== null && sinceChange < 0 ? "down" : sinceChange !== null && sinceChange > 0 ? "up" : ""}>
                      {sinceChange === null ? "—" : `${sinceChange >= 0 ? "+" : ""}${sinceChange.toFixed(2)}%`}
                      <small>· {watchedDays > 0 ? `${watchedDays}天` : "今日"}</small>
                    </strong>
                  </div>
                </div>

                {met && (
                  <div className="condition-met">
                    <span className="condition-met-badge">✓ 条件已满足</span>
                    <span className="condition-met-desc">{conditionDesc}</span>
                  </div>
                )}

                {history.length >= 2 ? (
                  <Sparkline
                    history={history}
                    baseClose={baseClose}
                    change={sinceChange}
                    width={300}
                    height={56}
                  />
                ) : (
                  <div className="sparkline sparkline--empty" aria-hidden="true">
                    <span>走势数据收集中</span>
                  </div>
                )}

                {editing === item.symbol ? (
                  <form className="watch-edit-form" onSubmit={(event) => void saveCondition(event, item.symbol)}>
                    <Field label="观察状态">
                      <Select name="status" defaultValue={item.status}>
                        <option>研究中</option>
                        <option>等待条件</option>
                        <option>已买入</option>
                        <option>暂停</option>
                      </Select>
                    </Field>
                    <fieldset className="condition-fieldset">
                      <legend>自动触发提醒（可选）</legend>
                      <div className="condition-row">
                        <Select name="conditionMetric" defaultValue={item.conditionMetric ?? ""}>
                          <option value="">不设置</option>
                          <option value="price">现价达到</option>
                          <option value="change">今日涨跌幅达到</option>
                        </Select>
                        <Select name="conditionDirection" defaultValue={item.conditionDirection ?? "above"}>
                          <option value="above">≥ 高于/达到</option>
                          <option value="below">≤ 低于/跌破</option>
                        </Select>
                        <Input type="number" step={0.01} name="conditionValue" defaultValue={item.conditionValue ?? ""} placeholder="阈值" aria-label="触发阈值" />
                      </div>
                      <Hint>设置后，行情满足时会自动在卡片上标注「条件已满足」。</Hint>
                    </fieldset>
                    <Field label="行动条件（备注）">
                      <Textarea name="conditionText" defaultValue={item.conditionText} required maxLength={300} placeholder="写下你会因为什么而买入、什么情况下认错离场" />
                    </Field>
                    <div className="form-actions">
                      <Button variant="ghost" type="button" onClick={() => setEditing(null)}>取消</Button>
                      <Button variant="primary" type="submit">保存</Button>
                    </div>
                  </form>
                ) : (
                  <>
                    <div className="watch-note">
                      <span className="watch-note-label"><MessageCircle size={13} />我的条件</span>
                      <p>{item.conditionText?.trim() || "还没有写下条件——先想清楚再决定要不要行动。"}</p>
                    </div>
                    <div className="watch-card-meta">
                      <span><CalendarDays size={13} />最近检查 {reviewedDate ?? "尚未检查"}</span>
                    </div>
                    <div className="watch-card-actions">
                      <Button variant="primary" iconRight={<ArrowUp size={14} style={{ transform: "rotate(45deg)" }} />} onClick={() => onAnalyze(item.symbol)}>查看分析</Button>
                      <IconButton label="编辑条件" title="编辑条件" onClick={() => setEditing(item.symbol)}><Pencil size={16} /></IconButton>
                      <IconButton label="移出关注" title="移出关注" variant="danger" onClick={() => setConfirming(item.symbol)}><Trash2 size={16} /></IconButton>
                    </div>
                  </>
                )}
              </article>
            );
          })}
        </div>
      ) : <div className="empty-state">关注列表还是空的。查一只股票后点击“加入关注”。</div>}
      <ConfirmDialog
        open={!!confirming}
        eyebrow="确认操作"
        title="移出关注？"
        message={`${confirming ? items.find((item) => item.symbol === confirming)?.name || confirming : ""} 将从关注列表中移除，已写的条件也会一并删除。此操作不会影响你的交易记录。`}
        confirmLabel="确认移出"
        tone="danger"
        onCancel={() => setConfirming(null)}
        onConfirm={() => { if (confirming) void confirmRemove(confirming); }}
      />
      {message && <div className="toast inline-toast" role="status">{message}</div>}
    </div>
  );
}

function Trades({ trades, reviews, alerts, capitalFlows, initialCapitalCents, onBuy, onSell, onReview, onDeleteTrade }: {
  trades: Trade[];
  reviews: Review[];
  /** 用于在买入行内展示该股票当前的止损/止盈目标价 */
  alerts: AlertRule[];
  capitalFlows: CapitalFlow[];
  initialCapitalCents: number | null;
  onBuy: () => void;
  onSell: () => void;
  onReview: (cycleEndTradeId: number) => void;
  onDeleteTrade: (id: number) => void;
}) {
  const portfolio = useMemo(() => calculatePortfolio(trades), [trades]);
  const cycles = useMemo(() => buildTradeCycles(trades), [trades]);
  const completedCycles = useMemo(
    () => cycles.filter((cycle) => cycle.endTradeId !== null),
    [cycles],
  );
  const cycleByTradeId = useMemo(
    () => new Map(cycles.flatMap((cycle) => cycle.trades.map((trade) => [trade.id, cycle] as const))),
    [cycles],
  );
  const reviewed = useMemo(() => {
    const s = new Set(reviews.flatMap((review) => review.cycleEndTradeId ? [review.cycleEndTradeId] : []));
    for (const review of reviews.filter((item) => item.cycleEndTradeId === null)) {
      const legacyCycle = [...completedCycles]
        .reverse()
        .find((cycle) => cycle.symbol === review.symbol && cycle.endTradeId && !s.has(cycle.endTradeId));
      if (legacyCycle?.endTradeId) s.add(legacyCycle.endTradeId);
    }
    return s;
  }, [reviews, completedCycles]);
  const winningCycles = completedCycles.filter((cycle) => cycle.realizedCents > 0).length;
  const losingCycles = completedCycles.length - winningCycles;
  const winRate = completedCycles.length ? Math.round(winningCycles / completedCycles.length * 100) : null;

  // 排序 + 分页 state（默认：按"已完成周期优先 + 日期倒序"，与历史行为一致）
  type SortKey = "default" | "date" | "symbol" | "side" | "status" | "createdAt" | "updatedAt";
  const [sortKey, setSortKey] = useState<SortKey>("default");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [currentPage, setCurrentPage] = useState(1);
  const pageSize = 20;

  // 绩效统计：复用 lib/domain/trade-statistics，在交易记录页直接给出复盘分析
  const stats = useMemo(() => calculateTradeStatistics(
    trades,
    capitalFlows,
    reviews.map((review) => ({
      cycleEndTradeId: review.cycleEndTradeId,
      symbol: review.symbol,
      resultCents: review.resultCents,
      tags: review.tags,
      followedPlan: review.followedPlan,
    })),
    initialCapitalCents,
  ), [trades, capitalFlows, reviews, initialCapitalCents]);

  // 已完成的交易周期显示在上方，便于先看结果再补复盘；其余按交易日期倒序
  const sortedTrades = [...trades].sort((a, b) => {
    const cycleA = cycleByTradeId.get(a.id);
    const cycleB = cycleByTradeId.get(b.id);
    const aClosed = cycleA?.endTradeId !== null && cycleA?.endTradeId !== undefined;
    const bClosed = cycleB?.endTradeId !== null && cycleB?.endTradeId !== undefined;
    if (aClosed !== bClosed) return aClosed ? -1 : 1;
    return b.tradeDate.localeCompare(a.tradeDate) || b.id - a.id;
  });

  // 用户可控排序：默认沿用 sortedTrades（已完成优先 + 日期倒序）；
  // 选具体列时按该列排序（数字/时间按数值，文字按字典序）。
  const displayedTrades = useMemo(() => {
    if (sortKey === "default") return sortedTrades;
    const arr = [...trades];
    const dir = sortDir === "asc" ? 1 : -1;
    const statusRank = (trade: { id: number; side: string }) => {
      const cycle = cycleByTradeId.get(trade.id);
      if (cycle?.endTradeId === null) return 0; // 持仓中
      if (cycle?.endTradeId === trade.id) return reviewed.has(cycle.endTradeId) ? 3 : 2; // 卖出：已复盘/待复盘
      return 1; // 周期中买入
    };
    arr.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "date": cmp = a.tradeDate.localeCompare(b.tradeDate); break;
        case "symbol": cmp = a.name.localeCompare(b.name, "zh-Hans-CN") || a.symbol.localeCompare(b.symbol); break;
        case "side": cmp = a.side.localeCompare(b.side); break;
        case "status": cmp = statusRank(a) - statusRank(b); break;
        case "createdAt": cmp = (a.createdAt ?? "").localeCompare(b.createdAt ?? ""); break;
        case "updatedAt": cmp = (a.updatedAt ?? a.createdAt ?? "").localeCompare(b.updatedAt ?? b.createdAt ?? ""); break;
      }
      if (cmp === 0) cmp = b.id - a.id; // 稳定次排序
      return cmp * dir;
    });
    return arr;
  }, [trades, sortedTrades, sortKey, sortDir, cycleByTradeId, reviewed]);

  // 排序变化时回到第 1 页。采用 React 官方「渲染期间根据变化调整 state」的模式，
  // 而非 effect 内 setState —— 后者会先提交一帧「新排序 + 旧页码」的错误画面再纠正。
  const sortSignature = `${sortKey}|${sortDir}`;
  const [prevSortSignature, setPrevSortSignature] = useState(sortSignature);
  if (prevSortSignature !== sortSignature) {
    setPrevSortSignature(sortSignature);
    setCurrentPage(1);
  }

  // 分页
  const totalPages = Math.max(1, Math.ceil(displayedTrades.length / pageSize));
  const safePage = Math.min(currentPage, totalPages);
  const pagedTrades = displayedTrades.slice((safePage - 1) * pageSize, safePage * pageSize);

  // 表头点击切换排序（"默认"切到该列 desc）
  function toggleSort(key: Exclude<SortKey, "default">) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  // 把 createdAt/updatedAt（ISO 字符串）格式化成 "MM-DD HH:mm" + 年份，分两行展示
  function formatTimeShort(value: string | undefined) {
    if (!value) return "—";
    const text = formatDateTimeShanghai(value);
    // 形如 "2026-08-03 12:34:56"；取 MM-DD HH:mm
    const m = text.match(/(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
    if (m) return `${m[1]}-${m[2]} ${m[3]}:${m[4]}`;
    return text;
  }
  function formatYear(value: string | undefined) {
    if (!value) return "";
    const text = formatDateTimeShanghai(value);
    const m = text.match(/^(\d{4})/);
    return m ? m[1] : "";
  }
  // 排序键 → 中文标签（分页栏显示）
  const sortLabel = (key: SortKey) => ({
    default: "默认", date: "日期", symbol: "股票", side: "操作", status: "状态", createdAt: "创建时间", updatedAt: "操作时间",
  })[key];

  // 摘要与提示副标题
  const summaryMeta = completedCycles.length === 0
    ? "还没有完成的交易"
    : `${completedCycles.length} 轮已完成 · ${winningCycles} 胜${losingCycles > 0 ? ` · ${losingCycles} 负` : ""}`;

  return (
    <div className="page-content inner-page">
      <SectionHeader as="h2" size="xl" eyebrow="真实记录，才能真实复盘" title="交易记录" subtitle="只有完全清仓才会生成待复盘任务；部分卖出仍属于同一持仓周期。" actions={<div className="intro-actions"><Button variant="ghost" onClick={onSell} disabled={!portfolio.positions.length}>记录卖出</Button><Button variant="primary" iconLeft={<Plus size={16} />} onClick={onBuy}>记录买入</Button></div>} />
      <div className="summary-strip trade-summary">
        <div className="stat-primary">
          <span>已实现盈亏</span>
          <strong className={portfolio.realizedCents >= 0 ? "up" : "down"}>{money(portfolio.realizedCents)}</strong>
          <small className="stat-meta">{summaryMeta}</small>
        </div>
        <div><span>交易记录</span><strong>{trades.length}</strong></div>
        <div><span>当前持仓</span><strong>{portfolio.positions.length}</strong></div>
        <div>
          <span>完整胜率</span>
          <strong>
            {winRate !== null ? (
              <span className="num-with-unit">{winRate}<i>%</i></span>
            ) : "暂无"}
          </strong>
        </div>
      </div>
      {stats.totalTrades > 0 && (
        <section className="panel trade-analytics">
          <div className="panel-head">
            <h3>数据分析</h3>
            <small>基于 {stats.totalTrades} 轮的已完成交易周期</small>
          </div>
          <div className="analytics-grid">
            <Stat
              label="胜率"
              value={`${stats.winRate}%`}
              hint={`${stats.winningTrades} 胜 / ${stats.losingTrades} 负`}
            />
            <Stat
              label="盈亏比"
              value={Number.isFinite(stats.profitFactor) ? stats.profitFactor.toFixed(2) : "—"}
              hint="盈利 / 亏损"
            />
            <Stat
              label="单周期期望"
              value={money(stats.expectancyCents)}
              hint="平均每轮"
              className={stats.expectancyCents >= 0 ? "up" : "down"}
            />
            <Stat
              label="最大回撤"
              value={money(stats.maxDrawdownCents)}
              hint="资金曲线峰值回落"
            />
            <Stat
              label="平均持仓"
              value={`${stats.avgHoldingDays} 天`}
              hint="建仓到平仓"
            />
            <Stat
              label="最长连胜 / 连亏"
              value={`${stats.longestWinStreak} / ${stats.longestLossStreak}`}
              hint={`当前 ${stats.currentLossStreak > 0 ? `连亏 ${stats.currentLossStreak}` : `连胜 ${stats.currentWinStreak}`}`}
            />
          </div>
          {stats.byMonth.length > 0 && (() => {
            const maxAbs = Math.max(
              1,
              ...stats.byMonth.map((item) => Math.abs(item.realizedCents)),
            );
            return (
              <div className="month-bars">
                <span className="month-bars-label">按月盈亏</span>
                <div className="month-bars-track">
                  {stats.byMonth.map((item) => (
                    <div className="month-bar" key={item.month} title={`${item.month}：${money(item.realizedCents)}`}>
                      <div
                        className={`month-bar-fill ${item.realizedCents >= 0 ? "up" : "down"}`}
                        style={{ height: `${Math.round(Math.abs(item.realizedCents) / maxAbs * 100)}%` }}
                      />
                      <small>{item.month.slice(2)}</small>
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}
        </section>
      )}
      {trades.length ? (
        <section className="panel trade-list">
          <div className="trade-head">
            <span>#</span>
            <span><SortHeader label="日期" active={sortKey === "date"} dir={sortKey === "date" ? sortDir : null} onClick={() => toggleSort("date")} /></span>
            <span><SortHeader label="股票" active={sortKey === "symbol"} dir={sortKey === "symbol" ? sortDir : null} onClick={() => toggleSort("symbol")} /></span>
            <span><SortHeader label="操作" active={sortKey === "side"} dir={sortKey === "side" ? sortDir : null} onClick={() => toggleSort("side")} /></span>
            <span>原因</span>
            <span><SortHeader label="状态" active={sortKey === "status"} dir={sortKey === "status" ? sortDir : null} onClick={() => toggleSort("status")} /></span>
            <span><SortHeader label="创建时间" active={sortKey === "createdAt"} dir={sortKey === "createdAt" ? sortDir : null} onClick={() => toggleSort("createdAt")} /></span>
            <span><SortHeader label="操作时间" active={sortKey === "updatedAt"} dir={sortKey === "updatedAt" ? sortDir : null} onClick={() => toggleSort("updatedAt")} /></span>
            <span></span>
          </div>
          {pagedTrades.map((trade, idx) => {
            const cycle = cycleByTradeId.get(trade.id);
            const hasReview = cycle?.endTradeId ? reviewed.has(cycle.endTradeId) : false;
            const isCycleClosingSell = trade.side === "卖出" && cycle?.endTradeId === trade.id;
            const cyclePnl = isCycleClosingSell ? cycle.realizedCents : null;
            return (
              <div className="trade-row" key={trade.id}>
                <span className="trade-index">{(safePage - 1) * pageSize + idx + 1}</span>
                <span><b>{trade.tradeDate}</b><small>{trade.quantity}股</small></span>
                <span>
                  <b>{trade.name}</b><small>{trade.symbol}</small>
                  {trade.side === "买入" && (() => {
                    const stop = alerts.find((al) => al.symbol === trade.symbol && al.type === "止损" && !al.acknowledgedAt);
                    const take1 = alerts.find((al) => al.symbol === trade.symbol && al.type === "止盈一" && !al.acknowledgedAt);
                    const take2 = alerts.find((al) => al.symbol === trade.symbol && al.type === "止盈二" && !al.acknowledgedAt);
                    if (!stop && !take1 && !take2) return null;
                    return (
                      <small className="trade-alerts-line">
                        {stop && <span className="trade-alert stop">止损 {alertPrice(stop)}</span>}
                        {take1 && <span className="trade-alert take">止盈一 {alertPrice(take1)}</span>}
                        {take2 && <span className="trade-alert take">止盈二 {alertPrice(take2)}</span>}
                      </small>
                    );
                  })()}
                </span>
                <span>
                  <Badge square tone={trade.side === "买入" ? "red" : "green"}>{trade.side}</Badge>
                  <small>
                    {tradePrice(trade)}
                    {cyclePnl !== null && cyclePnl !== 0 && (
                      <span className={`trade-pnl ${cyclePnl >= 0 ? "up" : "down"}`}>
                        {cyclePnl >= 0 ? "+" : ""}{money(cyclePnl)}
                      </span>
                    )}
                  </small>
                </span>
                <span className="trade-reason">{trade.reason}</span>
                <span>
                  {cycle?.endTradeId === null
                    ? <Badge tone="neutral">持仓中</Badge>
                    : hasReview
                      ? <Badge tone="green">已复盘</Badge>
                      : cycle?.endTradeId === trade.id
                        ? <Button variant="ghost" size="sm" onClick={() => onReview(cycle.endTradeId!)}>去复盘</Button>
                        : <Badge tone="amber">待复盘</Badge>}
                </span>
                <span className="trade-time" title={`创建于 ${trade.createdAt ?? "未知"}`}>
                  <b>{formatTimeShort(trade.createdAt)}</b>
                  <small>{formatYear(trade.createdAt)}</small>
                </span>
                <span className="trade-time" title={`最后修改于 ${trade.updatedAt ?? trade.createdAt ?? "未知"}`}>
                  <b>{formatTimeShort(trade.updatedAt ?? trade.createdAt)}</b>
                  <small>{formatYear(trade.updatedAt ?? trade.createdAt)}</small>
                </span>
                <span className="trade-actions">
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`删除交易 ${trade.name} ${trade.tradeDate}`}
                    onClick={() => {
                      if (window.confirm(`确认删除该笔交易？\n${trade.name} ${trade.tradeDate} ${trade.side} ${trade.quantity}股`)) {
                        onDeleteTrade(trade.id);
                      }
                    }}
                  >
                    删除
                  </Button>
                </span>
              </div>
            );
          })}
        </section>
      ) : <div className="empty-state">还没有交易记录。保存成功后刷新页面也不会丢失。</div>}
      {trades.length > 0 && (
        <div className="trade-pager">
          <span className="trade-pager__meta">
            第 {safePage} / {totalPages} 页 · 共 {displayedTrades.length} 条 · 每页 {pageSize} 条
            {sortKey !== "default" && <span className="trade-pager__sort">（按{sortLabel(sortKey)}{sortDir === "asc" ? " ↑" : " ↓"}）</span>}
          </span>
          <div className="trade-pager__btns">
            <Button variant="ghost" size="sm" disabled={safePage <= 1} onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}>上一页</Button>
            <Button variant="ghost" size="sm" disabled={safePage >= totalPages} onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}>下一页</Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** 表头点击排序按钮：显示列名 + 当前方向箭头（无排序时灰色） */
function SortHeader({ label, active, dir, onClick }: {
  label: string;
  active: boolean;
  dir: "asc" | "desc" | null;
  onClick: () => void;
}) {
  const arrow = !active ? "↕" : dir === "asc" ? "↑" : "↓";
  return (
    <button type="button" className={`trade-sort-btn${active ? " is-active" : ""}`} onClick={onClick} aria-label={`按${label}排序`}>
      {label} <span className="trade-sort-btn__arrow">{arrow}</span>
    </button>
  );
}

function Settings({ status, initialCapitalCents, capitalFlows, alerts, preferences, section, onSection, onDisable, onAcknowledge, onUpdateAlert, onNotifications, onSaveCapital, onAddFlow, onDeleteFlow, onSavePreferences, onImported, onClearCache, currentUser }: {
  status: Status | null;
  initialCapitalCents: number | null;
  capitalFlows: CapitalFlow[];
  alerts: AlertRule[];
  preferences: TradingPreferences | null;
  section: string | null;
  onSection: (section: string | null) => void;
  onDisable: (id: number) => void;
  onAcknowledge: (id: number) => void;
  onUpdateAlert: (id: number, targetPrice: number) => void;
  onNotifications: () => void;
  onSaveCapital: (initialCapital: number) => Promise<void>;
  onAddFlow: (amountCents: number, flowDate: string, note: string) => Promise<void>;
  onDeleteFlow: (flowId: number) => Promise<void>;
  onSavePreferences: (next: TradingPreferences) => Promise<void>;
  onImported: () => void;
  onClearCache: () => void;
  currentUser: User;
}) {
  const notificationState = typeof window !== "undefined" && "Notification" in window ? Notification.permission : "unsupported";
  const enabledAlertCount = alerts.filter((item) => item.enabled).length;
  const cardList = [
    ...(currentUser.role === "super_admin"
      ? [{
          id: "users",
          Icon: Users,
          title: "用户管理",
          caption: "账户与权限",
          text: "仅超级管理员可添加或删除用户，每个用户数据完全隔离。",
          state: "后台管理",
          tone: "blue",
        }]
      : []),
    {
      id: "account",
      Icon: Wallet,
      title: "账户资金",
      caption: "资金基准",
      text: "设置初始资金后，系统才能计算现金、总仓位和账户总盈亏。",
      state: initialCapitalCents === null ? "待设置" : money(initialCapitalCents),
      tone: initialCapitalCents === null ? "amber" : "green",
    },
    {
      id: "ai",
      Icon: MessageSquare,
      title: "分析助手",
      caption: "行情与财务解读",
      text: status?.deepseekConfigured
        ? "分析助手已由服务端安全配置。"
        : "当前未配置模型密钥，使用基于真实数据的自动解释。",
      state: status?.deepseekConfigured ? "已连接" : "自动模式",
      tone: status?.deepseekConfigured ? "green" : "neutral",
    },
    {
      id: "data",
      Icon: Database,
      title: "数据来源",
      caption: "行情与财务口径",
      text: status?.mairuiEnabled
        ? "麦蕊智数已启用并优先取数：营收/利润/负债率/PE/PB/ROE/行业/简介优先来自麦蕊，缺失自动回退腾讯/东方财富。显示获取时间，失败不会伪装成最新。"
        : "当前为免费多源：腾讯证券 + 东方财富。未配置麦蕊 token，营收/利润/负债率可能缺失，分析以技术面为主。",
      state: status?.mairuiEnabled ? "麦蕊优先" : "免费多源",
      tone: status?.mairuiEnabled ? "green" : "blue",
    },
    {
      id: "alerts",
      Icon: Bell,
      title: "提醒管理",
      caption: "价格与仓位提醒",
      text: `${status?.reminderMode ?? "页面打开期间检查"}。重要止损仍需在券商App重复设置。`,
      state: `${enabledAlertCount}条启用`,
      tone: enabledAlertCount === 0 ? "amber" : "green",
    },
    {
      id: "risk",
      Icon: ShieldCheck,
      title: "风险与纪律",
      caption: "个性化交易约束",
      text: "风险偏好档位与交易纪律会作为硬约束，用于买卖决策和仓位建议。",
      state: preferences ? `${preferences.riskProfile}型` : "平衡默认",
      tone: "blue",
    },
    {
      id: "privacy",
      Icon: Lock,
      title: "隐私与备份",
      caption: "数据所有权",
      text: "交易数据保存在私有数据库中，可随时下载JSON备份。",
      state: "默认私有",
      tone: "green",
    },
    {
      id: "cache",
      Icon: Trash2,
      title: "本地缓存",
      caption: "浏览器分析缓存",
      text: "浏览器本地保存的最近分析（最多6条）与行情快照，仅用于刷新页面免首屏空白。清空不影响服务器上的交易、关注、复盘等数据。",
      state: "可清空",
      tone: "neutral",
    },
  ];

  const boundaries = [
    { Icon: ShieldCheck, label: "不自动交易", detail: "任何买卖都需要你在券商App操作" },
    { Icon: MessageCircle, label: "不荐股不承诺收益", detail: "本应用只整理公开信息与你的真实数据" },
    { Icon: AlertTriangle, label: "不承诺提醒必达", detail: "浏览器通知可能被系统拦截" },
{ Icon: CheckCircle2, label: "数据缺失会明说", detail: "查不到的字段显示「暂无」，不补数字" },
{ Icon: SettingsIcon, label: "最终决定由你作出", detail: "重要止损请在券商App重复设置" },
    { Icon: Database, label: "数据随时可带走", detail: "所有记录都能导出为JSON备份" },
  ];

  return (
    <div className="page-content inner-page settings-page">
      <header className="settings-hero">
        <div className="settings-hero__text">
          <span className="settings-hero__eyebrow">SETTINGS · 真实连接状态</span>
          <h1 className="settings-hero__title">设置</h1>
          <p className="settings-hero__subtitle">
            这里展示真实连接状态，不再用演示文案冒充功能。
          </p>
        </div>
        <div className="settings-hero__badge">
          <ShieldCheck size={14} />
          <span>私有个人空间</span>
        </div>
      </header>

      <section className="settings-stack" aria-label="设置分组">
        {cardList.map((card) => {
          const isOpen = section === card.id;
          return (
            <article
              key={card.id}
              className={[
                "settings-card",
                `settings-card--${card.tone}`,
                isOpen ? "settings-card--open" : "",
              ].filter(Boolean).join(" ")}
            >
              <button
                type="button"
                className="settings-card__hit"
                onClick={() => onSection(isOpen ? null : card.id)}
                aria-expanded={isOpen}
                aria-controls={`settings-detail-${card.id}`}
              >
                <span className="settings-card__icon" aria-hidden="true">
                  <card.Icon size={22} />
                </span>
                <span className="settings-card__body">
                  <span className="settings-card__caption">{card.caption}</span>
                  <span className="settings-card__title">{card.title}</span>
                  <span className="settings-card__text">{card.text}</span>
                </span>
                <span className="settings-card__trail">
                  <span className={`settings-pill settings-pill--${card.tone}`}>
                    <span className="settings-pill__dot" aria-hidden="true" />
                    {card.state}
                  </span>
                  <span className="settings-card__chevron" aria-hidden="true">
                    <ChevronRight size={16} />
                  </span>
                </span>
              </button>

              <div
                id={`settings-detail-${card.id}`}
                className={`settings-card__detail ${isOpen ? "is-open" : ""}`}
                aria-hidden={!isOpen}
              >
                {card.id === "account" && (
                  <CapitalSettings
                    initialCapitalCents={initialCapitalCents}
                    capitalFlows={capitalFlows}
                    onSave={onSaveCapital}
                    onAddFlow={onAddFlow}
                    onDeleteFlow={onDeleteFlow}
                  />
                )}
                {card.id === "ai" && (
                  <div className="settings-card__panel">
                    <h3>分析引擎状态</h3>
                    <p>
                      {status?.deepseekConfigured
                        ? "模型 API 密钥只在服务端读取，浏览器无法看到。"
                        : "没有模型密钥时，系统不会假装调用模型，而是明确显示「自动解释」。"}
                    </p>
                    {status?.aiProvider && (
                      <div className="settings-card__meta">
                        <span>服务方</span>
                        <b>{status.aiProvider}</b>
                      </div>
                    )}
                  </div>
                )}
                {card.id === "data" && (
                  <div className="settings-card__panel">
                    <h3>数据原则</h3>
                    <p>行情来自公开接口，可能延迟或暂时不可用。每次分析都记录来源、行情时间和获取时间；财务数据缺失时显示「暂无」，不会补数字。</p>
                    <h3 className="settings-card__subhead">从券商导入交易记录</h3>
                    <p>粘贴券商App导出的交割单文本，系统会解析并写入「交易记录」。这是低频的初始化动作，放在此处而不是交易列表里。</p>
                    <ImportPanel onImported={onImported} />
                  </div>
                )}
                {card.id === "alerts" && (
                  <div className="settings-card__panel">
                    <div className="settings-card__panel-head">
                      <div>
                        <h3>提醒管理</h3>
                        <p>浏览器权限：{notificationState}</p>
                      </div>
                      <Button variant="primary" onClick={onNotifications}>申请浏览器通知</Button>
                    </div>
                    {alerts.length ? (
                      <ul className="settings-card__alerts">
                        {alerts.map((alert) => {
                          const triggered = !!alert.triggeredAt && !alert.acknowledgedAt;
                          return (
                            <li key={alert.id}>
                              <div>
                                <b>{alert.name} · {alert.type}</b>
                                <small>{alertPrice(alert)} · {alert.enabled ? "启用" : "已停用"}{triggered ? " · 已触发" : ""}</small>
                                {triggered && <span className="triggered-badge small">已触发</span>}
                              </div>
                              <div className="settings-card__alert-actions">
                                {triggered && (
                                  <Button variant="danger" size="sm" onClick={() => onAcknowledge(alert.id)}>我知道了</Button>
                                )}
                                {alert.enabled && !triggered && (
                                  <>
                                    <Button variant="ghost" size="sm" onClick={() => {
                                      const next = window.prompt(`修改「${alert.name} · ${alert.type}」目标价（元）`, String((alert.targetPriceMillis ?? alert.targetPriceCents * 10) / 1000));
                                      if (next !== null && next.trim() !== "") {
                                        const value = Number(next);
                                        if (Number.isFinite(value) && value > 0) onUpdateAlert(alert.id, value);
                                        else window.alert("目标价必须是正数");
                                      }
                                    }}>改价</Button>
                                    <Button variant="ghost" size="sm" onClick={() => onDisable(alert.id)}>停用</Button>
                                  </>
                                )}
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    ) : (
                      <p className="settings-card__hint">暂无提醒规则。买入时会自动生成止损与止盈建议。</p>
                    )}
                  </div>
                )}
                {card.id === "privacy" && (
                  <div className="settings-card__panel">
                    <h3>导出个人数据</h3>
                    <p>备份包含交易、关注、提醒与复盘，不包含任何API密钥。</p>
                    <a className="btn btn--primary" href="/api/export">下载JSON备份</a>
                  </div>
                )}
                {card.id === "cache" && (
                  <div className="settings-card__panel">
                    <h3>清空本地分析缓存</h3>
                    <p>浏览器本地保存的最近分析（最多6条，7天自动过期）与行情快照（10分钟）仅用于刷新页面时免首屏空白。清空后不影响服务器上的交易、关注、复盘等数据，重新分析会自动重新生成。</p>
                    <Button variant="danger" onClick={onClearCache}>清空本地缓存</Button>
                  </div>
                )}
                {card.id === "risk" && (
                  <PreferencesSettings preferences={preferences} onSave={onSavePreferences} />
                )}
                {card.id === "users" && (
                  <UsersAdmin currentUserId={currentUser.id} />
                )}
              </div>
            </article>
          );
        })}
      </section>

      <section className="boundary-card" aria-label="产品边界">
        <header className="boundary-card__head">
          <span className="boundary-card__eyebrow">诚实陈述</span>
          <h2>产品边界</h2>
          <p>只做能稳定交付的事情，其余明确告诉你。</p>
        </header>
        <ul className="boundary-card__list">
          {boundaries.map((item) => (
            <li key={item.label}>
              <span className="boundary-card__icon" aria-hidden="true">
                <item.Icon size={18} />
              </span>
              <span className="boundary-card__copy">
                <b>{item.label}</b>
                <small>{item.detail}</small>
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function CapitalSettings({ initialCapitalCents, capitalFlows, onSave, onAddFlow, onDeleteFlow }: {
  initialCapitalCents: number | null;
  capitalFlows: CapitalFlow[];
  onSave: (initialCapital: number) => Promise<void>;
  onAddFlow: (amount: number, date: string, note: string) => Promise<void>;
  onDeleteFlow: (flowId: number) => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [flowSaving, setFlowSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [flowMsg, setFlowMsg] = useState("");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = Number(new FormData(event.currentTarget).get("initialCapital"));
    setSaving(true);
    setMessage("");
    try {
      await onSave(value);
      setMessage("已保存，首页仓位与盈亏将按新的资金基准重新计算。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function submitFlow(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fd = new FormData(form);
    const amountYuan = Number(fd.get("flowAmount"));
    const flowDate = String(fd.get("flowDate")).trim();
    const note = String(fd.get("flowNote")).trim();
    const direction = String(fd.get("flowDirection"));
    if (!amountYuan || amountYuan <= 0 || !flowDate) return;
    const amountCents = Math.round(amountYuan * 100) * (direction === "out" ? -1 : 1);
    setFlowSaving(true);
    setFlowMsg("");
    try {
      await onAddFlow(amountCents, flowDate, note);
      form.reset();
      setFlowMsg("已记录");
    } catch (error) {
      setFlowMsg(error instanceof Error ? error.message : "记录失败");
    } finally {
      setFlowSaving(false);
    }
  }

  const totalDeposit = capitalFlows.filter((f) => f.amountCents > 0).reduce((s, f) => s + f.amountCents, 0);
  const totalWithdrawal = capitalFlows.filter((f) => f.amountCents < 0).reduce((s, f) => s + Math.abs(f.amountCents), 0);

  return (
    <>
      <section className="settings-card__panel">
        <h3>账户初始资金</h3>
        <p>填写开始使用本软件时账户内用于股票交易的总资金。现金按交易流水和出入金记录自动推算。</p>
        <form className="capital-form" onSubmit={submit}>
          <Field label="初始资金（元）">
            <Input name="initialCapital" type="number" min={100} max={1000000000} step={0.01} defaultValue={initialCapitalCents === null ? "" : initialCapitalCents / 100} placeholder="例如 100000" required />
          </Field>
          <Button variant="primary" type="submit" disabled={saving}>{saving ? "保存中…" : "保存资金基准"}</Button>
        </form>
        {message && <p className="form-message" role="status">{message}</p>}
      </section>

      <section className="settings-card__panel">
        <h3>出入金记录</h3>
        <p>发生场外转入或转出时，在此记录。现金余额 = 初始资金 + 累计转入 - 累计转出 - 买入成交额 + 卖出成交额 - 手续费。</p>

        <form className="capital-form flow-form" onSubmit={submitFlow}>
          <Field label="方向">
            <Select name="flowDirection" defaultValue="in">
              <option value="in">转入</option>
              <option value="out">转出</option>
            </Select>
          </Field>
          <Field label="金额（元）">
            <Input name="flowAmount" type="number" min={0.01} max={1000000000} step={0.01} placeholder="例如 5000" required />
          </Field>
          <Field label="日期">
            <Input name="flowDate" type="date" defaultValue={localIsoDate(new Date())} required />
          </Field>
          <Field label="备注">
            <Input name="flowNote" type="text" maxLength={60} placeholder="选填" />
          </Field>
          <Button variant="primary" type="submit" disabled={flowSaving}>{flowSaving ? "保存中…" : "记录流水"}</Button>
        </form>
        {flowMsg && <p className="form-message" role="status">{flowMsg}</p>}

        {capitalFlows.length > 0 && (
          <div className="flows-summary">
            <span>累计转入 <strong className="up">+{money(totalDeposit)}</strong></span>
            <span>累计转出 <strong className="down">-{money(totalWithdrawal)}</strong></span>
            <span>净流入 <strong className={totalDeposit - totalWithdrawal >= 0 ? "up" : "down"}>{totalDeposit - totalWithdrawal >= 0 ? "+" : ""}{money(totalDeposit - totalWithdrawal)}</strong></span>
          </div>
        )}

        {capitalFlows.length > 0 && (
          <ul className="flows-list">
            {capitalFlows.slice(0, 20).map((flow) => (
              <li key={flow.id} className="flow-row">
                <span className={`flow-tag ${flow.amountCents > 0 ? "flow-in" : "flow-out"}`}>
                  {flow.amountCents > 0 ? "转入" : "转出"}
                </span>
                <span className="flow-amount">{flow.amountCents > 0 ? "+" : ""}{money(flow.amountCents)}</span>
                <span className="flow-date">{flow.flowDate}</span>
                {flow.note && <span className="flow-note">{flow.note}</span>}
                <Button variant="danger" size="sm" onClick={() => onDeleteFlow(flow.id)} title="删除">删除</Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function TradeModal({ mode, stock, positions, analysisQuote, onClose, onSubmit, onSwitchStock }: {
  mode: TradeMode;
  stock: { code?: string; symbol?: string; name: string } | null;
  positions: ReturnType<typeof calculatePortfolio>["positions"];
  /** 买入时当前分析的技术位（支撑位 / 1R / 2R 目标），用于"采用技术面建议" */
  analysisQuote: { support?: number; target1?: number; target2?: number } | null;
  onClose: () => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  /** 对话框内手动切换到另一只股票时，重新拉取该股票的技术位（支撑位/1R/2R） */
  onSwitchStock?: (symbol: string) => void | Promise<void>;
}) {
  const firstInput = useRef<HTMLInputElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const stopLossRef = useRef<HTMLInputElement>(null);
  const takeProfit1Ref = useRef<HTMLInputElement>(null);
  const takeProfit2Ref = useRef<HTMLInputElement>(null);
  const maxLossRef = useRef<HTMLInputElement>(null);
  const reasonFieldsetRef = useRef<HTMLFieldSetElement>(null);
  const [saving, setSaving] = useState(false);
  const [selectedReason, setSelectedReason] = useState("");
  const [reasonError, setReasonError] = useState(false);
  const defaultPosition = mode === "sell" ? positions[0] : null;
  const symbol = stock?.code ?? stock?.symbol ?? defaultPosition?.symbol ?? "";
  const name = stock?.name ?? defaultPosition?.name ?? "";

  // 一键采用技术面建议：把支撑位填止损、1R/2R 填止盈，并清空 maxLoss（改用技术面止损位）
  function applyTechSuggestion() {
    if (!analysisQuote) return;
    if (analysisQuote.support != null && stopLossRef.current) stopLossRef.current.value = String(analysisQuote.support);
    if (analysisQuote.target1 != null && takeProfit1Ref.current) takeProfit1Ref.current.value = String(analysisQuote.target1);
    if (analysisQuote.target2 != null && takeProfit2Ref.current) takeProfit2Ref.current.value = String(analysisQuote.target2);
    if (maxLossRef.current) maxLossRef.current.value = "";
  }

  useEffect(() => {
    firstInput.current?.focus();
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    // 「为什么买/卖」的 radio 被视觉隐藏，原生 required 校验在移动端会作用到不可见元素，
    // 导致提交无任何可见提示。改为显式校验并给出可见的错误提示。
    if (!selectedReason) {
      setReasonError(true);
      reasonFieldsetRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    setReasonError(false);
    setSaving(true);
    try {
      await onSubmit(event);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="trade-modal-title">
        <header><div><span className="eyebrow">{mode === "buy" ? "写下当时的决定" : "记录真实的退出"}</span><h2 id="trade-modal-title">记录{mode === "buy" ? "买入" : "卖出"}</h2></div><IconButton label="关闭" onClick={onClose}><X size={18} /></IconButton></header>
        <form onSubmit={submit}>
          <div className="form-grid">
            <Field label="股票代码"><Input ref={firstInput} name="symbol" defaultValue={symbol} pattern="\d{6}" required onBlur={(event) => {
              const code = event.currentTarget.value.trim();
              const resolved = resolveStock(code);
              if (resolved && resolved.name !== resolved.code && nameInputRef.current) {
                nameInputRef.current.value = resolved.name;
              }
              // 手动改成另一只股票时，重新拉取该股票的技术位，避免技术面建议停留在旧股票
              if (onSwitchStock && /^\d{6}$/.test(code) && code !== (stock?.code ?? stock?.symbol)) {
                void onSwitchStock(code);
              }
            }} /></Field>
            <Field label="股票名称"><Input ref={nameInputRef} name="name" defaultValue={name} required maxLength={30} /></Field>
            <Field label={mode === "buy" ? "买入价格" : "卖出价格"}><Input name="price" type="number" min="0" step="any" required /></Field>
            <Field label="数量（股）"><Input name="quantity" type="number" min="1" step="1" required /></Field>
            <Field label="交易日期"><Input name="tradeDate" type="date" defaultValue={localIsoDate()} max={localIsoDate()} required /></Field>
            <Field label="总费用（可选）"><Input name="fee" type="number" min="0" step="0.01" defaultValue="0" /></Field>
            {mode === "buy" && (
              <>
                {analysisQuote && (analysisQuote.support != null || analysisQuote.target1 != null || analysisQuote.target2 != null) && (
                  <div className="tech-suggestion">
                    <div className="tech-suggestion__head">
                      <span><Zap size={13} /> 技术面自动建议</span>
                      <button type="button" className="tech-suggestion__apply" onClick={applyTechSuggestion}>
                        一键采用
                      </button>
                    </div>
                    <div className="tech-suggestion__row">
                      <span>止损参考（支撑位）</span><strong>{analysisQuote.support != null ? price(analysisQuote.support) : "缺失"}</strong>
                      <span>止盈参考一（1R）</span><strong>{analysisQuote.target1 != null ? price(analysisQuote.target1) : "缺失"}</strong>
                      <span>止盈参考二（2R）</span><strong>{analysisQuote.target2 != null ? price(analysisQuote.target2) : "缺失"}</strong>
                    </div>
                    <p className="tech-suggestion__note">来自该股当前分析的支撑位与 1R/2R 目标，点「一键采用」填入下方；可再手动改。</p>
                  </div>
                )}
                <Field label="止损价（元，可选）" help="留空时按下方「最多接受亏损」反推；也可点上方「技术面建议」用支撑位自动填入，系统据此设止损并算止盈。">
                  <Input ref={stopLossRef} name="stopLoss" type="number" min="0" step="any" placeholder="技术面支撑位或自定" />
                </Field>
                <Field label="最多接受亏损（元）" help={`如果判断错了，这笔交易最多愿意亏多少钱？请填你能实际执行的金额。系统会用「成本价 − 最多接受亏损 ÷ 股数」生成止损价，并按 ${TAKE_PROFIT_1_R}/${TAKE_PROFIT_2_R} 倍风险自动生成止盈一、止盈二。`}>
                  <Input ref={maxLossRef} name="maxLoss" type="number" min="0" step="0.01" placeholder="例如 500" />
                </Field>
                <Field label="止盈价一（元，可选）" help={`留空则按 ${TAKE_PROFIT_1_R} 倍风险自动推算；填写后覆盖系统推算。`}>
                  <Input ref={takeProfit1Ref} name="takeProfit1" type="number" min="0" step="any" placeholder={`留空则按 ${TAKE_PROFIT_1_R}R 推算`} />
                </Field>
                <Field label="止盈价二（元，可选）" help={`留空则按 ${TAKE_PROFIT_2_R} 倍风险自动推算；填写后覆盖系统推算。`}>
                  <Input ref={takeProfit2Ref} name="takeProfit2" type="number" min="0" step="any" placeholder={`留空则按 ${TAKE_PROFIT_2_R}R 推算`} />
                </Field>
              </>
            )}
          </div>
          <fieldset
            ref={reasonFieldsetRef}
            className={reasonError ? "reason-fieldset is-error" : "reason-fieldset"}
          >
            <legend>为什么{mode === "buy" ? "买" : "卖"}？<span className="req-mark">必选</span></legend>
            <div className="reason-options">
              {(mode === "buy" ? buyReasons : sellReasons).map((reason) => (
                <label key={reason}>
                  <input
                    className="visually-hidden"
                    type="radio"
                    name="reason"
                    value={reason}
                    checked={selectedReason === reason}
                    onChange={(event) => { setSelectedReason(event.currentTarget.value); setReasonError(false); }}
                  />
                  <span>{reason}</span>
                </label>
              ))}
            </div>
            {reasonError && (
              <p className="form-message form-message--error" role="alert">
                请先选择一项「为什么{mode === "buy" ? "买" : "卖"}」，才能保存。
              </p>
            )}
            {selectedReason === "其他" && (
              <Field label="补充说明（可选）" className="other-reason-field">
                <Input name="otherReason" placeholder="请简要说明具体原因…" maxLength={200} />
              </Field>
            )}
          </fieldset>
          {mode === "buy" && <div className="calculation-tip"><b>1R是什么？</b>它是你愿意承担的这笔亏损。系统会据此计算风险观察线和1R、2R参考目标；它们不是收益预测，仍由你确认和执行。</div>}
          <div className="modal-actions"><Button variant="ghost" onClick={onClose}>取消</Button><Button variant="primary" type="submit" disabled={saving}>{saving ? "正在保存…" : "确认保存"}</Button></div>
        </form>
      </section>
    </div>
  );
}

function ReviewModal({ cycle, onClose, onSaved }: {
  cycle: TradeCycle;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const related = cycle.trades;
  const name = cycle.name;
  const summary = getCycleSummary(cycle);
  const buyReason = related.find((trade) => trade.side === "买入")?.reason ?? "";
  const sellReason = [...related].reverse().find((trade) => trade.side === "卖出")?.reason ?? "";
  const firstInput = useRef<HTMLTextAreaElement>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [followedPlan, setFollowedPlan] = useState<"yes" | "no" | null>(
    summary.hasPlan ? (summary.withinPlan ? "yes" : "no") : null,
  );
  const [deviationReason, setDeviationReason] = useState("");
  const [planError, setPlanError] = useState(false);
  const planFieldsetRef = useRef<HTMLFieldSetElement>(null);

  function addTagFromInput() {
    const value = tagInput.trim().slice(0, 20);
    if (!value || tags.includes(value) || tags.length >= 10) {
      setTagInput("");
      return;
    }
    setTags([...tags, value]);
    setTagInput("");
  }
  function removeTag(target: string) {
    setTags(tags.filter((tag) => tag !== target));
  }

  useEffect(() => {
    firstInput.current?.focus();
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setMessage("");
    // 「有没有按计划执行」的 radio 被视觉隐藏，原生 required 校验在移动端会作用到不可见元素，
    // 导致提交无任何可见提示。改为显式校验并给出可见的错误提示。
    if (followedPlan == null) {
      setPlanError(true);
      planFieldsetRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      setSaving(false);
      return;
    }
    setPlanError(false);
    const data = new FormData(event.currentTarget);
    try {
      await jsonRequest("/api/reviews", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          symbol: cycle.symbol,
          name,
          cycleEndTradeId: cycle.endTradeId,
          buyReason: data.get("buyReason"),
          sellReason: data.get("sellReason"),
          followedPlan: data.get("followedPlan") === "yes",
          lesson: data.get("lesson"),
          deviationReason,
          tags,
        }),
      });
      await onSaved();
    } catch (saveError) {
      setMessage(saveError instanceof Error ? saveError.message : "复盘保存失败");
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal review-modal" role="dialog" aria-modal="true" aria-labelledby="review-title">
        <header><div><span className="eyebrow">只改进一件事</span><h2 id="review-title">复盘 {name}</h2></div><IconButton label="关闭" onClick={onClose}><X size={18} /></IconButton></header>
        <form onSubmit={save}>
          <div className="cycle-facts">
            <div><span>持有天数</span><strong>{summary.holdingDays} 天</strong></div>
            <div><span>买入均价</span><strong>¥{summary.buyAvgPrice.toFixed(2)}</strong></div>
            <div><span>卖出均价</span><strong>¥{summary.sellAvgPrice.toFixed(2)}</strong></div>
            <div><span>已实现盈亏<small className="auto-note">（自动计入，无需填写）</small></span><strong className={summary.realizedCents >= 0 ? "up" : "down"}>{money(summary.realizedCents)}</strong></div>
            <div><span>收益率</span><strong className={(summary.returnPct ?? 0) >= 0 ? "up" : "down"}>{summary.returnPct === null ? "—" : `${summary.returnPct >= 0 ? "+" : ""}${summary.returnPct.toFixed(1)}%`}</strong></div>
          </div>
          {summary.hasPlan && (
            <div className={`plan-verdict ${summary.withinPlan ? "good" : "bad"}`}>
              {summary.withinPlan
                ? `买入时计划最多亏损 ${money(summary.planLossCents)}，本次实际${summary.realizedCents >= 0 ? "盈利" : `亏损 ${money(-summary.realizedCents)}`}，在计划内。`
                : `买入时计划最多亏损 ${money(summary.planLossCents)}，本次亏损 ${money(-summary.realizedCents)}，已超出计划——止损没守住。`}
            </div>
          )}
          <Field label="为什么买？"><Textarea ref={firstInput} name="buyReason" defaultValue={buyReason} required maxLength={300} /></Field>
          <Field label="为什么卖？"><Textarea name="sellReason" defaultValue={sellReason} required maxLength={300} /></Field>
          <fieldset
            ref={planFieldsetRef}
            className={planError ? "reason-fieldset is-error" : "reason-fieldset"}
          >
            <legend>有没有按计划执行？<span className="req-mark">必选</span><small>{summary.hasPlan ? "程序已按计划止损自动预判，可修正" : "买入时未填计划亏损，请凭记忆判断"}</small></legend>
            <div className="reason-options">
              <label><input className="visually-hidden" type="radio" name="followedPlan" value="yes" checked={followedPlan === "yes"} onChange={() => { setFollowedPlan("yes"); setPlanError(false); }} /><span>有，按计划</span></label>
              <label><input className="visually-hidden" type="radio" name="followedPlan" value="no" checked={followedPlan === "no"} onChange={() => { setFollowedPlan("no"); setPlanError(false); }} /><span>没有</span></label>
            </div>
            {planError && (
              <p className="form-message form-message--error" role="alert">
                请先选择「有，按计划」或「没有」，才能保存复盘。
              </p>
            )}
          </fieldset>
          {followedPlan === "no" && (
            <Field label="这次偏离计划在哪？" help="写清和计划的差异，便于「分析」视图统计纪律缺口（最多 300 字）">
              <Textarea name="deviationReason" value={deviationReason} maxLength={300} onChange={(event) => setDeviationReason(event.target.value)} placeholder="例如：触发止损后没执行，又扛了两天才割；临时追高，超出了原定买点。" />
            </Field>
          )}
          <Field label="下一次只改进哪一件事？"><Textarea name="lesson" required maxLength={500} placeholder={summary.hasPlan && !summary.withinPlan ? "例如：触发止损后当天执行，不再向下移动止损线。" : "例如：买入前先把卖出条件写清楚，避免临时起意。"} /></Field>
          <Field label="给这次复盘打标签" help="用于「分析」视图按标签统计盈亏（最多 10 个）">
            <div className="tag-editor">
              <div className="tag-chips">
                {tags.map((tag) => (
                  <span key={tag} className="tag-chip">{tag}<IconButton label={`移除${tag}`} variant="ghost" onClick={() => removeTag(tag)}><X size={12} /></IconButton></span>
                ))}
              </div>
              <input
                className="tag-input"
                value={tagInput}
                placeholder="输入标签后回车，如：按计划 / 追高"
                onChange={(event) => setTagInput(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addTagFromInput(); } }}
              />
            </div>
            <div className="tag-suggestions">
              {["按计划", "没按计划", "追高", "恐慌卖", "突破", "均线回踩", "题材", "止损纪律", "情绪化"]
                .filter((suggestion) => !tags.includes(suggestion))
                .slice(0, 8)
              .map((suggestion) => (
                <button type="button" key={suggestion} className="tag-suggestion" onClick={() => { if (tags.length < 10 && !tags.includes(suggestion)) setTags([...tags, suggestion]); }}>{suggestion}</button>
              ))}
            </div>
          </Field>
          <div className="calculation-tip">程序按成交记录计算：持有 {summary.holdingDays} 天，已实现盈亏 <b>{money(summary.realizedCents)}</b>{summary.returnPct === null ? "" : `（收益率 ${summary.returnPct >= 0 ? "+" : ""}${summary.returnPct.toFixed(1)}%）`}。</div>
          {message && <p className="form-message" role="alert">{message}</p>}
          <div className="modal-actions"><Button variant="ghost" onClick={onClose}>取消</Button><Button variant="primary" type="submit" disabled={saving}>{saving ? "正在保存…" : "保存复盘"}</Button></div>
        </form>
      </section>
    </div>
  );
}

function PreferencesSettings({ preferences, onSave }: { preferences: TradingPreferences | null; onSave: (next: TradingPreferences) => Promise<void> }) {
  const initial = preferences ?? DEFAULT_PREFERENCES;
  const [riskProfile, setRiskProfile] = useState<RiskProfile>(initial.riskProfile);
  const [maxLossPercent, setMaxLossPercent] = useState(String(initial.maxLossPercent));
  const [maxConcentrationPercent, setMaxConcentrationPercent] = useState(String(initial.maxConcentrationPercent));
  const [maxPositionPercent, setMaxPositionPercent] = useState(String(initial.maxPositionPercent));
  const [enforceStopLoss, setEnforceStopLoss] = useState(initial.enforceStopLoss);
  const [disciplineNote, setDisciplineNote] = useState(initial.disciplineNote);
  const [stealthMode, setStealthMode] = useState(initial.stealthMode);
  const [saving, setSaving] = useState(false);

  function applyProfile(profile: RiskProfile) {
    const preset = RISK_PRESETS[profile];
    setRiskProfile(profile);
    setMaxLossPercent(String(preset.maxLossPercent));
    setMaxConcentrationPercent(String(preset.maxConcentrationPercent));
    setMaxPositionPercent(String(preset.maxPositionPercent));
    setEnforceStopLoss(preset.enforceStopLoss);
  }

  async function save() {
    setSaving(true);
    try {
      await onSave({
        riskProfile,
        maxLossPercent: Number(maxLossPercent) || 0,
        maxConcentrationPercent: Number(maxConcentrationPercent) || 0,
        maxPositionPercent: Number(maxPositionPercent) || 0,
        enforceStopLoss,
        disciplineNote,
        stealthMode,
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="settings-card__panel">
      <SectionHeader title="风险偏好与交易纪律" subtitle="以下内容会作为硬约束，用于买卖决策与仓位建议。" />
      <div className="form-group">
        <label>风险偏好档位</label>
        <div className="segmented">
          {RISK_PROFILE_LABELS.map((profile) => (
            <button
              key={profile}
              type="button"
              className={`seg${riskProfile === profile ? " active" : ""}`}
              onClick={() => applyProfile(profile)}
            >
              {profile}
            </button>
          ))}
        </div>
        <Hint>选择档位会自动填入推荐阈值，下方数值可再手动微调。</Hint>
      </div>
      <div className="form-row">
        <div className="form-group">
          <label>单笔最大可亏（占总资产 %）</label>
          <input className="text-input" type="number" min="0.1" step="0.1" value={maxLossPercent} onChange={(e) => setMaxLossPercent(e.target.value)} />
        </div>
        <div className="form-group">
          <label>单股最大仓位（%）</label>
          <input className="text-input" type="number" min="1" step="1" value={maxConcentrationPercent} onChange={(e) => setMaxConcentrationPercent(e.target.value)} />
        </div>
        <div className="form-group">
          <label>账户最大总仓位（%）</label>
          <input className="text-input" type="number" min="1" step="1" value={maxPositionPercent} onChange={(e) => setMaxPositionPercent(e.target.value)} />
        </div>
      </div>
      <div className="form-group checkbox">
        <label>
          <input type="checkbox" checked={enforceStopLoss} onChange={(e) => setEnforceStopLoss(e.target.checked)} />
          买入必须设置止损（跌破即执行）
        </label>
      </div>
      <div className="form-group">
        <label>我的交易纪律原则</label>
        <textarea
          className="text-input"
          rows={3}
          placeholder="例如：不追高、只在买点买入、亏损超5%无条件减仓……"
          value={disciplineNote}
          onChange={(e) => setDisciplineNote(e.target.value)}
        />
      </div>
      <div className="form-group checkbox">
        <label>
          <input type="checkbox" checked={stealthMode} onChange={(e) => setStealthMode(e.target.checked)} />
          隐身模式（办公室低存在感配色）
        </label>
        <Hint>开启后界面转为中性灰暗色调，涨跌红绿降饱和，整体像普通后台系统；按 Esc 可随时一键切换。</Hint>
      </div>
      <div className="form-actions">
        <Button variant="primary" disabled={saving} onClick={() => void save()}>
          {saving ? "保存中…" : "保存"}
        </Button>
      </div>
    </div>
  );
}





