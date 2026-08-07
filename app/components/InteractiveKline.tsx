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
  LineType,
  TickMarkType,
  createSeriesMarkers,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type LineStyle,
  type LineWidth,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
// 注意：isIntraday 是运行时函数，必须用值导入。
// 若混进 `import type`，整行会在编译期被擦除，调用处会抛 ReferenceError，
// 进而中断本次 commit 的后续 effect（周期切换的取数 effect 收不到执行）。
import { isIntraday } from "../../lib/kline";
import type { KPeriod, KIntradayPeriod, Markers } from "../../lib/kline";

export type KlineBar = {
  date: string;
  open: number;
  close: number;
  high: number;
  low: number;
  vol: number;
  amount?: number;
};

/**
 * 持有价格线实例 + 元数据的 ref 类型。
 * LineSpec 在 effect 内闭包定义，为补 ref 类型可读，这里提到模块层只读骨架。
 */
type PriceLineEntry = {
  key: MarkerKey;
  line: IPriceLine;
  label: string;
  color: string;
  price: number;
  baseWidth: LineWidth;
  baseStyle: LineStyle;
};
/**
 * 5 条 marker 价格线在图例和 hover 高亮逻辑里共享的 key。
 */
export type MarkerKey = "top" | "breakout" | "price" | "retest" | "support";

const PERIODS: { key: KPeriod | KIntradayPeriod; label: string }[] = [
  { key: "day", label: "日K" },
  { key: "week", label: "周K" },
  { key: "month", label: "月K" },
  { key: "60m", label: "60分" },
  { key: "30m", label: "30分" },
  { key: "15m", label: "15分" },
  { key: "5m", label: "5分" },
  { key: "dn", label: "分时" },
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
  /** 是否撑满父容器高度（大屏场景推荐）。若为 true，height 参数失效。 */
  fillParent?: boolean;
};

function cssVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function toTimestamp(date: string): number {
  // 分钟级分时形如 "2026-08-07 14:30" 或 "2026-08-07 14:30:00"；按本地时间解析避免错位
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(date)) {
    const normalized = date.replace(" ", "T") + (date.length <= 16 ? ":00" : "");
    const parsedLocal = Date.parse(normalized);
    if (Number.isFinite(parsedLocal)) return Math.floor(parsedLocal / 1000);
  }
  // 东财日/周K返回 "YYYY-MM-DD"，月K可能返回 "YYYY-MM"；统一补全为月初第1日再按 UTC 解析，避免时区偏移跨日错位
  const normalized = /^\d{4}-\d{2}$/.test(date) ? `${date}-01` : date;
  const parsed = Date.parse(`${normalized}T00:00:00Z`);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}

/**
 * 把 rgba 颜色提到完全不透明（如有 alpha），便于 hover 高亮时颜色识别度提升。
 * 仅处理形如 "rgba(r,g,b,a)" 或 "rgb(r,g,b)" 的简单字符串，保守失败时原样返回。
 */
function brightenColor(input: string): string {
  const m = input.match(/^rgba?\(([^)]+)\)$/i);
  if (!m) return input;
  const parts = m[1].split(",").map((p) => p.trim());
  if (parts.length < 3) return input;
  return `rgb(${parts[0]}, ${parts[1]}, ${parts[2]})`;
}

/**
 * 价格线宽：1→2, 2→3, 3→4, 4→4（封顶）
 */
function bumpWidth(width: LineWidth): LineWidth {
  const v = width as number;
  const next = Math.min(4, v + 1);
  return next as LineWidth;
}

