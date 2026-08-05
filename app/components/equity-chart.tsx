"use client";
import { useEffect, useRef } from "react";
import {
  createChart,
  ColorType,
  AreaSeries,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type { EquityPoint } from "../../lib/domain/trade-statistics";

type EquityCurveChartProps = {
  title: string;
  points: EquityPoint[];
  height?: number;
};

/**
 * lightweight-charts 在 canvas 上渲染，无法解析 CSS 变量（var(--x)），
 * 必须在运行时把设计令牌解析成真实颜色字符串。主题切换（明/暗）时
 * 重渲染图表即可重新读取当前生效的值。
 */
function cssVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function toTimestamp(date: string): number {
  const parsed = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}

/**
 * 权益曲线（Equity curve）用 lightweight-charts 渲染。
 * 自动按日期去重（同一天多笔资金/盈亏事件只保留当日累计值），
 * 图表所在的父容器可被整体导出为图片/PDF。
 */
export function EquityCurveChart({ title, points, height = 220 }: EquityCurveChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      height,
      width: container.clientWidth || 600,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: cssVar("--text-faint", "#3f5668"),
        fontFamily: "inherit",
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: cssVar("--line", "rgba(120,200,255,.12)") },
        horzLines: { color: cssVar("--line", "rgba(120,200,255,.12)") },
      },
      rightPriceScale: { borderColor: cssVar("--line-strong", "rgba(120,200,255,.22)") },
      timeScale: { borderColor: cssVar("--line-strong", "rgba(120,200,255,.22)"), timeVisible: false, secondsVisible: false },
      crosshair: { mode: 0 },
      handleScale: false,
      handleScroll: false,
    });

    const series = chart.addSeries(AreaSeries, {
      lineColor: cssVar("--accent", "#00e5ff"),
      topColor: cssVar("--accent-soft", "rgba(0,229,255,.12)"),
      bottomColor: "transparent",
      lineWidth: 2,
      priceFormat: {
        type: "custom",
        minMove: 1,
        formatter: (price: number) => `¥${Math.round(price).toLocaleString("zh-CN")}`,
      },
    });

    const data = buildSeriesData(points);
    series.setData(data);
    if (data.length) chart.timeScale().setVisibleLogicalRange({ from: -0.5, to: data.length - 0.5 });

    const onResize = () => chart.applyOptions({ width: container.clientWidth || 600 });
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      chart.remove();
    };
  }, [points, height]);

  return (
    <div
      className="equity-chart"
      ref={containerRef}
      role="img"
      aria-label={title}
    />
  );
}

function buildSeriesData(points: EquityPoint[]): Array<{ time: Time; value: number }> {
  const byTime = new Map<number, number>();
  for (const point of points) {
    if (point.date === "起点") continue;
    const ts = toTimestamp(point.date);
    byTime.set(ts, point.equityCents / 100);
  }
  return [...byTime.entries()]
    .sort(([a], [b]) => a - b)
    .map(([ts, value]) => ({ time: ts as UTCTimestamp, value }));
}
