"use client";

/**
 * 交互式 K 线图（数据大屏/分析页共用）。
 *
 * 用 lightweight-charts 在 canvas 上渲染，原生支持：
 *   - 滚轮缩放（鼠标在图上滚动即可放大/缩小 K 线窗口）
 *   - 拖拽平移（按住左键左右拖动看不同时间段）
 *   - 鼠标十字光标 / 价格时间悬浮提示
 *
 * 另提供周期切换（日K/周K/月K）与「仅最近 N 根」快捷按钮。
 * 数据来自 /api/kline/<code>.json?period=…（服务端直连东财取数）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  ColorType,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type { KPeriod } from "../../lib/kline";

export type KlineBar = {
  date: string;
  open: number;
  close: number;
  high: number;
  low: number;
  vol: number;
};

const PERIODS: { key: KPeriod; label: string }[] = [
  { key: "day", label: "日K" },
  { key: "week", label: "周K" },
  { key: "month", label: "月K" },
];

const RANGE_OPTS = [
  { label: "60", bars: 60 },
  { label: "120", bars: 120 },
  { label: "全部", bars: 0 },
];

type Props = {
  code: string;
  name: string;
  initialBars?: KlineBar[];
  height?: number;
  compact?: boolean;
};

function cssVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function toTimestamp(date: string): number {
  // 东财返回 "YYYY-MM-DD"，按 UTC 解析避免时区偏移导致跨日错位
  const parsed = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}

export function InteractiveKline({ code, name, initialBars, height = 380, compact = false }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const [period, setPeriod] = useState<KPeriod>("day");
  const [range, setRange] = useState<number>(120);
  const [bars, setBars] = useState<KlineBar[]>(initialBars ?? []);
  const [loading, setLoading] = useState(!initialBars);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const barsRef = useRef<KlineBar[]>(bars);

  // 拉取指定周期 K 线数据（reloadKey 变化也会重新拉取，用于重试）
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    fetch(`/api/kline/${code}.json?period=${period}&t=${reloadKey}`, { headers: { "content-type": "application/json" } })
      .then(async (res) => {
        if (!res.ok) throw new Error(`接口 ${res.status}`);
        const data = (await res.json()) as { ok?: boolean; bars?: KlineBar[]; error?: string };
        if (!data.ok || !data.bars?.length) throw new Error(data.error || "无K线数据");
        if (cancelled) return;
        barsRef.current = data.bars;
        setBars(data.bars);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "K线取数失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [code, period, reloadKey]);

  // 初始化图表（仅一次）
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      height,
      width: container.clientWidth || 600,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: cssVar("--text-faint", "#94a3b8"),
        fontFamily: "inherit",
        attributionLogo: false,
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "rgba(148,163,184,.08)" },
        horzLines: { color: "rgba(148,163,184,.08)" },
      },
      rightPriceScale: { borderColor: "rgba(148,163,184,.2)" },
      timeScale: {
        borderColor: "rgba(148,163,184,.2)",
        timeVisible: false,
        secondsVisible: false,
        // 关键：开启滚轮缩放 + 拖拽平移
        rightOffset: 4,
        barSpacing: 7,
        minBarSpacing: 2,
      },
      crosshair: { mode: 0 },
      handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
    });
    chartRef.current = chart;

    const candle = chart.addSeries(CandlestickSeries, {
      upColor: cssVar("--up", "#ef4444"),
      downColor: cssVar("--down", "#22c55e"),
      borderUpColor: cssVar("--up", "#ef4444"),
      borderDownColor: cssVar("--down", "#22c55e"),
      wickUpColor: cssVar("--up", "#ef4444"),
      wickDownColor: cssVar("--down", "#22c55e"),
      priceFormat: { type: "price", precision: 2, minMove: 0.01 },
    });
    candleRef.current = candle;

    // 成交量柱（副图下方）
    const vol = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "",
      lastValueVisible: false,
      priceLineVisible: false,
    });
    chart.priceScale("").applyOptions({ scaleMargins: { top: 0.78, bottom: 0 } });
    volRef.current = vol;

    const onResize = () => chart.applyOptions({ width: container.clientWidth || 600 });
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      volRef.current = null;
    };
  }, [height]);

  // bars 变化时更新图表 + 应用可见窗口
  useEffect(() => {
    const candle = candleRef.current;
    const vol = volRef.current;
    const chart = chartRef.current;
    if (!candle || !vol || !chart || !bars.length) return;

    const candleData = bars.map((b) => ({
      time: toTimestamp(b.date) as UTCTimestamp,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
    }));
    const volData = bars.map((b) => ({
      time: toTimestamp(b.date) as UTCTimestamp,
      value: b.vol,
      color: b.close >= b.open ? "rgba(239,68,68,.45)" : "rgba(34,197,94,.45)",
    }));

    candle.setData(candleData as { time: Time; open: number; high: number; low: number; close: number }[]);
    vol.setData(volData);

    // 应用可见窗口：range>0 显示最近 N 根，否则显示全部
    const visible = range > 0 ? Math.min(range, bars.length) : bars.length;
    chart.timeScale().setVisibleLogicalRange({ from: bars.length - visible, to: bars.length - 1 });
  }, [bars, range]);

  // 顶部提示：现价 + 周期切换 + 范围快捷按钮
  const latest = bars.length ? bars[bars.length - 1] : null;
  const latestPct =
    latest && bars.length >= 2 ? ((latest.close - bars[bars.length - 2].close) / bars[bars.length - 2].close) * 100 : null;

  return (
    <div className="interactive-kline" style={{ width: "100%", display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      {/* 工具栏 */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 6, minWidth: 0 }}>
          <span style={{ fontWeight: 600, color: "var(--text)", fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 120 }}>{name}</span>
          <span style={{ fontFamily: "var(--font-mono)", color: "var(--muted)", fontSize: 11 }}>{code}</span>
          {latest && (
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 500, color: "var(--up)" }}>
              {latest.close.toFixed(2)}
              {latestPct != null && <span style={{ fontSize: 11, marginLeft: 4 }}>({latestPct >= 0 ? "+" : ""}{latestPct.toFixed(2)}%)</span>}
            </span>
          )}
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
          <div style={{ display: "flex", gap: 2, background: "rgba(255,255,255,.05)", borderRadius: 8, padding: 2 }}>
            {PERIODS.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => setPeriod(p.key)}
                style={{
                  background: period === p.key ? "var(--accent)" : "transparent",
                  color: period === p.key ? "#04121a" : "var(--muted)",
                  border: "none",
                  borderRadius: 6,
                  padding: "2px 10px",
                  fontSize: 11.5,
                  cursor: "pointer",
                  fontFamily: "var(--font-sans)",
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 2, background: "rgba(255,255,255,.05)", borderRadius: 8, padding: 2 }}>
            {RANGE_OPTS.map((r) => (
              <button
                key={r.label}
                type="button"
                onClick={() => setRange(r.bars)}
                style={{
                  background: range === r.bars ? "var(--accent)" : "transparent",
                  color: range === r.bars ? "#04121a" : "var(--muted)",
                  border: "none",
                  borderRadius: 6,
                  padding: "2px 8px",
                  fontSize: 11.5,
                  cursor: "pointer",
                  fontFamily: "var(--font-mono)",
                }}
              >
                {r.label}
              </button>
            ))}
          </div>
          {!compact && (
            <span style={{ fontSize: 10.5, color: "var(--muted)" }}>滚轮缩放 · 拖拽平移</span>
          )}
        </div>
      </div>

      {/* 图表区 */}
      <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
        {loading && (
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--muted)", fontSize: 13 }}>
            加载 K 线数据…
          </div>
        )}
        {error && !loading && (
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, color: "var(--muted)", fontSize: 13 }}>
            <div>无法获取 {name}（{code}）K 线数据</div>
            <div style={{ fontSize: 11, color: "rgba(255,107,107,.7)" }}>{error}</div>
            <button
              type="button"
              onClick={() => setReloadKey((n) => n + 1)}
              style={{
                background: "rgba(255,255,255,.06)", border: "0.5px solid var(--border)", color: "var(--text)",
                borderRadius: 999, padding: "4px 14px", fontSize: 12, cursor: "pointer", fontFamily: "var(--font-sans)",
              }}
            >
              重试
            </button>
          </div>
        )}
        <div ref={containerRef} style={{ width: "100%", height: "100%", opacity: loading || error ? 0 : 1 }} />
      </div>
    </div>
  );
}
