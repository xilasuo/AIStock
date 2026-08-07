"use client";

/**
 * 大屏展示页（/screen）
 *
 * 深色数据终端风格：核心指标（含今日盈亏）+ 大盘、资产走势大图、最近交易、
 * 持仓占比环图与明细、策略选股榜、板块热力图、自选行情跑马灯。
 * 只读展示，用于投屏（办公室大屏 / 电视 / 会议室）。
 *
 * 刷新节奏：
 *  - 快数据（账户 / 交易 / 行情）30 秒轮询；
 *  - 慢数据（策略扫描结果 / 板块热力图）5 分钟轮询，失败不影响主数据。
 * 复用现有 API，不改任何业务逻辑，也不额外拉取逐日 K 线。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { useRouter } from "next/navigation";
import { Star, Sparkles, Home } from "lucide-react";
import { calculatePortfolioInsights } from "../../lib/domain/portfolio-insights";
import type { CapitalFlow, Trade } from "../../lib/domain/domain";
import { formatDateTimeShanghai, shanghaiDate } from "../../lib/utils/time";
import { TickNum } from "../components/TickNum";
import { InteractiveKline } from "../components/InteractiveKline";
import { StockSearch } from "../components/ui";
import { StrategyModal } from "../components/StrategyModal";
import { searchLocalStocks } from "../../lib/domain/stocks";
import { recordQuota, useMairuiQuota } from "../../lib/market/mairui-quota";
import { resolveSectorKlineCode } from "../../lib/market/sectors";

type Quote = { price: number; changePercent: number; fetchedAt: string };
type MarketIndex = { code: string; name: string; price: number; changePercent: number; change: number };
type WatchItem = { id: number; symbol: string; name: string; note?: string | null };
type ScanPick = {
  code: string;
  name: string;
  score: number;
  sector?: string;
  rationale?: string;
  signalTime?: string;
};
type ScanBrief = {
  generatedAt?: string;
  selected?: ScanPick[];
  selectedCount?: number;
  marketState?: { state?: string; positionFactor?: number };
};
type SectorMove = { code: string; name: string; changePercent: number };
type AlertRule = { symbol: string; type: "止损" | "止盈一" | "止盈二"; targetPriceCents: number; targetPriceMillis: number | null };
/** 点击任意条目滑出的详情抽屉内容（统一结构，避免为每类建独立类型）。 */
type DetailData = {
  title: string;
  subtitle?: string;
  rows: Array<{ k: string; v: string; c?: "up" | "down" | "accent" }>;
  note?: string;
};

const PIE_COLORS = ["#ff4d6d", "#00e5ff", "#b98cff", "#21e6a4", "#ffc24d", "#5cc8ff", "#ff8a7a", "#34d399"];
const UP = "var(--up)";
const DOWN = "var(--down)";
const BG = "var(--bg)";
const CARD = "var(--surface)";
const BORDER = "var(--border)";
const TEXT = "var(--text)";
const MUTED = "var(--muted)";
const BRIGHT = "var(--accent)";
const ACCENT = "var(--accent)";
const CHART = "var(--up)";
const RING_R = 9;

/**
 * 大屏头部实时时钟（独立隔离组件）。
 * 自管理每秒 tick 的 now state，使父级整页（行情/持仓/图表）不再因时钟每秒重渲染。
 * 仅负责头部时间文案、交易时段标签、实时连接状态与刷新倒计时环；
 * 与父级实时窗口门控（loadData 的轮询调度）完全解耦，不影响数据加载逻辑。
 */
function RealtimeClock({ refreshMs, lastLoadAt }: { refreshMs: number; lastLoadAt: number | null }) {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    const initial = window.setTimeout(() => setNow(new Date()), 0);
    const timer = window.setInterval(() => setNow(new Date()), 1_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, []);

  const sessionLabel = useMemo(() => {
    if (!now) return "";
    const { h, m, day } = shanghaiParts(now);
    if (day === 0 || day === 6) return "周末休市";
    const t = h * 60 + m;
    if (t < 9 * 60 + 30) return "盘前";
    if (t <= 11 * 60 + 30) return "开盘中";
    if (t < 13 * 60) return "午间休市";
    if (t <= 15 * 60) return "开盘中";
    return "已收盘";
  }, [now]);

  const live = useMemo(() => (now ? isRealtimeWindow(now) : false), [now]);
  const timeText = now ? formatDateTimeShanghai(now) : "——:——:——";
  const countdown = useMemo(() => {
    if (!now || lastLoadAt == null) return Math.ceil(refreshMs / 1000);
    const elapsed = Math.floor((now.getTime() - lastLoadAt) / 1000);
    return Math.max(0, Math.ceil(refreshMs / 1000) - elapsed);
  }, [now, refreshMs, lastLoadAt]);
  const ringProgress = refreshMs > 0 ? countdown / (refreshMs / 1000) : 0;
  const ringCircumference = 2 * Math.PI * RING_R;

  return (
    <>
      <span>{timeText}</span>
      <span
        style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
        title={live ? "实时更新中（北京时间工作日 09:00–16:00）" : "非交易时段已锁定：仅在北京时间工作日 09:00–16:00 实时刷新（周末除外）"}
      >
        {live ? (
          <>
            <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden>
              <circle cx="11" cy="11" r={RING_R} fill="none" stroke="rgba(34,211,238,.16)" strokeWidth="2.5" />
              <circle
                cx="11"
                cy="11"
                r={RING_R}
                fill="none"
                stroke={ACCENT}
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeDasharray={ringCircumference}
                strokeDashoffset={ringCircumference * (1 - ringProgress)}
                transform="rotate(-90 11 11)"
              />
              <text x="11" y="14.5" textAnchor="middle" fontSize="8" fill={MUTED} fontFamily="var(--font-mono)">
                {countdown}
              </text>
            </svg>
            实时连接
          </>
        ) : (
          <>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: MUTED, display: "inline-block" }} />
            已锁定 · 非实时时段
          </>
        )}
      </span>
      <span style={{ color: sessionLabel === "开盘中" ? ACCENT : MUTED, fontSize: 12 }}>{sessionLabel}</span>
    </>
  );
}

const MARKET_STATE_LABEL: Record<string, string> = {
  bull: "多头",
  neutral: "震荡",
  bear: "空头",
  unknown: "未知",
};

function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  return fetch(url, {
    headers: { "content-type": "application/json" },
    ...init,
  }).then(async (res) => {
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error((body as { error?: string })?.error ?? `请求失败(${res.status})`);
    }
    return res.json() as Promise<T>;
  });
}

