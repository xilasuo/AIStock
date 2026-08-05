"use client";

/**
 * 大屏展示页（/screen）
 *
 * 深色数据终端风格：核心指标 + 大盘、资产走势大图、持仓占比环图、自选行情跑马灯。
 * 只读展示，30 秒轮询刷新，用于投屏（办公室大屏 / 电视 / 会议室）。
 * 复用现有 API（trades / account / watchlist / indices / quote），不改任何业务逻辑。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { calculatePortfolioInsights } from "../../lib/domain/portfolio-insights";
import type { CapitalFlow, Trade } from "../../lib/domain/domain";
import { formatDateTimeShanghai } from "../../lib/utils/time";

type Quote = { price: number; changePercent: number; fetchedAt: string };
type MarketIndex = { code: string; name: string; price: number; changePercent: number; change: number };
type WatchItem = { symbol: string; name: string };

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

function pct(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
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

export function BigScreenView() {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [watchlist, setWatchlist] = useState<WatchItem[]>([]);
  const [initialCapitalCents, setInitialCapitalCents] = useState<number | null>(null);
  const [capitalFlows, setCapitalFlows] = useState<CapitalFlow[]>([]);
  const [indices, setIndices] = useState<MarketIndex[]>([]);
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const [now, setNow] = useState<Date | null>(null);
  const [error, setError] = useState("");

  const loadData = useCallback(async () => {
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

  useEffect(() => {
    const initial = window.setTimeout(() => void loadData(), 0);
    const dataTimer = window.setInterval(() => void loadData(), 30_000);
    const clockInitial = window.setTimeout(() => setNow(new Date()), 0);
    const clockTimer = window.setInterval(() => setNow(new Date()), 1_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(dataTimer);
      window.clearTimeout(clockInitial);
      window.clearInterval(clockTimer);
    };
  }, [loadData]);

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

  const activeIndices = indices.slice(0, 3);
  const timeText = now ? formatDateTimeShanghai(now) : "——:——:——";
  const profitColor = (insights.totalProfitCents ?? 0) >= 0 ? UP : DOWN;

  return (
    <div className="bigscreen" style={{ background: BG, color: TEXT, height: "100vh", overflow: "hidden", fontFamily: "var(--font-sans)" }}>
      <div style={{ width: "100%", padding: "22px 28px", display: "flex", flexDirection: "column", height: "100%" }}>
        <header style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 18 }}>
          <div>
            <div style={{ fontSize: 12, color: MUTED, letterSpacing: 2 }}>ACCOUNT OVERVIEW · 大屏展示</div>
            <div style={{ fontSize: 26, fontWeight: 500, marginTop: 4 }}>我的仓位与盈亏</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 14, fontFamily: "var(--font-mono)", fontSize: 13, color: MUTED }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <span className="bigscreen-live-dot" style={{ width: 8, height: 8, borderRadius: "50%", background: ACCENT, display: "inline-block" }} />
              实时连接
            </span>
            <span>{timeText}</span>
          </div>
        </header>

        {error && (
          <div style={{ background: "rgba(255,107,107,.12)", border: "0.5px solid rgba(255,107,107,.4)", color: "#ffb4b4", borderRadius: 10, padding: "8px 14px", fontSize: 12, marginBottom: 12 }}>
            部分数据读取失败：{error}（30 秒后自动重试）
          </div>
        )}

        <main style={{ display: "grid", gridTemplateColumns: "minmax(280px, 360px) 1fr minmax(300px, 380px)", gap: 16, flex: 1, minHeight: 0 }}>
          <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ background: CARD, border: `0.5px solid ${BORDER}`, borderRadius: 14, padding: "18px 20px", flex: 1 }}>
              <div style={{ fontSize: 12, color: MUTED }}>总资产</div>
              <div style={{ fontSize: 34, fontWeight: 500, fontFamily: "var(--font-mono)", color: BRIGHT, margin: "8px 0 4px" }}>
                {insights.totalAssetsCents !== null ? money(insights.totalAssetsCents) : "待设置"}
              </div>
              <div style={{ fontSize: 13, color: profitColor, fontFamily: "var(--font-mono)" }}>
                账户总盈亏 {pct(insights.totalProfitPercent)}
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div style={{ background: CARD, border: `0.5px solid ${BORDER}`, borderRadius: 14, padding: "14px 16px" }}>
                <div style={{ fontSize: 11, color: MUTED }}>总仓位</div>
                <div style={{ fontSize: 22, fontWeight: 500, fontFamily: "var(--font-mono)", marginTop: 6 }}>
                  {insights.totalPositionPercent !== null ? `${insights.totalPositionPercent.toFixed(1)}%` : "—"}
                </div>
              </div>
              <div style={{ background: CARD, border: `0.5px solid ${BORDER}`, borderRadius: 14, padding: "14px 16px" }}>
                <div style={{ fontSize: 11, color: MUTED }}>可用现金</div>
                <div style={{ fontSize: 22, fontWeight: 500, fontFamily: "var(--font-mono)", marginTop: 6 }}>
                  {insights.cashCents !== null ? money(insights.cashCents) : "—"}
                </div>
              </div>
            </div>
            <div style={{ background: CARD, border: `0.5px solid ${BORDER}`, borderRadius: 14, padding: "14px 16px" }}>
              <div style={{ fontSize: 11, color: MUTED, marginBottom: 8 }}>大盘指数</div>
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

          <section style={{ background: CARD, border: `0.5px solid ${BORDER}`, borderRadius: 14, padding: "16px 18px", display: "flex", flexDirection: "column", minWidth: 0 }}>
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
          </section>

          <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
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
              <div style={{ fontSize: 11, color: MUTED, marginBottom: 6 }}>持仓明细</div>
              {positions.length === 0 && <div style={{ fontSize: 12, color: MUTED }}>暂无持仓</div>}
              <div style={{ display: "flex", flexDirection: "column", height: "calc(100% - 24px)" }}>
                {positions.map((pos) => (
                  <div key={pos.symbol} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13, padding: "7px 0", borderBottom: `0.5px solid rgba(22,78,99,.55)` }}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "60%" }}>{pos.name}</span>
                    <span style={{ fontFamily: "var(--font-mono)" }}>
                      <span style={{ color: pos.returnPercent >= 0 ? UP : DOWN }}>{pct(pos.returnPercent)}</span>{" "}
                      <span style={{ color: MUTED, fontSize: 11 }}>{money(pos.unrealizedCents)}</span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </section>
        </main>

        <footer style={{ marginTop: 16, background: CARD, border: `0.5px solid ${BORDER}`, borderRadius: 12, overflow: "hidden" }}>
          <div className="bigscreen-marquee" style={{ display: "flex", alignItems: "center", height: 44 }}>
            <span style={{ flexShrink: 0, padding: "0 18px", fontSize: 12, color: MUTED, borderRight: `0.5px solid ${BORDER}`, lineHeight: "44px" }}>
              自选行情
            </span>
            <div className="bigscreen-marquee-track" style={{ display: "flex", flex: 1, minWidth: 0 }}>
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
            <span style={{ flexShrink: 0, padding: "0 18px", fontSize: 11, color: ACCENT, fontFamily: "var(--font-mono)", letterSpacing: 1 }}>
              LIVE
            </span>
          </div>
        </footer>
      </div>
    </div>
  );
}