export function InteractiveKline({ code, name, initialBars, height = 480, compact = false, fillParent = false }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  // 容器尺寸缓存（避免在 render 期间访问 ref 触发 react-hooks/refs 告警）；由 fill-parent 同步逻辑更新。
  const [containerSize, setContainerSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const maRefs = useRef<Record<number, ISeriesApi<"Line"> | null>>({});
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const lineSpecsRef = useRef<PriceLineEntry[]>([]);
  // 往前推第 20 日蜡烛的标记插件实例
  const day20MarkersRef = useRef<ReturnType<typeof createSeriesMarkers<Time>> | null>(null);
  // 20MA 扣抵价水平线（lightweight-charts priceLine 实例）
  const deductLineRef = useRef<IPriceLine | null>(null);
  // 与 lineSpecsRef 镜像的 state：仅在 render 中消费图例数据时使用，避免在渲染期读取 ref。
  const [lineSpecs, setLineSpecs] = useState<PriceLineEntry[]>([]);
  const [period, setPeriod] = useState<KPeriod | KIntradayPeriod>("day");
  const [range, setRange] = useState<number>(120);
  const [bars, setBars] = useState<KlineBar[]>(initialBars ?? []);
  // 20MA 扣抵价（bar[bars.length-20] 的收盘），用于图例显示与状态判断。
  // 用 useMemo 推导而非 effect 内 setState，避免同步 setState 触发级联渲染与 lint 报错。
  const deductPrice = useMemo<number | null>(() => {
    const didx = bars.length - 20;
    return didx >= 0 ? bars[didx].close : null;
  }, [bars]);
  const [markers, setMarkers] = useState<Markers | null>(null);
  const [loading, setLoading] = useState(!initialBars);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [hoveredMarker, setHoveredMarker] = useState<MarkerKey | null>(null);
  const [legendPos, setLegendPos] = useState<{ left: number; top: number } | null>(null);
  const [legendExpanded, setLegendExpanded] = useState(false);
  // 当 fillParent=true 时，图表高度跟随父容器；否则使用传入的 height prop。
  const [chartHeight, setChartHeight] = useState(fillParent ? 0 : height);
  const [dragging, setDragging] = useState(false);
  const dragStateRef = useRef<{ startX: number; startY: number; originLeft: number; originTop: number } | null>(null);
  const legendRef = useRef<HTMLDivElement>(null);
  const barsRef = useRef<KlineBar[]>(bars);
  // 十字光标悬浮面板：跟随鼠标显示当前 K 线的 OHLC / 涨跌幅 / 成交量 / 各周期均线值。
  // 解决「鼠标划进 K 线图看不见任何数据」的体验缺失（其他炒股软件均有此悬浮窗）。
  const [crosshair, setCrosshair] = useState<{
    bar: KlineBar;
    prevClose: number | null;
    ma: { p: number; v: number }[];
    x: number;
    y: number;
  } | null>(null);

  // 拖拽图例：在图表区域内自由移动；松手后坐标持久于 legendPos，复位用双击
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const state = dragStateRef.current;
      if (!state) return;
      const container = containerRef.current?.parentElement;
      const legend = legendRef.current;
      let left = state.originLeft + (e.clientX - state.startX);
      let top = state.originTop + (e.clientY - state.startY);
      if (container && legend) {
        const rect = container.getBoundingClientRect();
        const maxLeft = rect.width - legend.offsetWidth;
        const maxTop = rect.height - legend.offsetHeight;
        left = Math.max(0, Math.min(left, Math.max(0, maxLeft)));
        top = Math.max(0, Math.min(top, Math.max(0, maxTop)));
      }
      setLegendPos({ left, top });
    };
    const onUp = () => {
      dragStateRef.current = null;
      setDragging(false);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging]);

  const startDrag = (e: React.MouseEvent) => {
    if (!legendExpanded) return;
    e.preventDefault();
    const container = containerRef.current?.parentElement;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const legend = legendRef.current;
    if (!legend) return;
    const legendRect = legend.getBoundingClientRect();
    const originLeft = legendRect.left - rect.left;
    const originTop = legendRect.top - rect.top;
    dragStateRef.current = { startX: e.clientX, startY: e.clientY, originLeft, originTop };
    setLegendPos({ left: originLeft, top: originTop });
    setDragging(true);
  };

  // 分时周期需要显示时间轴（时分），日/周/月仅显示日期。周期切换时同步更新 timeScale。
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const intraday = isIntraday(period);
    chart.applyOptions({
      timeScale: {
        timeVisible: intraday,
        secondsVisible: false,
      },
    });
  }, [period]);

  // 拉取指定周期 K 线数据 + markers（reloadKey 变化也会重新拉取，用于重试）
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/kline/${code}.json?period=${period}&t=${reloadKey}`, { headers: { "content-type": "application/json" } })
      .then(async (res) => {
        // 进入异步回调后再标记加载态，避免在 effect 体内同步 setState 触发级联渲染
        setLoading(true);
        setError("");
        if (!res.ok) throw new Error(`接口 ${res.status}`);
        const data = (await res.json()) as { ok?: boolean; bars?: KlineBar[]; markers?: Markers; error?: string };
        if (!data.ok || !data.bars?.length) throw new Error(data.error || "无K线数据");
        if (cancelled) return;
        barsRef.current = data.bars;
        setBars(data.bars);
        setMarkers(data.markers ?? null);
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

  // fillParent=true 时：监听父容器高度变化并同步到图表。
  useEffect(() => {
    if (!fillParent) return;
    const parent = containerRef.current?.parentElement;
    if (!parent) return;
    const sync = () => {
      const h = parent.clientHeight;
      if (h > 0) setChartHeight(h);
      setContainerSize({ w: parent.clientWidth || 0, h });
    };
    sync();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(sync) : null;
    ro?.observe(parent);
    return () => ro?.disconnect();
  }, [fillParent]);

  // 初始化图表（仅一次）
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      height: chartHeight || height,
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
        tickMarkFormatter: (time: Time, tickMarkType: TickMarkType) => {
          const ts = typeof time === "number" ? time * 1000 : Date.parse(String(time));
          const d = new Date(ts);
          const yyyy = d.getFullYear();
          const M = d.getMonth() + 1;
          const dd = String(d.getDate()).padStart(2, "0");
          const HH = String(d.getHours()).padStart(2, "0");
          const mm = String(d.getMinutes()).padStart(2, "0");
          // 分时模式（timeVisible 生效时）用 HH:mm 标注时间轴
          if (tickMarkType === TickMarkType.Time || tickMarkType === TickMarkType.TimeWithSeconds) {
            return `${HH}:${mm}`;
          }
          switch (tickMarkType) {
            case TickMarkType.Year:
              return `${yyyy}年`;
            case TickMarkType.Month:
              return `${yyyy}年${M}月`;
            case TickMarkType.DayOfMonth:
              return `${M}月${dd}日`;
            default:
              return `${M}月${dd}日`;
          }
        },
      },
      crosshair: { mode: 0 },
      handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
    });
    chartRef.current = chart;

    // 十字光标移动 → 显示悬浮数据窗（开/高/低/收/涨跌幅/量/各均线）。
    // 用 param.time 反查对应 K 线；param.time 为 null（移出图表）时清空面板。
    const maPeriods = [5, 10, 20, 60];
    const onCrosshairMove = (param: Parameters<Parameters<IChartApi["subscribeCrosshairMove"]>[0]>[0]) => {
      const t = param.time;
      if (t == null) {
        setCrosshair(null);
        return;
      }
      const list = barsRef.current;
      if (!list.length) {
        setCrosshair(null);
        return;
      }
      // lightweight-charts v5 的 time 为 UTCTimestamp（秒）或 business day 对象；
      // 这里把 bars 的时间戳全部算成秒后定位最近的索引。
      const target = typeof t === "number" ? t : Math.floor(Date.parse(`${t}`) / 1000);
      let idx = -1;
      for (let i = 0; i < list.length; i++) {
        if (toTimestamp(list[i].date) === target) {
          idx = i;
          break;
        }
      }
      if (idx < 0) {
        // 分时/非整日对齐时退而求其次：取光标逻辑索引（param.logical 可能更准确）
        const li = typeof param.logical === "number" ? param.logical : -1;
        idx = li >= 0 && li < list.length ? li : list.length - 1;
      }
      const bar = list[idx];
      const prevClose = idx > 0 ? list[idx - 1].close : null;
      const closes = list.map((b) => b.close);
      const ma = maPeriods.map((p) => {
        let sum = 0;
        let n = 0;
        for (let j = idx - p + 1; j <= idx; j++) {
          if (j >= 0) {
            sum += closes[j];
            n++;
          }
        }
        return { p, v: n ? sum / n : bar.close };
      });
      setCrosshair({ bar, prevClose, ma, x: param.point?.x ?? 0, y: param.point?.y ?? 0 });
    };
    chart.subscribeCrosshairMove(onCrosshairMove);

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

    // 均线 MA5/10/20/60（叠加在主图蜡烛之上）
    const maColors: Record<number, string> = {
      5: "#f5b301",
      10: "#4f9bff",
      20: "#e879f9",
      60: "#34d399",
    };
    for (const period of [5, 10, 20, 60]) {
      const ma = chart.addSeries(LineSeries, {
        color: maColors[period],
        lineWidth: 1 as LineWidth,
        lineType: LineType.Simple,
        priceLineVisible: false,
        lastValueVisible: true,
        crosshairMarkerVisible: false,
        title: `MA${period}`,
      });
      maRefs.current[period] = ma;
    }

    const onResize = () => chart.applyOptions({ width: container.clientWidth || 600, height: chartHeight || height });
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      priceLinesRef.current = [];
      day20MarkersRef.current = null;
      deductLineRef.current = null;
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      volRef.current = null;
      maRefs.current = {};
    };
  }, []);

  // 图表高度同步：fillParent 时父容器高度变化，或 height prop 变化，都更新图表尺寸。
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.applyOptions({ height: chartHeight || height });
  }, [chartHeight, height]);

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

    // 切换周期（日/周/月）时，先清空再写入，避免跨周期时间轴冲突导致 setData 静默失败、图表不更新。
    // 用 try/catch 兜住，单个 setData 异常不应阻断其余渲染。
    try {
      candle.setData([]);
      vol.setData([]);
      for (const period of [5, 10, 20, 60]) {
        const ma = maRefs.current[period];
        if (ma) ma.setData([]);
      }
      candle.setData(candleData as { time: Time; open: number; high: number; low: number; close: number }[]);
      vol.setData(volData);

      // 计算并填充均线 MA5/10/20/60
      const closes = bars.map((b) => b.close);
      for (const period of [5, 10, 20, 60]) {
        const ma = maRefs.current[period];
        if (!ma) continue;
        const maData: { time: Time; value: number }[] = [];
        for (let i = period - 1; i < bars.length; i++) {
          let sum = 0;
          for (let j = i - period + 1; j <= i; j++) sum += closes[j];
          maData.push({ time: toTimestamp(bars[i].date) as UTCTimestamp, value: sum / period });
        }
        ma.setData(maData);
      }
    } catch (e) {
      // 数据时间轴异常时降级：保留现有图表，不阻断视图
      if (process.env.NODE_ENV !== "production") console.warn("[InteractiveKline] setData failed:", e);
    }

    // 应用可见窗口：range>0 显示最近 N 根，否则显示全部。
    // 若 setVisibleLogicalRange 失败（跨周期时间轴未就绪），回退 fitContent 保证图表可见。
    const visible = range > 0 ? Math.min(range, bars.length) : bars.length;
    try {
      chart.timeScale().setVisibleLogicalRange({ from: bars.length - visible, to: bars.length - 1 });
    } catch {
      try {
        chart.timeScale().fitContent();
      } catch {
        /* 忽略时间轴范围设置异常 */
      }
    }

    // 标记「往前推第 20 日」的蜡烛：取最新一根往前数第 20 根（索引 bars.length-1-20）。
    // 仅当数据足够（>=21 根）时绘制，避免无效时间轴位置。
    try {
      if (!day20MarkersRef.current) {
        day20MarkersRef.current = createSeriesMarkers(candle, []);
      }
      const markersPlugin = day20MarkersRef.current;
      const idx = bars.length - 1 - 20;
      if (idx >= 0) {
        const bar = bars[idx];
        const marker: SeriesMarker<Time> = {
          time: toTimestamp(bar.date) as UTCTimestamp,
          position: "aboveBar",
          shape: "circle",
          color: "#f59e0b",
          text: "第20日",
          size: 1,
        };
        markersPlugin.setMarkers([marker]);
      } else {
        markersPlugin.setMarkers([]);
      }
    } catch {
      /* 标记插件异常时降级，不阻断图表 */
    }

    // 20MA 扣抵价：20 日均线「明天」要扣掉的那个收盘价 = 最新一根往前数第 20 根（索引 bars.length-20）。
    // 当未来收盘价 > 扣抵价时 20MA 继续上行（扣抵向上=支撑），否则拐头（扣抵向下=压力）。
    // 仅当数据 >=20 根时绘制；扣抵价本身即 bar 的收盘，与 K 线时间轴天然对齐。
    try {
      if (deductLineRef.current) {
        candle.removePriceLine(deductLineRef.current);
        deductLineRef.current = null;
      }
      if (deductPrice != null) {
        deductLineRef.current = candle.createPriceLine({
          price: deductPrice,
          color: "rgba(232,121,249,.55)",
          lineWidth: 1 as LineWidth,
          lineStyle: 2, // 虚线
          axisLabelVisible: true,
          axisLabelColor: "rgba(232,121,249,.95)",
          title: "扣抵",
        });
      }
    } catch {
      /* 扣抵线异常时降级，不阻断图表 */
    }
  }, [bars, range, deductPrice]);

  /**
   * markers 变化时重建 5 条参考价格线（仅画水平线本体）。
   *   - 泡沫顶（红色实线）— isTrap 时在线右侧叠「上方套牢盘」
   *   - 突破确认位（灰色虚线）
   *   - 现价（蓝色实线，最粗）
   *   - 回踩点（灰色虚线，如有）
   *   - 双底生死线（橙色虚线）
   * 注意：lightweight-charts 价格线轴标签只能贴在右侧价格轴、且不可换行，5 条
   * 同时叠加会堆成一团遮挡 K 线、几乎看不清。本组件关闭轴标签（axisLabelVisible:false），
   * 把每条线的标签文案统一收敛到右上角图例（见下），图例中 hover 可高亮对应价格线。
   */
  useEffect(() => {
    const candle = candleRef.current;
    if (!candle || !markers) return;

    // 清除旧价格线
    for (const line of priceLinesRef.current) {
      try {
        candle.removePriceLine(line);
      } catch {
        /* 图表已卸载 */
      }
    }
    priceLinesRef.current = [];

    const mk = markers;
    const lines: IPriceLine[] = [];
    type LineSpec = {
      key: MarkerKey;
      line: IPriceLine;
      label: string;
      color: string;
      price: number;
      baseWidth: LineWidth;
      baseStyle: LineStyle;
    };
    const specs: LineSpec[] = [];

    const pushLine = (
      key: MarkerKey,
      label: string,
      price: number,
      color: string,
      lineWidth: LineWidth,
      lineStyle: LineStyle,
    ): void => {
      const line = candle.createPriceLine({
        price,
        color,
        lineWidth,
        lineStyle,
        axisLabelVisible: false,
      });
      lines.push(line);
      specs.push({ key, line, label, color, price, baseWidth: lineWidth, baseStyle: lineStyle });
    };

    // 泡沫顶（红色实线）— isTrap 时标签追加「上方套牢盘」
    pushLine(
      "top",
      mk.top.isTrap ? "泡沫顶（上套牢）" : "泡沫顶",
      mk.top.price,
      "rgba(239,68,68,.85)",
      1,
      2,
    );

    // 突破确认位（灰色虚线）
    pushLine("breakout", "突破确认位", mk.breakout, "rgba(156,163,175,.85)", 1, 2);

    // 现价（蓝色实线，最粗，单独一档便于一眼定位）
    pushLine(
      "price",
      `现价（${mk.maPos}）`,
      mk.priceNow,
      "#3b82f6",
      2,
      0,
    );

    // 回踩点（灰色虚线，如有）
    if (mk.retest) {
      pushLine("retest", "回踩点", mk.retest.price, "rgba(156,163,175,.85)", 1, 2);
    }

    // 双底生死线（橙色虚线）
    pushLine("support", "双底（生死线）", mk.support, "#f59e0b", 1, 2);

    priceLinesRef.current = lines;
    lineSpecsRef.current = specs;
    setLineSpecs(specs);
    setHoveredMarker(null);
  }, [markers]);

  /**
   * hoveredMarker 变化时切换对应价格线的视觉强度。
   * 命中者：颜色加深 + 线宽加粗；非命中者：保持基准样式。
   * 直接调 applyOptions 修改线本身的样式，不再使用 axisLabel。
   */
  useEffect(() => {
    for (const spec of lineSpecsRef.current) {
      const isActive = hoveredMarker === spec.key;
      try {
        spec.line.applyOptions({
          color: isActive ? brightenColor(spec.color) : spec.color,
          lineWidth: isActive ? bumpWidth(spec.baseWidth) : spec.baseWidth,
        });
      } catch {
        /* 图表已卸载 */
      }
    }
  }, [hoveredMarker]);

  // 顶部提示：现价 + 周期切换 + 范围快捷按钮
  const latest = bars.length ? bars[bars.length - 1] : null;

  // 图例数据：按价格从高到低，让顶部图例的自然顺序与价格轴自上而下的位置接近。
  const legendItems: Array<{ key: MarkerKey; label: string; price: number; color: string; baseWidth: LineWidth }> = lineSpecs
    .map((spec) => ({ key: spec.key, label: spec.label, price: spec.price, color: spec.color, baseWidth: spec.baseWidth }))
    .sort((a, b) => b.price - a.price);

  return (
    <div className="interactive-kline" style={{ width: "100%", display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      {/* 工具栏 */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 6, minWidth: 0 }}>
          <span style={{ fontWeight: 600, color: "var(--text)", fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 120 }}>{name}</span>
          <span style={{ fontFamily: "var(--font-mono)", color: "var(--muted)", fontSize: 11 }}>{code}</span>
          {latest && (
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 500, color: "var(--text)" }}>
              {latest.close.toFixed(2)}
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

        {/* Marker 图例：默认折叠为右上角小按钮，点击展开后显示参考线标签+价格。
            展开状态可拖动、双击复位；关闭按钮可收起，彻底解决默认遮挡 K 线的问题。 */}
        {!loading && !error && legendItems.length > 0 && (
          <>
            {!legendExpanded && (
              <button
                type="button"
                onClick={() => setLegendExpanded(true)}
                title="显示指标参考线"
                style={{
                  position: "absolute",
                  top: 8,
                  right: 8,
                  width: 26,
                  height: 26,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: 6,
                  border: "0.5px solid rgba(148,163,184,.25)",
                  background: "rgba(8,16,28,.72)",
                  backdropFilter: "blur(6px)",
                  WebkitBackdropFilter: "blur(6px)",
                  color: "var(--text)",
                  cursor: "pointer",
                  pointerEvents: "auto",
                  zIndex: 2,
                  padding: 0,
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="3" y1="8" x2="21" y2="8" />
                  <line x1="3" y1="12" x2="21" y2="12" />
                  <line x1="3" y1="16" x2="21" y2="16" />
                </svg>
              </button>
            )}

            {/* 十字光标悬浮数据窗：跟随鼠标显示该根 OHLC / 涨跌幅 / 成交量 / 各均线 */}
            {crosshair && (() => {
              const W = containerSize.w;
              const H = containerSize.h;
              const offset = 16;
              const panelW = 230;
              const panelH = 132;
              // 默认贴在光标右下方；靠近右/下边缘时翻转到光标左上方，避免出界。
              const left = crosshair.x + offset + panelW > W ? crosshair.x - offset - panelW : crosshair.x + offset;
              const top = crosshair.y + offset + panelH > H ? crosshair.y - offset - panelH : crosshair.y + offset;
              return (
              <div
                style={{
                  position: "absolute",
                  top,
                  left,
                  padding: "7px 10px",
                  background: "rgba(8,16,28,.78)",
                  backdropFilter: "blur(6px)",
                  WebkitBackdropFilter: "blur(6px)",
                  border: "0.5px solid rgba(148,163,184,.28)",
                  borderRadius: 8,
                  boxShadow: "0 4px 16px rgba(0,0,0,.32)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 3,
                  minWidth: 168,
                  maxWidth: 240,
                  pointerEvents: "none",
                  zIndex: 3,
                  fontFamily: "var(--font-mono)",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 11, color: "var(--text)" }}>
                  <span>{crosshair.bar.date}</span>
                  <span style={{ color: "var(--accent, #6ea8fe)", fontWeight: 600 }}>
                    {PERIODS.find((p) => p.key === period)?.label ?? period}
                  </span>
                </div>
                {crosshair.prevClose != null && (() => {
                  const chg = crosshair.bar.close - crosshair.prevClose;
                  const pct = (chg / (crosshair.prevClose || 1)) * 100;
                  const up = chg >= 0;
                  return (
                    <div style={{ fontSize: 12, fontWeight: 600, color: up ? "var(--up)" : "var(--down)" }}>
                      {crosshair.bar.close.toFixed(2)}　{up ? "+" : ""}{chg.toFixed(2)}　{up ? "+" : ""}{pct.toFixed(2)}%
                    </div>
                  );
                })()}
                <div style={{ display: "grid", gridTemplateColumns: "auto auto", gap: "1px 12px", fontSize: 10.5, color: "var(--muted)" }}>
                  <span>开 {crosshair.bar.open.toFixed(2)}</span>
                  <span>高 {crosshair.bar.high.toFixed(2)}</span>
                  <span>低 {crosshair.bar.low.toFixed(2)}</span>
                  <span>收 {crosshair.bar.close.toFixed(2)}</span>
                  {crosshair.bar.vol != null && (() => {
                    const realAmt = crosshair.bar.amount;
                    const estAmt = ((crosshair.bar.vol * (crosshair.bar.open + crosshair.bar.close)) / 2) / 1e8;
                    const amtYi = (realAmt != null && !Number.isNaN(realAmt) ? realAmt / 1e8 : estAmt);
                    const isEstimated = !(realAmt != null && !Number.isNaN(realAmt));
                    return (
                      <>
                        <span style={{ gridColumn: "1 / -1" }}>量 {(crosshair.bar.vol / 100).toLocaleString("zh-CN", { maximumFractionDigits: 0 })} 手</span>
                        <span style={{ gridColumn: "1 / -1" }}>
                          额 {amtYi.toLocaleString("zh-CN", { maximumFractionDigits: 2 })} 亿元{isEstimated ? "（约）" : ""}
                        </span>
                      </>
                    );
                  })()}
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "2px 8px", marginTop: 2, paddingTop: 3, borderTop: "0.5px solid rgba(148,163,184,.15)", fontSize: 10, color: "var(--text)" }}>
                  {crosshair.ma.map((m) => (
                    <span key={m.p} style={{ color: "var(--ma" + m.p + ")" } as React.CSSProperties}>
                      MA{m.p} {m.v.toFixed(2)}
                    </span>
                  ))}
                </div>
              </div>
              );
            })()}

            {legendExpanded && (
              <div
                ref={legendRef}
                className="kline-marker-legend"
                onMouseDown={startDrag}
                onDoubleClick={() => { setLegendPos(null); }}
                title={dragging ? "拖动中…" : "拖动可移动图例，双击复位"}
                style={{
                  position: "absolute",
                  ...(legendPos
                    ? { left: legendPos.left, top: legendPos.top, right: "auto" }
                    : { top: 8, right: 8 }),
                  padding: "8px 10px",
                  background: "rgba(8,16,28,.72)",
                  backdropFilter: "blur(6px)",
                  WebkitBackdropFilter: "blur(6px)",
                  border: "0.5px solid rgba(148,163,184,.25)",
                  borderRadius: 8,
                  boxShadow: "0 4px 16px rgba(0,0,0,.28)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                  minWidth: 132,
                  maxWidth: 220,
                  pointerEvents: "auto",
                  zIndex: 2,
                  cursor: dragging ? "grabbing" : "grab",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    marginBottom: 2,
                    padding: "0 2px",
                    borderBottom: "0.5px solid rgba(148,163,184,.15)",
                    paddingBottom: 4,
                  }}
                >
                  <span style={{ fontSize: 10, color: "var(--muted)", fontWeight: 500 }}>指标参考线</span>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setLegendExpanded(false); setLegendPos(null); }}
                    onMouseDown={(e) => e.stopPropagation()}
                    title="收起"
                    style={{
                      width: 16,
                      height: 16,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      border: "none",
                      background: "transparent",
                      color: "var(--muted)",
                      cursor: "pointer",
                      borderRadius: 4,
                      padding: 0,
                    }}
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>
                {legendItems.map((item) => {
                  const active = hoveredMarker === item.key;
                  const dimmed = hoveredMarker !== null && !active;
                  return (
                    <div
                      key={item.key}
                      onMouseEnter={() => !dragging && setHoveredMarker(item.key)}
                      onMouseLeave={() => !dragging && setHoveredMarker((curr) => (curr === item.key ? null : curr))}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        padding: "2px 4px",
                        borderRadius: 4,
                        cursor: "pointer",
                        opacity: dimmed ? 0.45 : 1,
                        background: active ? "rgba(255,255,255,.06)" : "transparent",
                        transition: "opacity .15s, background .15s",
                      }}
                      title={`高亮 K 线上的「${item.label}」`}
                    >
                      <span
                        style={{
                          width: 10,
                          height: 2,
                          background: item.color,
                          borderRadius: 1,
                          flexShrink: 0,
                          display: "inline-block",
                        }}
                      />
                      <span style={{ fontSize: 11, color: "var(--text)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {item.label}
                      </span>
                      <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text)", fontWeight: 500 }}>
                        {item.price.toFixed(2)}
                      </span>
                    </div>
                  );
                })}

                {/* 20MA 扣抵区块：与 marker 参考线分隔，单独展示扣抵价与多空状态 */}
                {deductPrice != null && latest && (
                  <div style={{ marginTop: 4, paddingTop: 6, borderTop: "0.5px solid rgba(148,163,184,.15)" }}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        padding: "2px 4px",
                        borderRadius: 4,
                      }}
                      title="20MA 扣抵价 = 20 根前那根收盘；现价在其上为扣抵向上(支撑)，在其下为扣抵向下(压力)"
                    >
                      <span
                        style={{
                          width: 10,
                          height: 0,
                          borderTop: "2px dashed rgba(232,121,249,.85)",
                          borderRadius: 1,
                          flexShrink: 0,
                          display: "inline-block",
                        }}
                      />
                      <span style={{ fontSize: 11, color: "var(--text)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        20MA扣抵
                      </span>
                      <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text)", fontWeight: 500 }}>
                        {deductPrice.toFixed(2)}
                      </span>
                    </div>
                    <div
                      style={{
                        fontSize: 10,
                        padding: "1px 4px 0",
                        color: latest.close >= deductPrice ? "var(--up)" : "var(--down)",
                      }}
                    >
                      {latest.close >= deductPrice
                        ? "现价>扣抵 · 明日MA20拐头↑(助涨)"
                        : "现价<扣抵 · 明日MA20拐头↓(承压)"}
                    </div>
                    <div style={{ fontSize: 9.5, padding: "1px 4px 0", color: "var(--muted)" }}>
                      拐头条件：明日收盘 &gt; 扣抵价则MA20上行
                    </div>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