function money(cents: number): string {
  return `¥${(cents / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function signedMoney(cents: number): string {
  return `${cents >= 0 ? "+" : "-"}${money(Math.abs(cents))}`;
}

/** 把某持仓在 /api/alerts 里的止损/止盈价换算成展示串；未按该 symbol+type 设定时回退「未设定」。 */
function formatAlertPrice(alerts: AlertRule[], symbol: string, type: AlertRule["type"]): string {
  const a = alerts.find((al) => al.symbol === symbol && al.type === type);
  if (!a) return "未设定";
  const yuan = a.targetPriceMillis != null ? a.targetPriceMillis / 1000 : a.targetPriceCents / 100;
  return `¥${yuan.toFixed(a.targetPriceMillis != null ? 3 : 2)}`;
}

function pct(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

/**
 * 数字滚动：目标值变化时用 rAF 从旧值缓动到新值（大屏「活着」的观感）。
 * 首帧返回目标值本身，保证 SSR/水合文本一致；用户开启「减弱动效」时直接跳变。
 */
function useCountUp(target: number | null, duration = 700): number | null {
  const [display, setDisplay] = useState<number | null>(target);
  const fromRef = useRef<number>(target ?? 0);
  useEffect(() => {
    if (target === null) {
      const id = window.setTimeout(() => setDisplay(null), 0);
      return () => window.clearTimeout(id);
    }
    const from = fromRef.current;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (reduced || from === target || !Number.isFinite(from)) {
      fromRef.current = target;
      const id = window.setTimeout(() => setDisplay(target), 0);
      return () => window.clearTimeout(id);
    }
    let raf = 0;
    const start = performance.now();
    const tick = (stamp: number) => {
      const progress = Math.min((stamp - start) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(from + (target - from) * eased);
      if (progress < 1) {
        raf = requestAnimationFrame(tick);
      } else {
        fromRef.current = target;
      }
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      fromRef.current = target;
    };
  }, [target, duration]);
  return display;
}

function Rolling({
  value,
  format,
  fallback = "—",
}: {
  value: number | null;
  format: (value: number) => string;
  fallback?: string;
}) {
  const animated = useCountUp(value);
  if (animated === null) return <>{fallback}</>;
  return <>{format(animated)}</>;
}

type SeriesPoint = { date: string; value: number };

/**
 * 账户净值估算曲线：按交易/入金日期分段，持仓市值用「最新现价」近似，
 * 形状反映每一次买入/卖出/出入金对资产的跳变（不含逐日收盘价，展示够用）。
 */
function buildApproxSeries(
  trades: Trade[],
  prices: Record<string, number>,
  initialCapitalCents: number | null,
  capitalFlows: CapitalFlow[] = [],
): SeriesPoint[] {
  if (!trades.length || initialCapitalCents === null) return [];
  const orderedFlows = [...capitalFlows].sort((a, b) => a.flowDate.localeCompare(b.flowDate));
  const orderedTrades = [...trades].sort((a, b) => a.tradeDate.localeCompare(b.tradeDate) || a.id - b.id);
  const start =
    orderedFlows.length && orderedFlows[0].flowDate < orderedTrades[0].tradeDate
      ? orderedFlows[0].flowDate
      : orderedTrades[0].tradeDate;
  const dates = [
    ...new Set([start, ...orderedTrades.map((t) => t.tradeDate), ...orderedFlows.map((f) => f.flowDate)]),
  ].sort();
  let cash = initialCapitalCents;
  let flowIndex = 0;
  let tradeIndex = 0;
  const quantity = new Map<string, number>();
  const points: SeriesPoint[] = [];
  for (const date of dates) {
    while (flowIndex < orderedFlows.length && orderedFlows[flowIndex].flowDate <= date) {
      cash += orderedFlows[flowIndex].amountCents;
      flowIndex += 1;
    }
    while (tradeIndex < orderedTrades.length && orderedTrades[tradeIndex].tradeDate <= date) {
      const trade = orderedTrades[tradeIndex];
      const dir = trade.side === "买入" ? 1 : -1;
      quantity.set(trade.symbol, Math.max(0, (quantity.get(trade.symbol) ?? 0) + dir * trade.quantity));
      const tenThousandths = trade.priceTenThousandths ?? (trade.priceMillis ?? trade.priceCents * 10) * 10;
      const amountCents = Math.round((tenThousandths * trade.quantity) / 100);
      cash += trade.side === "买入" ? -amountCents - trade.feeCents : amountCents - trade.feeCents;
      tradeIndex += 1;
    }
    const marketValue = [...quantity.entries()].reduce(
      (sum, [symbol, qty]) => sum + Math.round((prices[symbol] ?? 0) * 100 * qty),
      0,
    );
    points.push({ date, value: cash + marketValue });
  }
  return points;
}

function toPath(points: Array<{ x: number; y: number }>): string {
  return points.map((p, index) => `${index === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
}

/** Catmull-Rom 转 Bézier 平滑曲线：消除折线拐角，视觉更顺滑（hover 仍用原始 chart.pts）。 */
function smoothPath(points: Array<{ x: number; y: number }>): string {
  if (points.length < 2) return "";
  if (points.length === 2) return toPath(points);
  let d = `M${points[0].x.toFixed(1)},${points[0].y.toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
  }
  return d;
}

/** 板块色块底色：红涨绿跌，涨跌幅越大颜色越浓（±3% 到顶）。 */
function heatColor(changePercent: number): string {
  const intensity = Math.min(Math.abs(changePercent) / 3, 1);
  const alpha = 0.12 + intensity * 0.5;
  return changePercent >= 0 ? `rgba(255,107,107,${alpha.toFixed(2)})` : `rgba(45,212,191,${alpha.toFixed(2)})`;
}

/** 取最近 N 个自然日（含今天），用于板块热力图在非交易日自动回退。 */
function recentDates(count: number): string[] {
  const today = new Date();
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(today);
    date.setDate(date.getDate() - index);
    return shanghaiDate(date);
  });
}

/** 取上海墙钟的 时/分/秒/星期，统一用 Intl(timeZone=Asia/Shanghai)，不依赖容器时区。 */
function shanghaiParts(date: Date): { h: number; m: number; s: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hour12: false,
  }).formatToParts(date);
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? "0";
  const dayMap: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 0 };
  return {
    h: parseInt(get("hour"), 10) || 0,
    m: parseInt(get("minute"), 10) || 0,
    s: parseInt(get("second"), 10) || 0,
    day: dayMap[get("weekday")] ?? 0,
  };
}

const TRADING_OPEN_MS = 30_000;
const TRADING_CLOSED_MS = 300_000;
/** 盘中 30s 轮询，收盘/午休/周末降到 5 分钟，省请求。 */
function marketRefreshMs(date: Date): number {
  const { h, m, day } = shanghaiParts(date);
  if (day === 0 || day === 6) return TRADING_CLOSED_MS;
  const t = h * 60 + m;
  const inSession = (t >= 9 * 60 + 30 && t <= 11 * 60 + 30) || (t >= 13 * 60 && t <= 15 * 60);
  return inSession ? TRADING_OPEN_MS : TRADING_CLOSED_MS;
}

/** 实时更新窗口：北京时间（UTC+8）工作日 09:00（含）至 16:00（不含），周末（周六/周日）排除。判断一律用 Asia/Shanghai，与服务器本地时区无关。 */
const REALTIME_START_MIN = 9 * 60;
const REALTIME_END_MIN = 16 * 60;
function isRealtimeWindow(date: Date = new Date()): boolean {
  const { h, m, day } = shanghaiParts(date);
  if (day === 0 || day === 6) return false; // 周六/周日排除
  const t = h * 60 + m;
  return t >= REALTIME_START_MIN && t < REALTIME_END_MIN;
}

/** 距下一个实时窗口边界（工作日 09:00 或 16:00）的毫秒数，用于定时启停。精确到秒；周末直接跳过，落到下个工作日 09:00。 */
function msUntilNextBoundary(date: Date = new Date()): number {
  const { h, m, s } = shanghaiParts(date);
  const curSec = (h * 60 + m) * 60 + s; // 相对今天 00:00 的秒数
  for (let offset = 0; offset < 8; offset++) {
    const d = new Date(date.getTime() + offset * 86_400_000);
    const p = shanghaiParts(d);
    if (p.day === 0 || p.day === 6) continue; // 跳过周六/周日
    for (const b of [REALTIME_START_MIN * 60, REALTIME_END_MIN * 60]) {
      const bSec = offset * 86_400 + b; // 转成相对今天 00:00 的绝对秒数
      if (bSec > curSec) return (bSec - curSec) * 1000;
    }
  }
  return 24 * 3600 * 1000; // 兜底
}

export function BigScreenView() {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [watchlist, setWatchlist] = useState<WatchItem[]>([]);
  const [initialCapitalCents, setInitialCapitalCents] = useState<number | null>(null);
  const [capitalFlows, setCapitalFlows] = useState<CapitalFlow[]>([]);
  const [indices, setIndices] = useState<MarketIndex[]>([]);
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const [scan, setScan] = useState<ScanBrief | null>(null);
  const [sectors, setSectors] = useState<{ date: string; items: SectorMove[] } | null>(null);
  const [error, setError] = useState("");
  const [refreshMs, setRefreshMs] = useState<number>(TRADING_OPEN_MS);
  const [lastLoadAt, setLastLoadAt] = useState<number | null>(null);
  const { quota, reset: resetQuotaCounter } = useMairuiQuota();
  const quotaRef = useRef(quota);
  quotaRef.current = quota;
  const [quotaPanelOpen, setQuotaPanelOpen] = useState(false);
  const [hover, setHover] = useState<{ data: DetailData; pos: { left: number; top: number }; side: "right" | "left" } | null>(null);
  const [curveIdx, setCurveIdx] = useState<number | null>(null);
  const [alerts, setAlerts] = useState<AlertRule[]>([]);
  const [aiOpen, setAiOpen] = useState(false);
  const router = useRouter();
  // 隐身模式（老板键）：与 Dashboard 共用偏好，亮屏/暗屏一键切换
  const [stealth, setStealth] = useState(false);
  const prefsRef = useRef<Record<string, unknown> | null>(null);
  // 交易偏好（含 maxLossPercent/maxConcentrationPercent 等），用于风险预警按用户设置判断。
  const [prefs, setPrefs] = useState<{ maxLossPercent?: number; maxConcentrationPercent?: number; maxPositionPercent?: number; enforceStopLoss?: boolean; stealthMode?: boolean } | null>(null);

  // 客户端挂载门控：BigScreenView 含实时时钟/行情/持仓等大量随渲染时刻变化的文本，
  // SSR 阶段（服务器时刻）与客户端水合（浏览器时刻）极易产生文本不一致，
  // 触发 React #418 hydration mismatch。用 mounted 门控后首屏（SSR 与 CSR）统一渲染稳定骨架，
  // 挂载完成后再在客户端渲染真实内容，彻底消除 hydration 不匹配。
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // 大屏中央主图：交互式 K 线选中股票（前端拉取本地渲染，支持缩放/平移/周期切换）
  // 默认进入大屏直接展示上证指数（000001）K 线，而非资产收益曲线。
  const [klinePick, setKlinePick] = useState<{ code: string; name: string }>({ code: "000001", name: "上证指数" });
  // 是否临时切换显示资产收益曲线（默认 false：显示 K 线主图）。
  const [showAssetCurve, setShowAssetCurve] = useState(false);
  const openKline = (code: string, name: string) => {
    setKlinePick((prev) => (prev?.code === code ? prev : { code, name }));
  };
  const isActiveKlineCode = (code: string) => klinePick?.code === code;

  const loadData = useCallback(async () => {
    setLastLoadAt(Date.now());
    setRefreshMs(marketRefreshMs(new Date()));
    try {
      const [tradeData, watchData, accountData, indexData, alertData] = await Promise.all([
        jsonRequest<{ trades: Trade[] }>("/api/trades"),
        jsonRequest<{ items: WatchItem[] }>("/api/watchlist"),
        jsonRequest<{ initialCapitalCents: number | null; capitalFlows: CapitalFlow[] }>("/api/account"),
        jsonRequest<{ indices: MarketIndex[] }>("/api/indices"),
        jsonRequest<{ alerts: AlertRule[] }>("/api/alerts"),
      ]);
      setTrades(tradeData.trades);
      setWatchlist(watchData.items);
      setInitialCapitalCents(accountData.initialCapitalCents);
      setCapitalFlows(accountData.capitalFlows ?? []);
      setIndices(indexData.indices ?? []);
      setAlerts(alertData.alerts ?? []);
      const symbols = [
        ...new Set([
          ...tradeData.trades.map((t) => t.symbol),
          ...watchData.items.map((i) => i.symbol),
        ]),
      ];
      if (symbols.length) {
        const quoteData = await jsonRequest<{ quotes?: Record<string, Quote> }>("/api/quote", {
          method: "POST",
          body: JSON.stringify({ symbols }),
        });
        if (quoteData.quotes) setQuotes(quoteData.quotes);
      }
      setError("");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "数据读取失败");
    }
  }, []);

  const watched = useMemo(
    () => watchlist.some((w) => w.symbol === klinePick?.code),
    [watchlist, klinePick?.code],
  );
  const toggleWatchlist = useCallback(async () => {
    if (!klinePick) return;
    try {
      const existing = watchlist.find((w) => w.symbol === klinePick.code);
      if (existing) {
        // 取消关注：服务端 DELETE 从 query 读取 symbol
        await jsonRequest(`/api/watchlist?symbol=${encodeURIComponent(existing.symbol)}`, { method: "DELETE" });
      } else {
        await jsonRequest("/api/watchlist", {
          method: "POST",
          body: JSON.stringify({ symbol: klinePick.code, name: klinePick.name }),
        });
      }
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "关注操作失败");
    }
  }, [klinePick, watchlist, loadData]);

  /** 慢数据：策略选股榜 + 板块热力图。单项失败静默跳过，不影响主看板。 */
  const loadSlowData = useCallback(async () => {
    void jsonRequest<{ ok?: boolean; scan?: ScanBrief | null }>("/api/strategy-scan")
      .then((res) => {
        if (res?.scan) setScan(res.scan);
      })
      .catch(() => undefined);

    // 交易时间内请求实时模式(live=1)：优先东方财富实时板块榜，盘中真正跳动。
    // 窗口外走最近 4 个自然日回退，取首个有数据的交易日展示历史板块表现。
    if (isRealtimeWindow()) {
      try {
        const data = await jsonRequest<{ date: string; sectors: SectorMove[] }>(
          `/api/sector-heatmap?date=${shanghaiDate()}&limit=32&live=1`,
        );
        if (data.sectors?.length) {
          setSectors({ date: data.date, items: data.sectors });
          return;
        }
      } catch {
        // 实时源暂不可用：继续走下面的历史回退兜底
      }
    }
    for (const date of recentDates(4)) {
      try {
        const data = await jsonRequest<{ date: string; sectors: SectorMove[] }>(
          `/api/sector-heatmap?date=${date}&limit=32`,
        );
        if (data.sectors?.length) {
          setSectors({ date: data.date, items: data.sectors });
          return;
        }
      } catch {
        // 非交易日或数据源暂不可用：继续尝试前一天
      }
    }
  }, []);

  /**
   * 实时数据加载编排（窗口门控）：
   * - 进入页面无条件先加载一次（满足"第一次进入加载了数据"）。
   * - 仅在北京时间 09:00–16:00 内启动周期轮询；窗口外加载一次后彻底停止，不再发任何请求。
   * - 定时启停：在下一个边界（09:00 / 16:00）自动切换实时状态，页面长开也能正确启停。
   * 判断一律基于 Asia/Shanghai，与服务器/容器本地时区无关。
   */
  useEffect(() => {
    let cancelled = false;
    let dataTimer: number | null = null;
    let slowTimer: number | null = null;
    let boundaryTimer: number | null = null;

    const clearDataTimer = () => {
      if (dataTimer != null) {
        window.clearTimeout(dataTimer);
        dataTimer = null;
      }
    };
    const clearSlowTimer = () => {
      if (slowTimer != null) {
        window.clearTimeout(slowTimer);
        slowTimer = null;
      }
    };

    const startDataPolling = () => {
      clearDataTimer();
      const tick = () => {
        if (cancelled) return;
        // 麦蕊每日额度硬上限：暂停主动刷新（由边界定时器/手动恢复重新评估）。
        if (quotaRef.current.suspended) {
          clearDataTimer();
          return;
        }
        void loadData().finally(() => {
          if (cancelled) return;
          if (!isRealtimeWindow()) {
            clearDataTimer(); // 窗口外立即停止，禁止任何刷新
            return;
          }
          recordQuota(1); // 大屏每轮数据拉取记 1 个批次（粗估，用于额度降级保护）
          const next = document.hidden ? 15_000 : marketRefreshMs(new Date());
          dataTimer = window.setTimeout(tick, next);
        });
      };
      tick();
    };

    const startSlowPolling = () => {
      clearSlowTimer();
      const tick = () => {
        if (cancelled) return;
        void loadSlowData().finally(() => {
          if (cancelled) return;
          if (!isRealtimeWindow()) {
            clearSlowTimer();
            return;
          }
          slowTimer = window.setTimeout(tick, 300_000);
        });
      };
      tick();
    };

    // 首次进入：无论是否窗口内都加载一次。
    // 窗口外用 queueMicrotask 延迟到 effect 提交后执行，避免 effect 内同步 setState 级联渲染（react-hooks/set-state-in-effect）。
    if (isRealtimeWindow()) {
      startDataPolling();
      startSlowPolling();
    } else {
      queueMicrotask(() => {
        if (cancelled) return;
        void loadData();
        void loadSlowData();
      });
    }

    // 定时启停：到达下一个边界自动按当前窗口状态开/关
    const scheduleBoundary = () => {
      boundaryTimer = window.setTimeout(() => {
        if (cancelled) return;
        if (isRealtimeWindow()) {
          startDataPolling();
          startSlowPolling();
        } else {
          clearDataTimer();
          clearSlowTimer();
        }
        scheduleBoundary();
      }, msUntilNextBoundary());
    };
    scheduleBoundary();

    return () => {
      cancelled = true;
      clearDataTimer();
      clearSlowTimer();
      if (boundaryTimer != null) window.clearTimeout(boundaryTimer);
    };
  }, [loadData, loadSlowData]);

  // 挂载时同步隐身偏好（与 Dashboard 共用 <html>.stealth），保证跨页一致
  useEffect(() => {
    let cancelled = false;
    jsonRequest<Record<string, unknown>>("/api/preferences")
      .then((prefs) => {
        if (cancelled) return;
        prefsRef.current = prefs;
        setPrefs({
          maxLossPercent: typeof prefs.maxLossPercent === "number" ? prefs.maxLossPercent : undefined,
          maxConcentrationPercent: typeof prefs.maxConcentrationPercent === "number" ? prefs.maxConcentrationPercent : undefined,
          maxPositionPercent: typeof prefs.maxPositionPercent === "number" ? prefs.maxPositionPercent : undefined,
          enforceStopLoss: typeof prefs.enforceStopLoss === "boolean" ? prefs.enforceStopLoss : undefined,
          stealthMode: !!prefs.stealthMode,
        });
        const on = !!prefs.stealthMode;
        setStealth(on);
        document.documentElement.classList.toggle("stealth", on);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // 切换隐身模式：更新 class + 整对象回写偏好（PUT 须传全量，否则默认值会覆盖其他项）
  const toggleStealth = useCallback(() => {
    const base = prefsRef.current ?? {};
    const next = { ...base, stealthMode: !stealth } as Record<string, unknown>;
    prefsRef.current = next;
    setStealth(!stealth);
    document.documentElement.classList.toggle("stealth", !stealth);
    void fetch("/api/preferences", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(next),
    }).catch(() => undefined);
  }, [stealth]);

  // 划入气泡浮窗：在锚点旁即时展示明细，替代点击抽屉（不阻断大屏浏览）
  const showTooltip = (e: MouseEvent<HTMLElement>, data: DetailData) => {
    const r = e.currentTarget.getBoundingClientRect();
    const POP_W = 264;
    const estH = 92 + data.rows.length * 30 + (data.note ? 46 : 0);
    let side: "right" | "left" = "right";
    let left = r.right + 12;
    if (left + POP_W > window.innerWidth - 12) {
      left = Math.max(12, r.left - POP_W - 12);
      side = "left";
    }
    let top = r.top;
    if (top + estH > window.innerHeight - 12) top = Math.max(12, window.innerHeight - 12 - estH);
    setHover({ data, pos: { left, top }, side });
  };

  // 资产走势曲线悬停：按鼠标 x 吸附最近节点，弹出跟随式浮层 + 游标
  const handleCurveMove = (e: MouseEvent<SVGSVGElement>) => {
    if (!chart) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const vx = ((e.clientX - rect.left) / rect.width) * CHART_W;
    let idx = 0;
    let best = Infinity;
    for (let i = 0; i < chart.pts.length; i++) {
      const d = Math.abs(chart.pts[i].x - vx);
      if (d < best) {
        best = d;
        idx = i;
      }
    }
    setCurveIdx(idx);
    const node = chart.recent[idx];
    const delta = node.value - chart.first;
    const data: DetailData = {
      title: node.date,
      subtitle: "账户净值估算",
      rows: [
        { k: "净值", v: money(node.value), c: "accent" },
        { k: "较首点", v: signedMoney(delta), c: delta >= 0 ? "up" : "down" },
        { k: "区间最高", v: money(chart.max), c: "accent" },
        { k: "区间最低", v: money(chart.min), c: "accent" },
      ],
    };
    const POP_W = 264;
    let left = e.clientX + 14;
    let side: "right" | "left" = "right";
    if (left + POP_W > window.innerWidth - 12) {
      left = e.clientX - POP_W - 14;
      side = "left";
    }
    let top = e.clientY + 14;
    const estH = 92 + data.rows.length * 30;
    if (top + estH > window.innerHeight - 12) top = Math.max(12, window.innerHeight - 12 - estH);
    setHover({ data, pos: { left, top }, side });
  };

  const handleCurveLeave = () => {
    setCurveIdx(null);
    setHover(null);
  };

  // Esc：优先关浮层/面板；无浮层时作为老板键切换隐身模式
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (hover || aiOpen) {
        setHover(null);
        setAiOpen(false);
        return;
      }
      e.preventDefault();
      toggleStealth();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hover, aiOpen, toggleStealth]);

  const prices = useMemo(
    () => Object.fromEntries(Object.entries(quotes).map(([symbol, q]) => [symbol, q.price])),
    [quotes],
  );
  const insights = useMemo(
    () => calculatePortfolioInsights(trades, prices, {}, initialCapitalCents, capitalFlows),
    [trades, prices, initialCapitalCents, capitalFlows],
  );
  const series = useMemo(
    () => buildApproxSeries(trades, prices, initialCapitalCents, capitalFlows),
    [trades, prices, initialCapitalCents, capitalFlows],
  );

  // 资产走势图几何（近 60 个交易点 + 最新）
  const CHART_W = 640;
  const CHART_H = 210;
  const CHART_PAD = 14;
  const chart = useMemo(() => {
    if (series.length < 2) return null;
    const recent = series.slice(-60);
    const values = recent.map((p) => p.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    const innerW = CHART_W - CHART_PAD * 2;
    const innerH = CHART_H - CHART_PAD * 2;
    const pts = recent.map((p, index) => ({
      x: CHART_PAD + (index / (recent.length - 1)) * innerW,
      y: CHART_PAD + (1 - (p.value - min) / range) * innerH,
    }));
    const line = toPath(pts);
    const smoothLine = smoothPath(pts);
    const area = `${line} L${pts[pts.length - 1].x.toFixed(1)},${CHART_H} L${pts[0].x.toFixed(1)},${CHART_H} Z`;
    const smoothArea = `${smoothLine} L${pts[pts.length - 1].x.toFixed(1)},${CHART_H} L${pts[0].x.toFixed(1)},${CHART_H} Z`;
    return { pts, line, smoothLine, area, smoothArea, min, max, latest: recent[recent.length - 1].value, first: recent[0].value, recent };
  }, [series]);

  const positions = insights.positions.filter((p) => p.marketValueCents > 0);
  const totalMarketValue = positions.reduce((sum, p) => sum + p.marketValueCents, 0);
  const donutCircumference = 2 * Math.PI * 32;
  // 环图分段：按市值占比切弧，start 为累计起点（占周长比例）
  const donutSegments = useMemo(() => {
    if (!positions.length) return [];
    const total = totalMarketValue || 1;
    let cursor = 0;
    return positions.map((pos, index) => {
      const seg = {
        key: pos.symbol,
        frac: pos.marketValueCents / total,
        color: PIE_COLORS[index % PIE_COLORS.length],
        start: cursor,
      };
      cursor += seg.frac;
      return seg;
    });
  }, [positions, totalMarketValue]);

  /**
   * 今日盈亏：用各持仓「今日涨跌幅」反推昨收市值，差额即为当日浮动盈亏。
   * 只用已有 quote 数据，不额外请求；无行情的持仓自动跳过。
   */
  const todayPnl = useMemo(() => {
    let gainCents = 0;
    let prevValueCents = 0;
    let covered = 0;
    for (const pos of positions) {
      const quote = quotes[pos.symbol];
      if (!quote || !Number.isFinite(quote.changePercent)) continue;
      const ratio = 1 + quote.changePercent / 100;
      if (ratio <= 0.01) continue;
      const prev = pos.marketValueCents / ratio;
      gainCents += pos.marketValueCents - prev;
      prevValueCents += prev;
      covered += 1;
    }
    if (!covered) return null;
    return {
      gainCents: Math.round(gainCents),
      percent: prevValueCents > 0 ? (gainCents / prevValueCents) * 100 : 0,
      covered,
    };
  }, [positions, quotes]);

  // 持仓明细按「今日涨跌」排序，最强/最弱一眼可见
  const positionsByToday = useMemo(() => {
    return [...positions].sort((a, b) => {
      const ca = quotes[a.symbol]?.changePercent ?? -999;
      const cb = quotes[b.symbol]?.changePercent ?? -999;
      return cb - ca;
    });
  }, [positions, quotes]);

  /** 风险预警：只从已有持仓/行情/账户指标派生，零额外请求。 */
  type RiskAlert = { level: "high" | "warn"; label: string; detail: string };
  const riskAlerts = useMemo<RiskAlert[]>(() => {
    const alerts: RiskAlert[] = [];
    // 用户设置的风险参数（来自 /api/preferences）
    const maxLossPct = prefs?.maxLossPercent ?? 3; // 买入价亏损止损线 %
    const maxConcPct = prefs?.maxConcentrationPercent ?? 30; // 单股仓位上限 %
    const maxPosPct = prefs?.maxPositionPercent ?? 70; // 总仓位上限 %
    const takeProfitPct = 8; // 止盈参考线（盈利达 8% 提示止盈）

    // 1) 止损 / 逼近止损：买入后亏损达 maxLossPct% → 清仓离场
    for (const p of positions) {
      const ret = p.returnPercent;
      if (ret != null && ret <= -maxLossPct + 1) {
        const triggered = ret <= -maxLossPct; // 达止损线
        const severe = Math.abs(ret) >= maxLossPct + 2; // 超 2pp
        alerts.push({
          level: severe ? "high" : triggered ? "high" : "warn",
          label: severe ? "止损" : triggered ? "止损" : "逼近止损",
          detail: `${p.name} 已亏 ${pct(ret)}，止损线 -${maxLossPct}%，${prefs?.enforceStopLoss ? "立即清仓离场" : "考虑清仓离场"}`,
        });
      }
    }

    // 2) 止盈：盈利达 takeProfitPct% → 考虑减仓锁定利润
    for (const p of positions) {
      const ret = p.returnPercent;
      if (ret != null && ret >= takeProfitPct) {
        alerts.push({
          level: "warn",
          label: "止盈",
          detail: `${p.name} 已赚 ${pct(ret)}，考虑减仓锁定利润`,
        });
      }
    }

    // 3) 减仓：单股仓位超 maxConcPct% → 考虑减仓分散
    for (const p of positions) {
      if (p.allocationPercent != null && p.allocationPercent >= maxConcPct) {
        const severe = p.allocationPercent >= maxConcPct + 10;
        alerts.push({
          level: severe ? "high" : "warn",
          label: "减仓",
          detail: `${p.name} 占 ${p.allocationPercent.toFixed(0)}%，超上限 ${maxConcPct}%，考虑减仓分散`,
        });
      }
    }

    // 4) 加仓：盈利中、仓位未超限、总仓位有空间 → 机会信号
    const totalPos = insights.totalPositionPercent ?? 0;
    for (const p of positions) {
      const ret = p.returnPercent;
      const alloc = p.allocationPercent ?? 0;
      if (
        ret != null && ret > 0 && ret < takeProfitPct && // 盈利但未到止盈
        alloc < maxConcPct && // 单股未超限
        totalPos < maxPosPct // 总仓位有空间
      ) {
        alerts.push({
          level: "warn",
          label: "加仓",
          detail: `${p.name} 盈 ${pct(ret)}、仓位 ${alloc.toFixed(0)}%，趋势良好可考虑加仓`,
        });
      }
    }

    // 5) 开新仓：总仓位 < maxPosPct% 且 现金充足 → 机会信号
    const total = insights.totalAssetsCents ?? 0;
    const cash = insights.cashCents ?? 0;
    if (totalPos < maxPosPct && total > 0 && cash / total >= 0.1) {
      alerts.push({
        level: "warn",
        label: "开新仓",
        detail: `总仓位 ${totalPos.toFixed(0)}%（上限 ${maxPosPct}%），现金 ${(cash / total * 100).toFixed(0)}%，可开新仓`,
      });
    }

    // 6) 补充：今日大跌（关注是否触发止损）
    for (const p of positions) {
      const cp = quotes[p.symbol]?.changePercent;
      if (cp != null && cp <= -5) {
        alerts.push({ level: cp <= -8 ? "high" : "warn", label: "今日大跌", detail: `${p.name} ${pct(cp)}，关注是否触发止损` });
      }
    }

    // 7) 补充：账户浮亏
    if ((insights.totalProfitCents ?? 0) < 0) {
      alerts.push({ level: "warn", label: "账户浮亏", detail: `整体 ${pct(insights.totalProfitPercent)}，检视持仓止损纪律` });
    }
    return alerts.slice(0, 8);
  }, [positions, quotes, insights, prefs]);

  // 跑马灯：自选 + 持仓行情串联，复制一份实现无缝滚动
  const marqueeSymbols = useMemo(() => {
    const seen = new Set<string>();
    const items: Array<{ symbol: string; name: string; quote?: Quote }> = [];
    for (const item of [...watchlist, ...positions.map((p) => ({ symbol: p.symbol, name: p.name }))]) {
      if (seen.has(item.symbol)) continue;
      seen.add(item.symbol);
      items.push({ ...item, quote: quotes[item.symbol] });
    }
    return items;
  }, [watchlist, positions, quotes]);

  // 最近交易：按日期倒序取前 4 条
  const recentTrades = useMemo(
    () => [...trades].sort((a, b) => b.tradeDate.localeCompare(a.tradeDate) || b.id - a.id).slice(0, 4),
    [trades],
  );

  const scanPicks = (scan?.selected ?? []).slice(0, 8);
  const marketStateKey = scan?.marketState?.state ?? "";
  const marketStateLabel = MARKET_STATE_LABEL[marketStateKey] ?? (marketStateKey || "—");
  const marketStateColor =
    marketStateKey === "bull" ? UP : marketStateKey === "bear" ? DOWN : MUTED;

  const activeIndices = indices.slice(0, 9);
  const profitColor = (insights.totalProfitCents ?? 0) >= 0 ? UP : DOWN;
  const todayColor = (todayPnl?.gainCents ?? 0) >= 0 ? UP : DOWN;

  /**
   * 选中查看某只股票 K 线：被 持仓明细 / 策略选股榜 / 最近交易 点击触发。
   * 把大屏中央的"资产走势"主图换成该股的交互式 K 线（前端拉取数据本地渲染，
   * 支持滚轮缩放 / 拖拽平移 / 日周月周期切换）。重选其它股票时切换 code。
   */
  const [strategyPick, setStrategyPick] = useState<{ code: string; name: string } | null>(null);

  /**
   * 大屏股票搜索：支持代码 / 名称 / 拼音首字母，选中后直接打开该股交互式 K 线。
   */
  const [searchQuery, setSearchQuery] = useState("");
  const searchSuggestions = useMemo(() => {
    const q = searchQuery.trim();
    if (!q) return [];
    const items = searchLocalStocks(q, 10).map((s) => ({ symbol: s.code, name: s.name }));
    return items.length ? [{ label: "全市场", items }] : [];
  }, [searchQuery]);
  const handleSearchSubmit = (q: string) => {
    const pick = searchLocalStocks(q, 1)[0];
    if (pick) openKline(pick.code, pick.name);
  };
  const handleSearchSelect = (symbol: string) => {
    const pick = searchLocalStocks(symbol, 1)[0] ?? { code: symbol, name: symbol };
    openKline(pick.code, pick.name);
  };

  /**
   * AI 智能解读（规则版，零 LLM 成本，永远可用）：用与大屏同源的持仓/盈亏/风险/大盘/选股数据，
   * 生成大白话播报。这是 AI 助手在大屏上的角色——被动解读层，而非聊天框。
   */
  const aiBriefing = useMemo(() => {
    const blocks: Array<{ heading: string; lines: string[] }> = [];
    const total = insights.totalAssetsCents ?? 0;
    const overview: string[] = [`当前总资产 ${money(total)}。`];
    if (todayPnl) {
      overview.push(`今日浮动盈亏 ${signedMoney(todayPnl.gainCents)}（${pct(todayPnl.percent)}），覆盖 ${todayPnl.covered} 只持仓。`);
    }
    if (insights.totalProfitCents != null) {
      overview.push(`账户累计${insights.totalProfitCents >= 0 ? "盈利" : "亏损"} ${signedMoney(insights.totalProfitCents)}（${pct(insights.totalProfitPercent)}）。`);
    }
    blocks.push({ heading: "今日概览", lines: overview });

    if (positions.length) {
      const sorted = [...positions].sort(
        (a, b) => (quotes[b.symbol]?.changePercent ?? -999) - (quotes[a.symbol]?.changePercent ?? -999),
      );
      const top = sorted[0];
      const bottom = sorted[sorted.length - 1];
      const lines = [`持有 ${positions.length} 只，仓位 ${insights.totalPositionPercent?.toFixed(1)}%。`];
      lines.push(`今日最强：${top.name} ${pct(quotes[top.symbol]?.changePercent ?? null)}。`);
      lines.push(`今日最弱：${bottom.name} ${pct(quotes[bottom.symbol]?.changePercent ?? null)}。`);
      let maxAlloc = 0;
      let maxName = "";
      for (const p of positions) {
        if ((p.allocationPercent ?? 0) > maxAlloc) {
          maxAlloc = p.allocationPercent ?? 0;
          maxName = p.name;
        }
      }
      if (maxAlloc >= 30) lines.push(`集中度偏高：${maxName} 占 ${maxAlloc.toFixed(0)}%，注意单票风险。`);
      blocks.push({ heading: "持仓要点", lines });
    }

    if (riskAlerts.length) {
      blocks.push({ heading: "风险提示", lines: riskAlerts.map((a) => `${a.label}：${a.detail}`) });
    } else {
      blocks.push({ heading: "风险提示", lines: ["当前无显著风险信号，持仓结构可控。"] });
    }

    if (scan?.marketState?.state) {
      const pf = scan.marketState.positionFactor;
      const advice =
        marketStateKey === "bull"
          ? "偏多环境，可适度积极、把握好节奏。"
          : marketStateKey === "bear"
            ? "偏空环境，建议防守、控制仓位、减少追高。"
            : "震荡环境，均衡配置、不追高、保留现金机动。";
      blocks.push({
        heading: "大盘与仓位",
        lines: [`市场处于${marketStateLabel}，建议仓位系数 ${(pf ?? 0).toFixed(2)}。`, advice],
      });
    }

    if (scanPicks.length) {
      blocks.push({
        heading: "策略关注",
        lines: [`引擎选出 ${scanPicks.length} 只，领头：${scanPicks[0].name}（评分 ${scanPicks[0].score.toFixed(2)}）。`, "点击右侧「策略选股榜」条目可看选股理由。"],
      });
    }
    return blocks;
  }, [insights, todayPnl, positions, quotes, riskAlerts, scan, scanPicks, marketStateKey, marketStateLabel]);

  if (!mounted) {
    return <div className="boot-loading">正在加载大屏…</div>;
  }

  return (
    <div className="bigscreen" style={{ background: BG, color: TEXT, height: "100vh", overflow: "hidden", fontFamily: "var(--font-sans)" }}>
      <div className="bs-topbar" />
      <div className="bs-ambient" />
      <div className="bs-stealth-hint">隐身模式 · 按 Esc 退出</div>
      <div style={{ width: "100%", padding: "18px 24px", display: "flex", flexDirection: "column", height: "100%" }}>
        <header style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 14, gap: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <button
              type="button"
              onClick={() => router.push("/")}
              className="interactive"
              title="返回主页"
              style={{
                background: "transparent",
                border: "none",
                color: "var(--accent, #00e5ff)",
                borderRadius: 6,
                padding: "6px",
                cursor: "pointer",
                flexShrink: 0,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                lineHeight: 1,
              }}
            >
              <Home size={18} />
            </button>
            <div>
              <div style={{ fontSize: 24, fontWeight: 500 }}>行情数据大屏</div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 14, fontFamily: "var(--font-mono)", fontSize: 13, color: MUTED, marginLeft: "auto" }}>
            {scan?.marketState?.state && (
              <span style={{ color: marketStateColor }}>大盘状态 {marketStateLabel}</span>
            )}
            <RealtimeClock refreshMs={refreshMs} lastLoadAt={lastLoadAt} />
            <span
              onClick={() => setQuotaPanelOpen((v) => !v)}
              title={quota.suspended ? "麦蕊今日额度将尽，已暂停主动刷新" : quota.degraded ? "麦蕊额度偏高，已自动放慢刷新" : "麦蕊每日额度消耗（点击查看）"}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                fontSize: 12,
                cursor: "pointer",
                color: quota.suspended ? "#ff6b6b" : quota.degraded ? "#f5a623" : MUTED,
                border: `1px solid ${quota.suspended ? "rgba(255,107,107,0.4)" : quota.degraded ? "rgba(245,166,35,0.4)" : "var(--border)"}`,
                borderRadius: 999,
                padding: "4px 12px",
              }}
            >
              麦蕊 {quota.used.toLocaleString()}/10000
            </span>
            {quotaPanelOpen && (
              <div
                style={{
                  position: "absolute",
                  top: 56,
                  right: 24,
                  zIndex: 50,
                  background: "var(--card)",
                  color: TEXT,
                  border: "1px solid var(--border)",
                  borderRadius: 12,
                  padding: 16,
                  width: 260,
                  boxShadow: "0 8px 24px rgba(0,0,0,0.25)",
                }}
              >
                <div style={{ fontWeight: 600, marginBottom: 8, color: TEXT }}>麦蕊每日额度</div>
                <div style={{ fontSize: 13, color: MUTED, marginBottom: 4 }}>
                  来源：{quota.source === "server" ? "服务端真实计数" : "本地估计（未连后端）"}
                </div>
                <div style={{ fontSize: 22, fontWeight: 700, marginBottom: 4, color: TEXT }}>
                  {quota.used.toLocaleString()} / {quota.limit.toLocaleString()}
                </div>
                <div
                  style={{
                    height: 8,
                    borderRadius: 999,
                    background: "var(--border)",
                    overflow: "hidden",
                    marginBottom: 12,
                  }}
                >
                  <div
                    style={{
                      width: `${Math.round(quota.ratio * 100)}%`,
                      height: "100%",
                      background: quota.suspended ? "#ff6b6b" : quota.degraded ? "#f5a623" : "var(--up)",
                    }}
                  />
                </div>
                {quota.suspended && (
                  <div style={{ fontSize: 12, color: "#ff6b6b", marginBottom: 8 }}>
                    额度将尽：前端已暂停主动刷新，仅手动/重进时拉取。
                  </div>
                )}
                {quota.degraded && !quota.suspended && (
                  <div style={{ fontSize: 12, color: "#f5a623", marginBottom: 8 }}>
                    额度偏高：前端已自动放慢刷新节奏。
                  </div>
                )}
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    className="btn btn--primary"
                    style={{ flex: 1 }}
                    onClick={() => {
                      void resetQuotaCounter();
                      setQuotaPanelOpen(false);
                    }}
                  >
                    重置计数
                  </button>
                  <button className="btn btn--ghost" style={{ flex: 1 }} onClick={() => setQuotaPanelOpen(false)}>
                    关闭
                  </button>
                </div>
              </div>
            )}
            <button
              type="button"
              onClick={() => setAiOpen(true)}
              className="interactive bs-panel"
              style={{
                background: "rgba(0,229,255,.10)",
                border: "0.5px solid rgba(0,229,255,.4)",
                color: ACCENT,
                borderRadius: 999,
                padding: "4px 12px",
                fontSize: 12,
                fontFamily: "var(--font-sans)",
                cursor: "pointer",
              }}
            >
              智能解读
            </button>
          </div>
        </header>

        {error && (
          <div style={{ background: "rgba(255,107,107,.12)", border: "0.5px solid rgba(255,107,107,.4)", color: "#ffb4b4", borderRadius: 10, padding: "8px 14px", fontSize: 12, marginBottom: 10 }}>
            部分数据读取失败：{error}（实时时段将自动重试）
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 12, marginBottom: 12, alignItems: "center", width: "100%" }}>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            {riskAlerts.length === 0 ? (
            <div style={{ display: "inline-flex", alignItems: "center", gap: 8, background: "rgba(45,212,191,.10)", border: "0.5px solid rgba(45,212,191,.35)", color: "#9ff0e2", borderRadius: 10, padding: "7px 14px", fontSize: 12.5 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#2dd4bf", display: "inline-block" }} />
              风险可控 · 无显著预警
            </div>
          ) : (
            riskAlerts.map((a, index) => {
              const high = a.level === "high";
              const color = high ? "var(--up)" : "var(--amber)";
              return (
                <div
                  key={index}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 8,
                    background: high ? "rgba(255,77,109,.12)" : "rgba(255,207,77,.10)",
                    border: `0.5px solid ${high ? "rgba(255,77,109,.4)" : "rgba(255,207,77,.38)"}`,
                    color,
                    borderRadius: 10,
                    padding: "7px 14px",
                    fontSize: 12.5,
                  }}
                >
                  <span style={{ fontWeight: 600 }}>{a.label}</span>
                  <span style={{ color: high ? "var(--up)" : "var(--amber)", fontFamily: "var(--font-mono)" }}>{a.detail}</span>
                </div>
              );
            })
          )}
          </div>
          <div className="bigscreen-search" style={{ width: 310, display: "flex", alignItems: "center", height: 30 }}>
            <StockSearch
              compact
              hideSubmitButton
              placeholder="输入代码 / 名称 / 拼音首字母"
              value={searchQuery}
              onChange={setSearchQuery}
              onSubmit={handleSearchSubmit}
              onSelect={handleSearchSelect}
              suggestions={searchSuggestions}
            />
          </div>
        </div>

        <main style={{ display: "grid", gridTemplateColumns: "minmax(230px, 290px) minmax(0, 1fr) minmax(270px, 330px) minmax(250px, 310px)", gap: 14, flex: 1, minHeight: 0 }}>
          <section className="fade-up" style={{ display: "flex", flexDirection: "column", gap: 10, minHeight: 0, animationDelay: "0ms" }}>
            <div className="interactive bs-panel" style={{ background: CARD, border: `0.5px solid ${BORDER}`, borderRadius: 14, padding: "14px 18px" }}>
              <div style={{ fontSize: 12, color: MUTED }}>总资产</div>
              <div className="bs-hero" style={{ fontSize: 30, fontWeight: 600, fontFamily: "var(--font-mono)", margin: "6px 0 4px" }}>
                <Rolling value={insights.totalAssetsCents} format={money} fallback="待设置" />
              </div>
              <div style={{ fontSize: 13, color: profitColor, fontFamily: "var(--font-mono)" }}>
                账户总盈亏 {pct(insights.totalProfitPercent)}
              </div>
            </div>
            <div className="interactive bs-panel" style={{ background: CARD, border: `0.5px solid ${todayPnl ? (todayPnl.gainCents >= 0 ? "rgba(255,107,107,.45)" : "rgba(45,212,191,.45)") : BORDER}`, borderRadius: 14, padding: "14px 18px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 12, color: MUTED }}>今日盈亏</span>
                <span style={{ fontSize: 10, color: MUTED }}>{todayPnl ? `${todayPnl.covered} 只持仓` : "等待行情"}</span>
              </div>
              <div style={{ fontSize: 28, fontWeight: 500, fontFamily: "var(--font-mono)", color: todayColor, margin: "6px 0 2px" }}>
                <Rolling value={todayPnl ? todayPnl.gainCents : null} format={signedMoney} />
              </div>
              <div style={{ fontSize: 13, color: todayColor, fontFamily: "var(--font-mono)" }}>
                {todayPnl ? `${pct(todayPnl.percent)} · 持仓加权` : "暂无实时行情"}
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <div className="interactive bs-panel" style={{ background: CARD, border: `0.5px solid ${BORDER}`, borderRadius: 14, padding: "11px 14px" }}>
                <div style={{ fontSize: 11, color: MUTED }}>总仓位</div>
                <div style={{ fontSize: 19, fontWeight: 500, fontFamily: "var(--font-mono)", marginTop: 5 }}>
                  <Rolling value={insights.totalPositionPercent} format={(v) => `${v.toFixed(1)}%`} />
                </div>
              </div>
              <div className="interactive bs-panel" style={{ background: CARD, border: `0.5px solid ${BORDER}`, borderRadius: 14, padding: "11px 14px" }}>
                <div style={{ fontSize: 11, color: MUTED }}>可用现金</div>
                <div style={{ fontSize: 19, fontWeight: 500, fontFamily: "var(--font-mono)", marginTop: 5 }}>
                  <Rolling value={insights.cashCents} format={money} />
                </div>
              </div>
              <div className="interactive bs-panel" style={{ background: CARD, border: `0.5px solid ${BORDER}`, borderRadius: 14, padding: "11px 14px" }}>
                <div style={{ fontSize: 11, color: MUTED }}>已实现盈亏</div>
                <div style={{ fontSize: 19, fontWeight: 500, fontFamily: "var(--font-mono)", marginTop: 5, color: insights.realizedCents >= 0 ? UP : DOWN }}>
                  <Rolling value={insights.realizedCents} format={money} />
                </div>
              </div>
              <div className="interactive bs-panel" style={{ background: CARD, border: `0.5px solid ${BORDER}`, borderRadius: 14, padding: "11px 14px" }}>
                <div style={{ fontSize: 11, color: MUTED }}>未实现盈亏</div>
                <div style={{ fontSize: 19, fontWeight: 500, fontFamily: "var(--font-mono)", marginTop: 5, color: insights.unrealizedCents >= 0 ? UP : DOWN }}>
                  <Rolling value={insights.unrealizedCents} format={money} />
                </div>
              </div>
            </div>
            <div className="interactive bs-panel" style={{ background: CARD, border: `0.5px solid ${BORDER}`, borderRadius: 14, padding: "12px 16px", flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
              <div style={{ fontSize: 11, color: MUTED, marginBottom: 6, flexShrink: 0 }}>大盘指数</div>
              <div style={{ flex: 1, minHeight: 0, overflowY: "auto", paddingRight: 4 }}>
                {activeIndices.length === 0 && <div style={{ fontSize: 12, color: MUTED }}>暂无指数数据</div>}
                {activeIndices.map((index) => {
                  const active = isActiveKlineCode(index.code);
                  return (
                    <div
                      key={index.code}
                      className="row-hover interactive"
                      onMouseEnter={(e) =>
                        showTooltip(e, {
                          title: index.name,
                          subtitle: index.code,
                          rows: [
                            { k: "最新价", v: index.price.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) },
                            { k: "涨跌幅", v: pct(index.changePercent), c: index.changePercent >= 0 ? "up" : "down" },
                          ],
                          note: active
                            ? "中央主图正在展示该指数日K。再次点击其它指数可切换。"
                            : "点击该指数，中央主图切换为其日K。",
                        })
                      }
                      onMouseLeave={() => setHover(null)}
                      onClick={() => openKline(index.code, index.name)}
                      title={`点击查看 ${index.name}（${index.code}）日K`}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        fontSize: 13,
                        fontFamily: "var(--font-mono)",
                        padding: "5px 0",
                        cursor: "pointer",
                        background: active ? "rgba(0,229,255,.08)" : "transparent",
                        borderRadius: 4,
                      }}
                    >
                      <span style={{ color: TEXT, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{index.name}</span>
                      <span style={{ color: index.changePercent >= 0 ? UP : DOWN, flexShrink: 0 }}>
                        <TickNum value={index.price} format={(v) => v.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} className="num" />{" "}
                        <TickNum value={index.changePercent} format={pct} className="num" />
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </section>

          <section className="fade-up" style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0, animationDelay: "90ms" }}>
            <div style={{ background: CARD, border: `0.5px solid ${BORDER}`, borderRadius: 14, padding: "12px 14px", display: "flex", flexDirection: "column", flex: 7, minHeight: 0, position: "relative" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <span style={{ fontSize: 12, color: MUTED }}>
                  {showAssetCurve
                    ? "资产走势 · 近 60 个节点（最新价估算）"
                    : `${klinePick.name}（${klinePick.code}）· K线技术面板`}
                </span>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  {!showAssetCurve && chart && (
                    <span style={{ fontSize: 13, color: CHART, fontFamily: "var(--font-mono)" }}>
                      {pct(((chart.latest - chart.first) / chart.first) * 100)}
                    </span>
                  )}
                  {!showAssetCurve && klinePick.code !== "000001" && (
                    <>
                      <button
                        type="button"
                        onClick={toggleWatchlist}
                        className="interactive bs-panel"
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 5,
                          background: watched ? "rgba(255,193,7,.12)" : "transparent",
                          border: `0.5px solid ${watched ? "rgba(255,193,7,.6)" : BORDER}`,
                          color: watched ? "#ffc107" : MUTED,
                          borderRadius: 999,
                          padding: "3px 12px",
                          fontSize: 11.5,
                          fontFamily: "var(--font-sans)",
                          cursor: "pointer",
                        }}
                        title={watched ? "取消关注" : "加入关注"}
                      >
                        <Star size={13} fill={watched ? "currentColor" : "none"} />
                        {watched ? "已关注" : "关注"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setStrategyPick(klinePick)}
                        className="interactive bs-panel"
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 5,
                          background: "rgba(0,229,255,.10)",
                          border: "0.5px solid rgba(0,229,255,.4)",
                          color: ACCENT,
                          borderRadius: 999,
                          padding: "3px 12px",
                          fontSize: 11.5,
                          fontFamily: "var(--font-sans)",
                          cursor: "pointer",
                        }}
                        title="结合我的持仓生成策略"
                      >
                        <Sparkles size={13} />
                        生成策略
                      </button>
                      {showAssetCurve ? (
                        <button
                          type="button"
                          onClick={() => setShowAssetCurve(false)}
                          className="interactive bs-panel"
                          style={{
                            background: "rgba(0,229,255,.10)",
                            border: "0.5px solid rgba(0,229,255,.4)",
                            color: ACCENT,
                            borderRadius: 999,
                            padding: "3px 12px",
                            fontSize: 11.5,
                            fontFamily: "var(--font-sans)",
                            cursor: "pointer",
                          }}
                          title="返回大盘 K 线"
                        >
                          ← 返回大盘
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setShowAssetCurve(true)}
                          className="interactive bs-panel"
                          style={{
                            background: "rgba(0,229,255,.10)",
                            border: "0.5px solid rgba(0,229,255,.4)",
                            color: ACCENT,
                            borderRadius: 999,
                            padding: "3px 12px",
                            fontSize: 11.5,
                            fontFamily: "var(--font-sans)",
                            cursor: "pointer",
                          }}
                          title="查看我的资产收益曲线"
                        >
                          我的收益
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>
              {showAssetCurve ? (
                chart ? (
                <svg
                  viewBox={`0 0 ${CHART_W} ${CHART_H}`}
                  width="100%"
                  style={{ flex: 1, minHeight: 0, cursor: "crosshair" }}
                  onMouseMove={handleCurveMove}
                  onMouseLeave={handleCurveLeave}
                >
                  <defs>
                    <linearGradient id="assetFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="rgba(255,107,107,.22)" />
                      <stop offset="100%" stopColor="rgba(255,107,107,0)" />
                    </linearGradient>
                  </defs>
                  <line x1={CHART_PAD} y1={CHART_PAD} x2={CHART_W - CHART_PAD} y2={CHART_PAD} stroke="rgba(255,255,255,.06)" strokeWidth="0.5" strokeDasharray="2 3" />
                  <line x1={CHART_PAD} y1={CHART_H / 2} x2={CHART_W - CHART_PAD} y2={CHART_H / 2} stroke="rgba(255,255,255,.06)" strokeWidth="0.5" strokeDasharray="2 3" />
                  <line x1={CHART_PAD} y1={CHART_H - CHART_PAD} x2={CHART_W - CHART_PAD} y2={CHART_H - CHART_PAD} stroke="rgba(255,255,255,.06)" strokeWidth="0.5" strokeDasharray="2 3" />
                  <path d={chart.smoothArea} fill="url(#assetFill)" />
                  <path d={chart.smoothLine} fill="none" stroke="rgba(255,107,107,.22)" strokeWidth="5" strokeLinecap="round" />
                  <path d={chart.smoothLine} fill="none" stroke={CHART} strokeWidth="1.6" strokeLinecap="round" />
                  <circle cx={chart.pts[chart.pts.length - 1].x} cy={chart.pts[chart.pts.length - 1].y} r="3.5" fill={CHART} />
                  <circle cx={chart.pts[chart.pts.length - 1].x} cy={chart.pts[chart.pts.length - 1].y} r="6.5" fill="none" stroke="rgba(0,229,255,.35)" strokeWidth="1" />
                  {curveIdx !== null && (
                    <g pointerEvents="none">
                      <line
                        x1={chart.pts[curveIdx].x}
                        y1={0}
                        x2={chart.pts[curveIdx].x}
                        y2={CHART_H}
                        stroke="rgba(0,229,255,.45)"
                        strokeWidth="0.5"
                        strokeDasharray="3 2"
                      />
                      <circle
                        cx={chart.pts[curveIdx].x}
                        cy={chart.pts[curveIdx].y}
                        r="4.5"
                        fill="var(--accent)"
                        stroke="#060b14"
                        strokeWidth="1"
                      />
                    </g>
                  )}
                </svg>
                ) : (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "center", flex: 1, color: MUTED, fontSize: 13 }}>
                  记录交易并设置初始资金后，这里会生成净值曲线
                </div>
                )
              ) : (
                <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", width: "100%" }}>
                  {/* 交互式 K 线：滚轮缩放 + 拖拽平移 + 日/周/月周期切换 + 仅最近 N 根 */}
                  <InteractiveKline code={klinePick.code} name={klinePick.name} fillParent />
                </div>
              )}
              {chart && (
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: MUTED, marginTop: 6, fontFamily: "var(--font-mono)" }}>
                  <span>{series.slice(-60)[0]?.date}</span>
                  <span>今日</span>
                </div>
              )}
            </div>
            <div style={{ background: CARD, border: `0.5px solid ${BORDER}`, borderRadius: 14, padding: "12px 18px", flex: 2, minHeight: 0, overflow: "hidden" }}>
              <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>最近交易</div>
              {recentTrades.length === 0 && <div style={{ fontSize: 12, color: MUTED }}>暂无交易记录</div>}
              {recentTrades.map((trade) => {
                const quote = quotes[trade.symbol];
                const active = isActiveKlineCode(trade.symbol);
                return (
                  <div
                  key={trade.id}
                  className="row-hover interactive"
                  onMouseEnter={(e) => {
                    const q = quotes[trade.symbol];
                    showTooltip(e, {
                      title: trade.name,
                      subtitle: trade.symbol,
                      rows: [
                        { k: "方向", v: trade.side, c: trade.side === "买入" ? "accent" : undefined },
                        { k: "成交价", v: ((trade.priceTenThousandths ?? (trade.priceMillis ?? trade.priceCents * 10) * 10) / 10000).toFixed(2) },
                        { k: "数量", v: `${trade.quantity} 股` },
                        { k: "费用", v: money(trade.feeCents ?? 0) },
                        { k: "交易日期", v: trade.tradeDate },
                        { k: "现价", v: q ? q.price.toFixed(2) : "—" },
                        { k: "当日涨跌", v: q ? pct(q.changePercent) : "—", c: q ? (q.changePercent >= 0 ? "up" : "down") : undefined },
                        { k: "大屏交互", v: active ? "K线展示中" : "点击查看日K", c: active ? "accent" : undefined },
                      ],
                      note: active ? "中央主图正在显示该股 K 线。再次点击其它股票可切换。" : "点击该行，中央主图会切换为该股的日 K 线（服务端实时拉取）。",
                    });
                  }}
                  onMouseLeave={() => setHover(null)}
                  onClick={() => openKline(trade.symbol, trade.name)}
                  title={`点击查看 ${trade.name}（${trade.symbol}）日K`}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    fontSize: 12.5,
                    padding: "8px 0 8px 8px",
                    marginLeft: "-8px",
                    borderBottom: "0.5px solid rgba(22,78,99,.55)",
                    borderLeft: active ? "2px solid var(--accent)" : "2px solid transparent",
                    background: active ? "rgba(0,229,255,.06)" : undefined,
                  }}
                >
                    <span style={{ fontFamily: "var(--font-mono)", color: MUTED, width: 62, flexShrink: 0 }}>{trade.tradeDate.slice(5)}</span>
                    <span style={{ width: 84, flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{trade.name}</span>
                    <span style={{ color: trade.side === "买入" ? ACCENT : "var(--amber)", width: 40, flexShrink: 0, fontWeight: 500 }}>{trade.side}</span>
                    <span style={{ fontFamily: "var(--font-mono)", width: 78, flexShrink: 0, textAlign: "right" }}>
                      {((trade.priceTenThousandths ?? (trade.priceMillis ?? trade.priceCents * 10) * 10) / 10000).toFixed(2)}
                    </span>
                    <span style={{ fontFamily: "var(--font-mono)", width: 66, flexShrink: 0, textAlign: "right" }}>{trade.quantity} 股</span>
                    <span style={{ fontFamily: "var(--font-mono)", width: 70, flexShrink: 0, textAlign: "right", color: quote ? (quote.changePercent >= 0 ? UP : DOWN) : MUTED }}>
                      {quote ? pct(quote.changePercent) : "—"}
                    </span>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="fade-up" style={{ display: "flex", flexDirection: "column", gap: 12, minHeight: 0, animationDelay: "180ms" }}>
            <div style={{ background: CARD, border: `0.5px solid ${BORDER}`, borderRadius: 14, padding: "14px 16px", display: "flex", gap: 14, alignItems: "center" }}>
              <svg viewBox="0 0 80 80" width="84" height="84" style={{ flexShrink: 0 }}>
                <circle cx="40" cy="40" r="32" fill="none" stroke={CARD} strokeWidth="11" />
                {donutSegments.map((seg) => (
                  <circle
                    key={seg.key}
                    cx="40"
                    cy="40"
                    r="32"
                    fill="none"
                    stroke={seg.color}
                    strokeWidth="11"
                    strokeDasharray={`${Math.max(seg.frac * donutCircumference - 2, 0)} ${donutCircumference}`}
                    strokeDashoffset={-seg.start * donutCircumference}
                  />
                ))}
              </svg>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, color: MUTED }}>持仓占比</div>
                <div style={{ fontSize: 15, fontFamily: "var(--font-mono)", marginTop: 3 }}>
                  {positions.length} 只 · {insights.totalPositionPercent !== null ? `${insights.totalPositionPercent.toFixed(1)}%` : "—"}
                </div>
                <div style={{ fontSize: 10, color: MUTED, marginTop: 6, lineHeight: 1.7 }}>
                  {positions.slice(0, 4).map((pos, index) => (
                    <span key={pos.symbol}>
                      <span style={{ color: PIE_COLORS[index % PIE_COLORS.length] }}>■</span> {pos.name}{" "}
                      {pos.allocationPercent !== null ? `${pos.allocationPercent.toFixed(0)}%` : ""}
                      {index < Math.min(positions.length, 4) - 1 ? "  " : ""}
                    </span>
                  ))}
                </div>
              </div>
            </div>
            <div style={{ background: CARD, border: `0.5px solid ${BORDER}`, borderRadius: 14, padding: "14px 16px", flex: 1, minHeight: 0, overflow: "hidden" }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: MUTED, marginBottom: 6 }}>
                <span>持仓明细 · 按今日涨跌</span>
                <span>今日 / 累计</span>
              </div>
              {positions.length === 0 && <div style={{ fontSize: 12, color: MUTED }}>暂无持仓</div>}
              <div style={{ display: "flex", flexDirection: "column" }}>
                {positionsByToday.map((pos) => {
                  const quote = quotes[pos.symbol];
                  const active = isActiveKlineCode(pos.symbol);
                  return (
                    <div
                      key={pos.symbol}
                      className="row-hover interactive"
                      onMouseEnter={(e) =>
                        showTooltip(e, {
                          title: pos.name,
                          subtitle: pos.symbol,
                          rows: [
                            { k: "现价", v: quote ? quote.price.toFixed(2) : "—" },
                            { k: "今日涨跌", v: quote ? pct(quote.changePercent) : "—", c: quote ? (quote.changePercent >= 0 ? "up" : "down") : undefined },
                            { k: "止损价", v: formatAlertPrice(alerts, pos.symbol, "止损"), c: "down" },
                            { k: "止盈价", v: formatAlertPrice(alerts, pos.symbol, "止盈一"), c: "up" },
                            { k: "持仓市值", v: money(pos.marketValueCents) },
                            { k: "持仓占比", v: pos.allocationPercent != null ? `${pos.allocationPercent.toFixed(1)}%` : "—" },
                            { k: "累计盈亏", v: pct(pos.returnPercent), c: pos.returnPercent >= 0 ? "up" : "down" },
                            { k: "大屏交互", v: active ? "K线展示中" : "点击查看日K", c: active ? "accent" : undefined },
                          ],
                          note: active
                            ? "中央主图正在显示该股 K 线。再次点击其它股票可切换。"
                            : "点击该行，中央主图会切换为该股的日 K 线（服务端正拉取，含 5 条关键价位标注）。",
                        })
                      }
                      onMouseLeave={() => setHover(null)}
                      onClick={() => openKline(pos.symbol, pos.name)}
                      title={`点击查看 ${pos.name}（${pos.symbol}）日K`}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        fontSize: 12.5,
                        padding: "6px 0 6px 8px",
                        marginLeft: "-8px",
                        borderBottom: "0.5px solid rgba(22,78,99,.55)",
                        borderLeft: active ? "2px solid var(--accent)" : "2px solid transparent",
                        background: active ? "rgba(0,229,255,.06)" : undefined,
                      }}
                    >
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "34%" }}>{pos.name}</span>
                      <span style={{ fontFamily: "var(--font-mono)", color: BRIGHT, fontSize: 12 }}>
                        <TickNum value={pos.marketValueCents} format={money} className="num" />
                      </span>
                      <span style={{ fontFamily: "var(--font-mono)", width: 58, textAlign: "right", color: quote ? (quote.changePercent >= 0 ? UP : DOWN) : MUTED }}>
                        {quote ? <TickNum value={quote.changePercent} format={pct} className="num" /> : "—"}
                      </span>
                      <span style={{ fontFamily: "var(--font-mono)", width: 62, textAlign: "right", color: pos.returnPercent >= 0 ? UP : DOWN, opacity: 0.75 }}>
                        <TickNum value={pos.returnPercent} format={pct} className="num" />
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </section>

          <section className="fade-up" style={{ display: "flex", flexDirection: "column", gap: 12, minHeight: 0, animationDelay: "270ms" }}>
            <div style={{ background: CARD, border: `0.5px solid ${BORDER}`, borderRadius: 14, padding: "14px 16px", flex: 6, minHeight: 0, overflow: "hidden" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
                <span style={{ fontSize: 12, color: MUTED }}>策略选股榜</span>
                <span style={{ fontSize: 10, color: MUTED, fontFamily: "var(--font-mono)" }}>
                  {scan?.generatedAt ? scan.generatedAt.slice(5, 16) : "等待引擎"}
                </span>
              </div>
              {scanPicks.length === 0 && (
                <div style={{ fontSize: 12, color: MUTED, lineHeight: 1.8 }}>
                  暂无扫描结果。<br />在本地运行选股中枢后自动同步。
                </div>
              )}
              {scanPicks.map((pick, index) => {
                const active = isActiveKlineCode(pick.code);
                return (
                <div
                  key={pick.code}
                  className="row-hover interactive"
                  onMouseEnter={(e) =>
                    showTooltip(e, {
                      title: pick.name,
                      subtitle: pick.code,
                      rows: [
                        { k: "综合评分", v: Number.isFinite(pick.score) ? pick.score.toFixed(2) : "—", c: "accent" },
                        { k: "所属板块", v: pick.sector ?? "—" },
                        { k: "大屏交互", v: active ? "K线展示中" : "点击查看日K", c: active ? "accent" : undefined },
                      ],
                      note: active
                        ? "中央主图正在显示该股 K 线。"
                        : (pick.rationale ?? `${pick.name}暂无文字理由。点击行可以让大屏中央切换为该股日 K 线。`),
                    })
                  }
                  onMouseLeave={() => setHover(null)}
                  onClick={() => openKline(pick.code, pick.name)}
                  title={`点击查看 ${pick.name}（${pick.code}）日K`}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 12.5,
                    padding: "6px 0 6px 8px",
                    marginLeft: "-8px",
                    borderBottom: "0.5px solid rgba(22,78,99,.55)",
                    borderLeft: active ? "2px solid var(--accent)" : "2px solid transparent",
                    background: active ? "rgba(0,229,255,.06)" : undefined,
                  }}
                >
                  <span style={{ width: 18, height: 18, flexShrink: 0, borderRadius: 5, background: index < 3 ? "rgba(34,211,238,.18)" : "rgba(111,147,168,.12)", color: index < 3 ? ACCENT : MUTED, fontSize: 10, fontFamily: "var(--font-mono)", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                    {index + 1}
                  </span>
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {pick.name}
                    <span style={{ color: MUTED, fontSize: 10, fontFamily: "var(--font-mono)", marginLeft: 6 }}>{pick.code}</span>
                  </span>
                  <span style={{ fontFamily: "var(--font-mono)", color: BRIGHT, fontSize: 12 }}>
                    {Number.isFinite(pick.score) ? pick.score.toFixed(2) : "—"}
                  </span>
                </div>
                );
              })}
            </div>
            <div style={{ background: CARD, border: `0.5px solid ${BORDER}`, borderRadius: 14, padding: "14px 16px", flex: 5, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8, flexShrink: 0 }}>
                <span style={{ fontSize: 12, color: MUTED }}>板块热力</span>
                <span style={{ fontSize: 10, color: MUTED, fontFamily: "var(--font-mono)" }}>{sectors?.date ?? "加载中"}</span>
              </div>
              {!sectors && <div style={{ fontSize: 12, color: MUTED }}>板块数据读取中…</div>}
              {sectors && (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, flex: 1, minHeight: 0, overflowY: "auto", paddingRight: 4 }}>
                  {sectors.items.map((sector) => {
                    // 板块热力可能来自麦蕊/东财板块榜，code 为空或东财板块代码无法直接拉 K 线；
                    // 统一按板块名解析到对应的 ETF 代码。解析不到则该板块无法查看 K 线（点击无跳转）。
                    const klineCode = resolveSectorKlineCode(sector.name);
                    const active = !!klineCode && isActiveKlineCode(klineCode);
                    return (
                    <div
                      key={sector.code || sector.name}
                      className="heat-tile interactive"
                      onMouseEnter={(e) =>
                        showTooltip(e, {
                          title: sector.name,
                          subtitle: klineCode ?? sector.code,
                          rows: [{ k: "今日涨跌幅", v: pct(sector.changePercent), c: sector.changePercent >= 0 ? "up" : "down" }],
                          note: klineCode
                            ? active
                              ? "中央主图正在展示该板块 ETF 日K。再次点击其它板块可切换。"
                              : "点击该板块，中央主图切换为其 ETF 日K。"
                            : "该板块暂无可查看的K线标的。",
                        })
                      }
                      onMouseLeave={() => setHover(null)}
                      onClick={() => {
                        if (klineCode) openKline(klineCode, sector.name);
                      }}
                      title={klineCode ? `点击查看 ${sector.name}（${klineCode}）日K` : `${sector.name}：暂无可查看的K线标的`}
                      style={{
                        background: heatColor(sector.changePercent),
                        border: active
                          ? "1.5px solid var(--accent)"
                          : `0.5px solid ${sector.changePercent >= 0 ? "rgba(255,107,107,.35)" : "rgba(45,212,191,.35)"}`,
                        borderRadius: 8,
                        padding: "6px 8px",
                        minWidth: 0,
                        cursor: klineCode ? "pointer" : "default",
                      }}
                    >
                      <div style={{ fontSize: 11.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sector.name}</div>
                      <div style={{ fontSize: 13, fontFamily: "var(--font-mono)", color: sector.changePercent >= 0 ? "var(--up)" : "var(--down)", marginTop: 2 }}>
                        {pct(sector.changePercent)}
                      </div>
                    </div>
                    );
                  })}
                </div>
              )}
            </div>
          </section>
        </main>

        <footer style={{ marginTop: 14, background: CARD, border: `0.5px solid ${BORDER}`, borderRadius: 12, overflow: "hidden", display: "flex", alignItems: "center", height: 42 }}>
          <span style={{ flexShrink: 0, padding: "0 18px", fontSize: 12, color: MUTED, borderRight: `0.5px solid ${BORDER}`, lineHeight: "42px" }}>
            自选行情
          </span>
          <div className="bigscreen-marquee" style={{ flex: 1, minWidth: 0, overflow: "hidden", height: "100%", display: "flex", alignItems: "center" }}>
            <div className="bigscreen-marquee-track" style={{ display: "flex", width: "max-content", flexShrink: 0 }}>
              {[0, 1].map((copy) => (
                <div key={copy} style={{ display: "flex", alignItems: "center", whiteSpace: "nowrap" }} aria-hidden={copy === 1}>
                  {marqueeSymbols.map((item) => {
                    const q = item.quote;
                    return (
                      <span key={`${copy}-${item.symbol}`} style={{ padding: "0 22px", fontSize: 13, fontFamily: "var(--font-mono)" }}>
                        <span style={{ color: BRIGHT }}>{item.symbol}</span> {item.name}{" "}
                        {q ? (
                          <>
                            <span style={{ color: TEXT }}>{q.price.toFixed(2)}</span>{" "}
                            <span style={{ color: q.changePercent >= 0 ? UP : DOWN }}>{pct(q.changePercent)}</span>
                          </>
                        ) : (
                          <span style={{ color: MUTED }}>暂无行情</span>
                        )}
                      </span>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
          <span style={{ flexShrink: 0, padding: "0 18px", fontSize: 11, color: ACCENT, fontFamily: "var(--font-mono)", letterSpacing: 1 }}>
            LIVE
          </span>
        </footer>
      </div>

      {hover && (
        <div
          className={`bs-pop ${hover.side === "left" ? "left" : "right"}`}
          style={{ left: hover.pos.left, top: hover.pos.top }}
        >
          <div className="bs-pop-head">
            <div className="bs-pop-title">{hover.data.title}</div>
            {hover.data.subtitle && <div className="bs-pop-sub">{hover.data.subtitle}</div>}
          </div>
          <div className="bs-pop-body">
            {hover.data.rows.map((r, i) => (
              <div className="bs-row" key={i}>
                <span className="bs-k">{r.k}</span>
                <span
                  className="bs-v"
                  style={{ color: r.c === "up" ? "var(--up)" : r.c === "down" ? "var(--down)" : r.c === "accent" ? ACCENT : undefined }}
                >
                  {r.v}
                </span>
              </div>
            ))}
          </div>
          {hover.data.note && <p className="bs-pop-note">{hover.data.note}</p>}
        </div>
      )}

      {aiOpen && (
        <>
          <div className="bigscreen-drawer-backdrop" onClick={() => setAiOpen(false)} />
          <aside className="bigscreen-drawer">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div>
                <div style={{ fontSize: 18, fontWeight: 500 }}>智能解读</div>
                <div style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>基于当前盘面数据的自动播报</div>
              </div>
              <button
                type="button"
                onClick={() => setAiOpen(false)}
                className="interactive bs-panel"
                style={{ background: "transparent", border: "0.5px solid var(--border)", color: MUTED, borderRadius: 8, width: 28, height: 28, cursor: "pointer", fontSize: 14 }}
                aria-label="关闭"
              >
                ×
              </button>
            </div>
            <div style={{ marginTop: 14 }}>
              {aiBriefing.map((block) => (
                <div className="bs-block" key={block.heading}>
                  <h4>{block.heading}</h4>
                  {block.lines.map((line, i) => (
                    <p key={i}>{line}</p>
                  ))}
                </div>
              ))}
            </div>
          </aside>
        </>
      )}

      {strategyPick && (
        <StrategyModal
          code={strategyPick.code}
          name={strategyPick.name}
          trades={trades}
          portfolioInsights={insights}
          onClose={() => setStrategyPick(null)}
        />
      )}
    </div>
  );
}
