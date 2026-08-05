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
import { calculatePortfolioInsights } from "../../lib/domain/portfolio-insights";
import type { CapitalFlow, Trade } from "../../lib/domain/domain";
import { formatDateTimeShanghai, shanghaiDate } from "../../lib/utils/time";

type Quote = { price: number; changePercent: number; fetchedAt: string };
type MarketIndex = { code: string; name: string; price: number; changePercent: number; change: number };
type WatchItem = { symbol: string; name: string };
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

const PIE_COLORS = ["#ff6b6b", "#22d3ee", "#a78bfa", "#2dd4bf", "#f5a524", "#60a5fa", "#f472b6", "#34d399"];
const UP = "#ff6b6b";
const DOWN = "#2dd4bf";
const BG = "#0a0f16";
const CARD = "#0f1a26";
const BORDER = "#164e63";
const TEXT = "#d7f4fb";
const MUTED = "#6f93a8";
const BRIGHT = "#a5f3fc";
const ACCENT = "#22d3ee";
const CHART = "#ff6b6b";
const RING_R = 9;

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

/** 取上海墙钟的 时/分/星期，统一用 Intl(timeZone=Asia/Shanghai)，不依赖容器时区。 */
function shanghaiParts(date: Date): { h: number; m: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false,
  }).formatToParts(date);
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? "";
  const dayMap: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 0 };
  return { h: parseInt(get("hour"), 10) || 0, m: parseInt(get("minute"), 10) || 0, day: dayMap[get("weekday")] ?? 0 };
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

export function BigScreenView() {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [watchlist, setWatchlist] = useState<WatchItem[]>([]);
  const [initialCapitalCents, setInitialCapitalCents] = useState<number | null>(null);
  const [capitalFlows, setCapitalFlows] = useState<CapitalFlow[]>([]);
  const [indices, setIndices] = useState<MarketIndex[]>([]);
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const [scan, setScan] = useState<ScanBrief | null>(null);
  const [sectors, setSectors] = useState<{ date: string; items: SectorMove[] } | null>(null);
  const [now, setNow] = useState<Date | null>(null);
  const [error, setError] = useState("");
  const [refreshMs, setRefreshMs] = useState<number>(TRADING_OPEN_MS);
  const [lastLoadAt, setLastLoadAt] = useState<number | null>(null);
  const dataTimerRef = useRef<number | null>(null);

  const loadData = useCallback(async () => {
    setLastLoadAt(Date.now());
    setRefreshMs(marketRefreshMs(new Date()));
    try {
      const [tradeData, watchData, accountData, indexData] = await Promise.all([
        jsonRequest<{ trades: Trade[] }>("/api/trades"),
        jsonRequest<{ items: WatchItem[] }>("/api/watchlist"),
        jsonRequest<{ initialCapitalCents: number | null; capitalFlows: CapitalFlow[] }>("/api/account"),
        jsonRequest<{ indices: MarketIndex[] }>("/api/indices"),
      ]);
      setTrades(tradeData.trades);
      setWatchlist(watchData.items);
      setInitialCapitalCents(accountData.initialCapitalCents);
      setCapitalFlows(accountData.capitalFlows ?? []);
      setIndices(indexData.indices ?? []);
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

  /** 慢数据：策略选股榜 + 板块热力图。单项失败静默跳过，不影响主看板。 */
  const loadSlowData = useCallback(async () => {
    void jsonRequest<{ ok?: boolean; scan?: ScanBrief | null }>("/api/strategy-scan")
      .then((res) => {
        if (res?.scan) setScan(res.scan);
      })
      .catch(() => undefined);

    for (const date of recentDates(4)) {
      try {
        const data = await jsonRequest<{ date: string; sectors: SectorMove[] }>(
          `/api/sector-heatmap?date=${date}&limit=10`,
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

  useEffect(() => {
    let cancelled = false;
    const run = () => {
      void loadData().finally(() => {
        if (cancelled) return;
        const interval = marketRefreshMs(new Date());
        setRefreshMs(interval);
        dataTimerRef.current = window.setTimeout(run, interval);
      });
    };
    const initial = window.setTimeout(run, 0);
    const clockInitial = window.setTimeout(() => setNow(new Date()), 0);
    const clockTimer = window.setInterval(() => setNow(new Date()), 1_000);
    return () => {
      cancelled = true;
      window.clearTimeout(initial);
      if (dataTimerRef.current) window.clearTimeout(dataTimerRef.current);
      window.clearTimeout(clockInitial);
      window.clearInterval(clockTimer);
    };
  }, [loadData]);

  useEffect(() => {
    const initial = window.setTimeout(() => void loadSlowData(), 300);
    const timer = window.setInterval(() => void loadSlowData(), 300_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [loadSlowData]);

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
    const area = `${line} L${pts[pts.length - 1].x.toFixed(1)},${CHART_H} L${pts[0].x.toFixed(1)},${CHART_H} Z`;
    return { pts, line, area, min, max, latest: recent[recent.length - 1].value, first: recent[0].value };
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
    let maxAlloc = 0;
    let maxAllocName = "";
    for (const p of positions) {
      if (p.allocationPercent != null && p.allocationPercent > maxAlloc) {
        maxAlloc = p.allocationPercent;
        maxAllocName = p.name;
      }
    }
    if (maxAlloc >= 40) alerts.push({ level: "high", label: "持仓集中", detail: `${maxAllocName} 占 ${maxAlloc.toFixed(0)}%` });
    else if (maxAlloc >= 30) alerts.push({ level: "warn", label: "持仓偏集中", detail: `${maxAllocName} 占 ${maxAlloc.toFixed(0)}%` });
    for (const p of positions) {
      const cp = quotes[p.symbol]?.changePercent;
      if (cp != null && cp <= -5) {
        alerts.push({ level: cp <= -8 ? "high" : "warn", label: "今日大跌", detail: `${p.name} ${pct(cp)}` });
      }
    }
    const total = insights.totalAssetsCents ?? 0;
    const cash = insights.cashCents ?? 0;
    if (total > 0 && cash / total < 0.1) {
      alerts.push({ level: "warn", label: "现金偏低", detail: `现金 ${(cash / total *100).toFixed(0)}%` });
    }
    if ((insights.totalProfitCents ?? 0) < 0) {
      alerts.push({ level: "warn", label: "账户浮亏", detail: pct(insights.totalProfitPercent) });
    }
    return alerts.slice(0, 6);
  }, [positions, quotes, insights]);

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

  // 最近交易：按日期倒序取前 6 条
  const recentTrades = useMemo(
    () => [...trades].sort((a, b) => b.tradeDate.localeCompare(a.tradeDate) || b.id - a.id).slice(0, 6),
    [trades],
  );

  const scanPicks = (scan?.selected ?? []).slice(0, 8);
  const marketStateKey = scan?.marketState?.state ?? "";
  const marketStateLabel = MARKET_STATE_LABEL[marketStateKey] ?? (marketStateKey || "—");
  const marketStateColor =
    marketStateKey === "bull" ? UP : marketStateKey === "bear" ? DOWN : MUTED;

  const activeIndices = indices.slice(0, 3);
  const timeText = now ? formatDateTimeShanghai(now) : "——:——:——";
  const profitColor = (insights.totalProfitCents ?? 0) >= 0 ? UP : DOWN;
  const todayColor = (todayPnl?.gainCents ?? 0) >= 0 ? UP : DOWN;

  // 刷新倒计时（秒）：基于上次加载时刻与当前节奏，驱动右上角倒计时环
  const countdown = useMemo(() => {
    if (!now || lastLoadAt == null) return Math.ceil(refreshMs / 1000);
    const elapsed = Math.floor((now.getTime() - lastLoadAt) / 1000);
    return Math.max(0, Math.ceil(refreshMs / 1000) - elapsed);
  }, [now, refreshMs, lastLoadAt]);
  const ringProgress = refreshMs > 0 ? countdown / (refreshMs / 1000) : 0;
  const ringCircumference = 2 * Math.PI * RING_R;

  return (
    <div className="bigscreen" style={{ background: BG, color: TEXT, height: "100vh", overflow: "hidden", fontFamily: "var(--font-sans)" }}>
      <div style={{ width: "100%", padding: "18px 24px", display: "flex", flexDirection: "column", height: "100%" }}>
        <header style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: 12, color: MUTED, letterSpacing: 2 }}>ACCOUNT OVERVIEW · 大屏展示</div>
            <div style={{ fontSize: 24, fontWeight: 500, marginTop: 4 }}>我的仓位与盈亏</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 14, fontFamily: "var(--font-mono)", fontSize: 13, color: MUTED }}>
            {scan?.marketState?.state && (
              <span style={{ color: marketStateColor }}>大盘状态 {marketStateLabel}</span>
            )}
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
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
            </span>
            <span>{timeText}</span>
          </div>
        </header>

        {error && (
          <div style={{ background: "rgba(255,107,107,.12)", border: "0.5px solid rgba(255,107,107,.4)", color: "#ffb4b4", borderRadius: 10, padding: "8px 14px", fontSize: 12, marginBottom: 10 }}>
            部分数据读取失败：{error}（稍后自动重试）
          </div>
        )}

        <div style={{ display: "flex", gap: 10, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
          {riskAlerts.length === 0 ? (
            <div style={{ display: "inline-flex", alignItems: "center", gap: 8, background: "rgba(45,212,191,.10)", border: "0.5px solid rgba(45,212,191,.35)", color: "#9ff0e2", borderRadius: 10, padding: "7px 14px", fontSize: 12.5 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#2dd4bf", display: "inline-block" }} />
              风险可控 · 无显著预警
            </div>
          ) : (
            riskAlerts.map((a, index) => {
              const high = a.level === "high";
              const color = high ? "#ff6b6b" : "#f5a524";
              return (
                <div
                  key={index}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 8,
                    background: high ? "rgba(255,107,107,.12)" : "rgba(245,165,36,.10)",
                    border: `0.5px solid ${high ? "rgba(255,107,107,.4)" : "rgba(245,165,36,.38)"}`,
                    color,
                    borderRadius: 10,
                    padding: "7px 14px",
                    fontSize: 12.5,
                  }}
                >
                  <span style={{ fontWeight: 600 }}>{a.label}</span>
                  <span style={{ color: high ? "#ffc9c9" : "#ffe2b0", fontFamily: "var(--font-mono)" }}>{a.detail}</span>
                </div>
              );
            })
          )}
        </div>

        <main style={{ display: "grid", gridTemplateColumns: "minmax(230px, 290px) minmax(0, 1fr) minmax(270px, 330px) minmax(250px, 310px)", gap: 14, flex: 1, minHeight: 0 }}>
          <section style={{ display: "flex", flexDirection: "column", gap: 10, minHeight: 0 }}>
            <div style={{ background: CARD, border: `0.5px solid ${BORDER}`, borderRadius: 14, padding: "14px 18px" }}>
              <div style={{ fontSize: 12, color: MUTED }}>总资产</div>
              <div style={{ fontSize: 30, fontWeight: 500, fontFamily: "var(--font-mono)", color: BRIGHT, margin: "6px 0 4px" }}>
                <Rolling value={insights.totalAssetsCents} format={money} fallback="待设置" />
              </div>
              <div style={{ fontSize: 13, color: profitColor, fontFamily: "var(--font-mono)" }}>
                账户总盈亏 {pct(insights.totalProfitPercent)}
              </div>
            </div>
            <div style={{ background: CARD, border: `0.5px solid ${todayPnl ? (todayPnl.gainCents >= 0 ? "rgba(255,107,107,.45)" : "rgba(45,212,191,.45)") : BORDER}`, borderRadius: 14, padding: "14px 18px" }}>
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
              <div style={{ background: CARD, border: `0.5px solid ${BORDER}`, borderRadius: 14, padding: "11px 14px" }}>
                <div style={{ fontSize: 11, color: MUTED }}>总仓位</div>
                <div style={{ fontSize: 19, fontWeight: 500, fontFamily: "var(--font-mono)", marginTop: 5 }}>
                  <Rolling value={insights.totalPositionPercent} format={(v) => `${v.toFixed(1)}%`} />
                </div>
              </div>
              <div style={{ background: CARD, border: `0.5px solid ${BORDER}`, borderRadius: 14, padding: "11px 14px" }}>
                <div style={{ fontSize: 11, color: MUTED }}>可用现金</div>
                <div style={{ fontSize: 19, fontWeight: 500, fontFamily: "var(--font-mono)", marginTop: 5 }}>
                  <Rolling value={insights.cashCents} format={money} />
                </div>
              </div>
              <div style={{ background: CARD, border: `0.5px solid ${BORDER}`, borderRadius: 14, padding: "11px 14px" }}>
                <div style={{ fontSize: 11, color: MUTED }}>已实现盈亏</div>
                <div style={{ fontSize: 19, fontWeight: 500, fontFamily: "var(--font-mono)", marginTop: 5, color: insights.realizedCents >= 0 ? UP : DOWN }}>
                  <Rolling value={insights.realizedCents} format={money} />
                </div>
              </div>
              <div style={{ background: CARD, border: `0.5px solid ${BORDER}`, borderRadius: 14, padding: "11px 14px" }}>
                <div style={{ fontSize: 11, color: MUTED }}>未实现盈亏</div>
                <div style={{ fontSize: 19, fontWeight: 500, fontFamily: "var(--font-mono)", marginTop: 5, color: insights.unrealizedCents >= 0 ? UP : DOWN }}>
                  <Rolling value={insights.unrealizedCents} format={money} />
                </div>
              </div>
            </div>
            <div style={{ background: CARD, border: `0.5px solid ${BORDER}`, borderRadius: 14, padding: "12px 16px", flex: 1, minHeight: 0 }}>
              <div style={{ fontSize: 11, color: MUTED, marginBottom: 6 }}>大盘指数</div>
              {activeIndices.length === 0 && <div style={{ fontSize: 12, color: MUTED }}>暂无指数数据</div>}
              {activeIndices.map((index) => (
                <div key={index.code} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, fontFamily: "var(--font-mono)", padding: "5px 0" }}>
                  <span style={{ color: TEXT }}>{index.name}</span>
                  <span style={{ color: index.changePercent >= 0 ? UP : DOWN }}>
                    {index.price.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}{" "}
                    {pct(index.changePercent)}
                  </span>
                </div>
              ))}
            </div>
          </section>

          <section style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
            <div style={{ background: CARD, border: `0.5px solid ${BORDER}`, borderRadius: 14, padding: "16px 18px", display: "flex", flexDirection: "column", flex: 5, minHeight: 0 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <span style={{ fontSize: 12, color: MUTED }}>资产走势 · 近 60 个节点（最新价估算）</span>
                {chart && (
                  <span style={{ fontSize: 13, color: CHART, fontFamily: "var(--font-mono)" }}>
                    {pct(((chart.latest - chart.first) / chart.first) * 100)}
                  </span>
                )}
              </div>
              {chart ? (
                <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} width="100%" style={{ flex: 1, minHeight: 0 }}>
                  <line x1={CHART_PAD} y1={CHART_PAD} x2={CHART_W - CHART_PAD} y2={CHART_PAD} stroke={BORDER} strokeWidth="0.5" />
                  <line x1={CHART_PAD} y1={CHART_H / 2} x2={CHART_W - CHART_PAD} y2={CHART_H / 2} stroke={BORDER} strokeWidth="0.5" />
                  <line x1={CHART_PAD} y1={CHART_H - CHART_PAD} x2={CHART_W - CHART_PAD} y2={CHART_H - CHART_PAD} stroke={BORDER} strokeWidth="0.5" />
                  <path d={chart.area} fill="rgba(255,107,107,.10)" />
                  <path d={chart.line} fill="none" stroke="rgba(255,107,107,.25)" strokeWidth="5" strokeLinecap="round" />
                  <path d={chart.line} fill="none" stroke={CHART} strokeWidth="1.6" strokeLinecap="round" />
                  <circle cx={chart.pts[chart.pts.length - 1].x} cy={chart.pts[chart.pts.length - 1].y} r="3.5" fill={CHART} />
                </svg>
              ) : (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "center", flex: 1, color: MUTED, fontSize: 13 }}>
                  记录交易并设置初始资金后，这里会生成净值曲线
                </div>
              )}
              {chart && (
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: MUTED, marginTop: 6, fontFamily: "var(--font-mono)" }}>
                  <span>{series.slice(-60)[0]?.date}</span>
                  <span>今日</span>
                </div>
              )}
            </div>
            <div style={{ background: CARD, border: `0.5px solid ${BORDER}`, borderRadius: 14, padding: "14px 18px", flex: 3, minHeight: 0, overflow: "hidden" }}>
              <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>最近交易</div>
              {recentTrades.length === 0 && <div style={{ fontSize: 12, color: MUTED }}>暂无交易记录</div>}
              {recentTrades.map((trade) => {
                const quote = quotes[trade.symbol];
                return (
                  <div key={trade.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12.5, padding: "8px 0", borderBottom: "0.5px solid rgba(22,78,99,.55)" }}>
                    <span style={{ fontFamily: "var(--font-mono)", color: MUTED, width: 62, flexShrink: 0 }}>{trade.tradeDate.slice(5)}</span>
                    <span style={{ width: 84, flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{trade.name}</span>
                    <span style={{ color: trade.side === "买入" ? ACCENT : "#f5a524", width: 40, flexShrink: 0, fontWeight: 500 }}>{trade.side}</span>
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

          <section style={{ display: "flex", flexDirection: "column", gap: 12, minHeight: 0 }}>
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
                  return (
                    <div key={pos.symbol} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12.5, padding: "6px 0", borderBottom: `0.5px solid rgba(22,78,99,.55)` }}>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "34%" }}>{pos.name}</span>
                      <span style={{ fontFamily: "var(--font-mono)", color: BRIGHT, fontSize: 12 }}>{money(pos.marketValueCents)}</span>
                      <span style={{ fontFamily: "var(--font-mono)", width: 58, textAlign: "right", color: quote ? (quote.changePercent >= 0 ? UP : DOWN) : MUTED }}>
                        {quote ? pct(quote.changePercent) : "—"}
                      </span>
                      <span style={{ fontFamily: "var(--font-mono)", width: 62, textAlign: "right", color: pos.returnPercent >= 0 ? UP : DOWN, opacity: 0.75 }}>
                        {pct(pos.returnPercent)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </section>

          <section style={{ display: "flex", flexDirection: "column", gap: 12, minHeight: 0 }}>
            <div style={{ background: CARD, border: `0.5px solid ${BORDER}`, borderRadius: 14, padding: "14px 16px", flex: 3, minHeight: 0, overflow: "hidden" }}>
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
              {scanPicks.map((pick, index) => (
                <div key={pick.code} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, padding: "6px 0", borderBottom: "0.5px solid rgba(22,78,99,.55)" }}>
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
              ))}
            </div>
            <div style={{ background: CARD, border: `0.5px solid ${BORDER}`, borderRadius: 14, padding: "14px 16px", flex: 2, minHeight: 0, overflow: "hidden" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
                <span style={{ fontSize: 12, color: MUTED }}>板块热力</span>
                <span style={{ fontSize: 10, color: MUTED, fontFamily: "var(--font-mono)" }}>{sectors?.date ?? "加载中"}</span>
              </div>
              {!sectors && <div style={{ fontSize: 12, color: MUTED }}>板块数据读取中…</div>}
              {sectors && (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                  {sectors.items.slice(0, 10).map((sector) => (
                    <div
                      key={sector.code}
                      style={{
                        background: heatColor(sector.changePercent),
                        border: `0.5px solid ${sector.changePercent >= 0 ? "rgba(255,107,107,.35)" : "rgba(45,212,191,.35)"}`,
                        borderRadius: 8,
                        padding: "6px 8px",
                        minWidth: 0,
                      }}
                    >
                      <div style={{ fontSize: 11.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sector.name}</div>
                      <div style={{ fontSize: 13, fontFamily: "var(--font-mono)", color: sector.changePercent >= 0 ? "#ffd0d0" : "#c8fbf1", marginTop: 2 }}>
                        {pct(sector.changePercent)}
                      </div>
                    </div>
                  ))}
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
    </div>
  );
}
