"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createChart,
  ColorType,
  LineSeries,
  type UTCTimestamp,
} from "lightweight-charts";
import {
  SectionHeader,
  Stat,
  Card,
  CardHeader,
  Tag,
  Banner,
  Hint,
  Spinner,
} from "./components";
import { ScreenerConfigPanel, type ScreenerOverrides } from "./ScreenerConfigPanel";

/* ----------------------------- 数据类型 ----------------------------- */
export type ScanSelected = {
  code: string;
  name: string;
  score: number;
  momentum: number;
  peTtm: number;
  pb: number;
  turnover: number;
  signals: number;
  /** 新增因子维度（丰富选股策略）；旧 payload 可能缺失，故可选 */
  rsi?: number;
  riskAdjMomentum?: number;
  trend?: number;
  factors?: Record<string, number>;
  /** 行业（行业分散约束）；旧 payload 可能缺失，故可选 */
  sector?: string;
};
type ScanMetrics = {
  totalReturn: number;
  annualReturn: number;
  sharpe: number;
  maxDrawdown: number;
  winRate: number;
  trades: number;
};
type ScanSignal = { fastMa: number; slowMa: number };
type ScanGridItem = {
  fastMa: number;
  slowMa: number;
  metric: number;
  totalReturn: number;
  maxDrawdown: number;
};
type Scan = {
  generatedAt: string;
  period: { beg: string; end: string };
  universeSize: number;
  selectedCount: number;
  selected: ScanSelected[];
  backtest: {
    baseSignal: ScanSignal;
    baseMetrics: ScanMetrics;
    finalSignal: ScanSignal;
    finalMetrics: ScanMetrics;
    optimized?: {
      bestSignal: ScanSignal;
      bestMetrics: ScanMetrics;
      sharpeImprovement: number;
      grid: ScanGridItem[];
    };
  };
  equityCurve: Array<{ date: string; value: number }>;
  marketState?: {
    state: string;
    positionFactor: number;
    score: number;
    detail: string;
    maGap: number;
    momentum: number;
  };
  disclaimer: string;
};

function pct(x: number): string {
  return `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`;
}

/**
 * lightweight-charts 在 canvas 上渲染，无法解析 CSS 变量（var(--x)），
 * 必须在运行时把设计令牌解析成真实颜色字符串。
 */
function cssVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

const SCAN_LINE = () => cssVar("--accent", "#3a5a78");
const SCAN_TEXT = () => cssVar("--text-muted", "#8c8c83");
const SCAN_BORDER = () => cssVar("--line-strong", "#d8d8d0");
const SCAN_GRID = () => cssVar("--line", "#e8e8e1");

/* --------------------------- 净值曲线组件 --------------------------- */
function StrategyCurveChart({ points }: { points: Array<{ date: string; value: number }> }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const container = ref.current;
    if (!container || !points || points.length === 0) return;
    const chart = createChart(container, {
      height: 240,
      width: container.clientWidth || 600,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: SCAN_TEXT(),
        fontFamily: "inherit",
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: SCAN_GRID() },
        horzLines: { color: SCAN_GRID() },
      },
      rightPriceScale: { borderColor: SCAN_BORDER() },
      timeScale: { borderColor: SCAN_BORDER(), timeVisible: false, secondsVisible: false },
      crosshair: { mode: 0 },
      handleScale: false,
      handleScroll: false,
    });
    const series = chart.addSeries(LineSeries, {
      color: SCAN_LINE(),
      lineWidth: 2,
      priceFormat: { type: "custom", minMove: 0.0001, formatter: (p: number) => p.toFixed(4) },
    });
    const data = points
      .map((p) => ({
        time: (Date.parse(`${p.date}T00:00:00Z`) / 1000) as UTCTimestamp,
        value: p.value,
      }))
      .sort((a, b) => (a.time as number) - (b.time as number));
    series.setData(data);
    if (data.length) chart.timeScale().setVisibleLogicalRange({ from: -0.5, to: data.length - 0.5 });

    // 用 ResizeObserver 让宽度随卡片自适应，避免首帧 clientWidth 为 0 时
    // 以固定 600 宽创建、布局稳定后再跳变宽度造成的页面闪烁。
    const syncWidth = () => {
      const w = container.clientWidth;
      if (w) chart.applyOptions({ width: w });
    };
    syncWidth();
    const ro = new ResizeObserver(syncWidth);
    ro.observe(container);
    return () => {
      ro.disconnect();
      chart.remove();
    };
  }, [points]);
  return (
    <div
      ref={ref}
      role="img"
      aria-label="策略组合净值曲线"
      style={{ width: "100%" }}
    />
  );
}

/* ------------------------------ 表格样式 ------------------------------ */
function verdictOf(feedback: Record<string, "有效" | "无效">, symbol: string): "有效" | "无效" | "" {
  return feedback[symbol] || "";
}

/* ------------------------------ 主视图 ------------------------------ */
export type StrategyScanResponse = { ok: boolean; scan?: Scan; error?: string };

export function StrategyScanView({
  initialData,
  watchlistItems = [],
  onAddWatch,
  onAnalyze,
}: {
  initialData?: StrategyScanResponse | null;
  /** 当前关注列表，用于判断是否已关注 */
  watchlistItems?: { symbol: string }[];
  /** 加入关注回调 */
  onAddWatch?: (code: string, name: string) => Promise<void>;
  /** 查看分析回调（跳转到分析页，可选传入选股榜单行数据作为 AI 分析上下文） */
  onAnalyze?: (symbol: string, screenerContext?: ScanSelected) => void;
}) {
  const [scan, setScan] = useState<Scan | null>(initialData?.ok ? initialData.scan ?? null : null);
  // 若顶层已预取数据，则直接进入“已加载”状态，避免进入时骨架屏闪烁一次
  const [loading, setLoading] = useState(!initialData || !initialData.ok);
  const [error, setError] = useState(initialData && !initialData.ok ? initialData.error || "暂时无法读取策略扫描结果" : "");
  const [feedback, setFeedback] = useState<Record<string, "有效" | "无效">>({});
  const [feedbackBusy, setFeedbackBusy] = useState("");
  const [scanBusy, setScanBusy] = useState(false);
  const [scanError, setScanError] = useState("");

  const load = useCallback(() => {
    let alive = true;
    void (async () => {
      setLoading(true);
      setError("");
      try {
        // 15 秒超时，避免 D1 慢查询或网络问题导致加载状态永远挂起
        const ctrl = new AbortController();
        const timer = window.setTimeout(() => ctrl.abort(), 15_000);
        const res = await fetch("/api/strategy-scan", { signal: ctrl.signal }).finally(() => window.clearTimeout(timer));
        const json = (await res.json()) as StrategyScanResponse;
        if (!alive) return;
        if (json.ok && json.scan) setScan(json.scan);
        else setError(json.error || "暂时无法读取策略扫描结果");
      } catch (e: unknown) {
        if (!alive) return;
        const msg = e instanceof DOMException && e.name === "AbortError"
          ? "请求超时：策略数据加载超过 15 秒，请检查网络或 D1 数据库连接后重试。"
          : "暂时无法读取策略扫描结果";
        setError(msg);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    // 顶层预取数据可能在组件首次渲染之后才到达（例如硬刷新 Ctrl+Shift+R
    // 时 Dashboard 的 loadData 尚未完成，initialData 先为 null 再被填充）。
    // 此时 loading 初始为 true，需要在 initialData 到达后纠正为“已加载”，
    // 否则会一直停在“正在加载…”且不会自行拉取（guard 直接 return）。
    if (initialData?.ok && initialData.scan) {
      setScan(initialData.scan);
      setLoading(false);
      setError("");
      return;
    }
    // 仅在顶层未预取数据时才自行拉取，避免进入页面时重复加载造成闪烁
    let cleanup: (() => void) | undefined;
    const timer = window.setTimeout(() => {
      cleanup = load();
    }, 0);
    return () => {
      window.clearTimeout(timer);
      cleanup?.();
    };
  }, [initialData, load]);

  async function submitFeedback(symbol: string, name: string, verdict: "有效" | "无效") {
    if (feedbackBusy) return;
    setFeedbackBusy(symbol + verdict);
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol, name, verdict, source: "web" }),
      });
      if (res.ok) setFeedback((prev) => ({ ...prev, [symbol]: verdict }));
    } finally {
      setFeedbackBusy("");
    }
  }

  async function handleRunInteractive(overrides: ScreenerOverrides) {
    setScanBusy(true);
    setScanError("");
    try {
      // 90 秒超时（略大于后端 60s 超时，给网络留余量）
      const ctrl = new AbortController();
      const timer = window.setTimeout(() => ctrl.abort(), 90_000);
      const res = await fetch("/api/strategy-scan/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(overrides),
        signal: ctrl.signal,
      }).finally(() => window.clearTimeout(timer));
      const json = (await res.json()) as { ok?: boolean; scan?: Scan; error?: string; code?: string };
      if (json.ok && json.scan) {
        setScan(json.scan);
        setScanError("");
      } else {
        const msg = json.error || "扫描执行失败";
        // 云端不运行引擎时，给出更友好的提示
        const hint = json.code === "CLOUD_ENGINE_DISABLED"
          ? `${msg}\n\n提示：当前部署在云端，无法直接运行选股引擎。请在本地 PC 运行 trading_agent 并推送结果到云端，或使用本地部署。`
          : msg;
        setScanError(hint);
      }
    } catch (e: unknown) {
      const msg = e instanceof DOMException && e.name === "AbortError"
        ? "扫描超时（超过 90 秒未完成），可能是数据量过大或 Python 引擎卡死，请重试。"
        : "网络错误：无法连接扫描引擎";
      setScanError(msg);
    } finally {
      setScanBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="scan-view">
        <ScreenerConfigPanel onRun={handleRunInteractive} busy={scanBusy} />
        {scanError && <Banner tone="warn" title="扫描失败">{scanError}</Banner>}
        <div className="loading-state"><Spinner /> 正在加载策略扫描结果…</div>
      </div>
    );
  }
  if (error || !scan || !scan.backtest) {
    return (
      <div className="scan-view">
        <ScreenerConfigPanel onRun={handleRunInteractive} busy={scanBusy} />
        {scanError && <Banner tone="warn" title="扫描失败">{scanError}</Banner>}
        <Banner tone={scanBusy ? "info" : "warn"} title={scanBusy ? "正在运行策略扫描…" : "暂无策略扫描数据"}>
          {scanBusy ? (
            <span className="scan-inline-loading">
              <Spinner /> 策略引擎正在执行选股与回测，请耐心等待（最多 60 秒）…
            </span>
          ) : (
            error ||
            (!scan
              ? "请先在本地运行 trading_agent 生成共享扫描 JSON，或使用上方配置面板触发扫描。"
              : "扫描结果缺少回测数据（backtest），请重新在本地运行 trading_agent 生成完整共享 JSON。")
          )}
        </Banner>
      </div>
    );
  }

  const fm = scan.backtest.finalMetrics;
  const opt = scan.backtest.optimized;

  return (
    <div className="scan-view">
      {/* 交互式配置面板 */}
      <ScreenerConfigPanel onRun={handleRunInteractive} busy={scanBusy} />

      {scanError && (
        <Banner tone="warn" title="扫描失败">
          {scanError}
        </Banner>
      )}

      <SectionHeader
        eyebrow="文件桥接"
        title="策略扫描"
        subtitle={`候选池 ${scan.universeSize} 只 → 选出 ${scan.selectedCount} 只 ｜ 生成于 ${scan.generatedAt}`}
        desc="由 trading_agent 回测引擎生成，经文件桥同步到本页展示。"
      />

      {scan.marketState && (
        (() => {
          const ms = scan.marketState!;
          const tone =
            ms.state === "bull" ? "success" : ms.state === "bear" ? "danger" : "info";
          const label =
            ms.state === "bull" ? "牛市 · 满仓" : ms.state === "bear" ? "熊市 · 空仓" : ms.state === "neutral" ? "中性 · 半仓" : "未知 · 中性";
          return (
            <Banner tone={tone} title={`市场状态：${label}（仓位系数 ${ms.positionFactor.toFixed(2)}）`}>
              {ms.detail}
            </Banner>
          );
        })()
      )}

      <div className="stat-grid scan-stats">
        <Stat
          label="最终信号"
          value={`MA${scan.backtest.finalSignal.fastMa}/MA${scan.backtest.finalSignal.slowMa}`}
        />
        <Stat label="总收益" value={pct(fm.totalReturn)} hint={fm.totalReturn >= 0 ? "盈利" : "亏损"} />
        <Stat label="年化收益" value={pct(fm.annualReturn)} />
        <Stat label="夏普比率" value={fm.sharpe.toFixed(2)} hint="风险调整收益" />
        <Stat label="最大回撤" value={pct(fm.maxDrawdown)} hint="越低越好" />
        <Stat label="日胜率" value={pct(fm.winRate)} />
      </div>

      {opt && (
        <Banner
          tone="success"
          title={`参数优化有效：夏普 ${opt.sharpeImprovement >= 0 ? "+" : ""}${opt.sharpeImprovement.toFixed(2)}`}
        >
          优化后最佳参数 MA{opt.bestSignal.fastMa}/MA{opt.bestSignal.slowMa}，基准 MA
          {scan.backtest.baseSignal.fastMa}/MA{scan.backtest.baseSignal.slowMa}。
        </Banner>
      )}

      <Card>
        <CardHeader title="组合净值曲线" desc="策略在历史区间上的组合净值（起始归一化 1.0）。" />
        {scan.equityCurve && scan.equityCurve.length > 0 ? (
          <StrategyCurveChart points={scan.equityCurve} />
        ) : (
          <div className="scan-empty-hint">暂无净值曲线数据。</div>
        )}
      </Card>

      <Card>
        <CardHeader title="选股榜单（多因子打分）" desc="风险调整动量 + 趋势 + 估值 + RSI/MACD 技术确认 + 流动性/规模，加权打分取 Top N；行业分散约束限制单行业最多入选数。" />
        <div className="scan-table-wrap">
        <table className="scan-table">
          <thead>
            <tr>
              <th className="scan-col--code">代码</th>
              <th className="scan-col--name">名称</th>
              <th className="scan-col--sector">行业</th>
              <th className="scan-col--num">得分</th>
              <th className="scan-col--num">动量(20d)</th>
              <th className="scan-col--num">RSI</th>
              <th className="scan-col--num">风险动量</th>
              <th className="scan-col--num">趋势</th>
              <th className="scan-col--num">PE</th>
              <th className="scan-col--num">PB</th>
              <th className="scan-col--num">换手%</th>
              <th className="scan-col--num">信号数</th>
              <th className="scan-col--feedback">反馈</th>
              {(onAddWatch || onAnalyze) && <th className="scan-col--actions">操作</th>}
            </tr>
          </thead>
          <tbody>
            {scan.selected.map((s) => {
              const isWatched = watchlistItems.some((w) => w.symbol === s.code);
              return (
              <tr key={s.code}>
                <td className="scan-col--code">{s.code}</td>
                <td className="scan-col--name">{s.name}</td>
                <td className="scan-col--sector">
                  <span className="scan-sector">{s.sector ?? "其他"}</span>
                </td>
                <td className="scan-col--num">{s.score.toFixed(3)}</td>
                <td className="scan-col--num">
                  <Tag tone={s.momentum >= 0 ? "up" : "down"}>{pct(s.momentum)}</Tag>
                </td>
                <td className="scan-col--num">{s.rsi != null ? s.rsi.toFixed(1) : "-"}</td>
                <td className="scan-col--num">
                  {s.factors ? `${(s.factors.momentum != null ? s.factors.momentum : 0) * 100 | 0}` : "-"}
                </td>
                <td className="scan-col--num">
                  {s.factors ? `${(s.factors.trend != null ? s.factors.trend : 0) * 100 | 0}` : "-"}
                </td>
                <td className="scan-col--num">{s.peTtm.toFixed(2)}</td>
                <td className="scan-col--num">{s.pb.toFixed(2)}</td>
                <td className="scan-col--num">{s.turnover.toFixed(2)}</td>
                <td className="scan-col--num">{s.signals}</td>
                <td className="scan-col--feedback">
                  <span className="scan-feedback">
                    <button
                      type="button"
                      className={`scan-feedback__btn scan-feedback__btn--up ${verdictOf(feedback, s.code) === "有效" ? "is-active" : ""}`}
                      disabled={feedbackBusy === s.code + "有效"}
                      onClick={() => submitFeedback(s.code, s.name, "有效")}
                    >
                      有效
                    </button>
                    <button
                      type="button"
                      className={`scan-feedback__btn scan-feedback__btn--down ${verdictOf(feedback, s.code) === "无效" ? "is-active" : ""}`}
                      disabled={feedbackBusy === s.code + "无效"}
                      onClick={() => submitFeedback(s.code, s.name, "无效")}
                    >
                      无效
                    </button>
                  </span>
                </td>
                {(onAddWatch || onAnalyze) && (
                  <td className="scan-col--actions">
                    <span className="scan-actions">
                      {onAddWatch && (
                        <button
                          type="button"
                          className={`scan-action-btn scan-action-btn--watch ${isWatched ? "is-watched" : ""}`}
                          disabled={isWatched}
                          onClick={() => void onAddWatch(s.code, s.name)}
                          title={isWatched ? "已在关注列表" : "加入关注"}
                        >
                          {isWatched ? "已关注" : "关注"}
                        </button>
                      )}
                      {onAnalyze && (
                        <button
                          type="button"
                          className="scan-action-btn scan-action-btn--analyze"
                          onClick={() => onAnalyze?.(s.code, s)}
                          title="查看分析"
                        >
                          分析
                        </button>
                      )}
                    </span>
                  </td>
                )}
              </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      </Card>

      {opt && (
        <Card>
          <CardHeader title="参数网格搜索 Top" desc="按夏普排序的参数组合表现。" />
          <div className="scan-table-wrap">
          <table className="scan-table">
            <thead>
              <tr>
                <th className="scan-col--code">快线</th>
                <th className="scan-col--code">慢线</th>
                <th className="scan-col--num">夏普</th>
                <th className="scan-col--num">总收益</th>
                <th className="scan-col--num">最大回撤</th>
              </tr>
            </thead>
            <tbody>
              {opt.grid.map((g, i) => (
                <tr key={i}>
                  <td className="scan-col--code">MA{g.fastMa}</td>
                  <td className="scan-col--code">MA{g.slowMa}</td>
                  <td className="scan-col--num">{g.metric.toFixed(3)}</td>
                  <td className="scan-col--num">
                    <Tag tone={g.totalReturn >= 0 ? "up" : "down"}>{pct(g.totalReturn)}</Tag>
                  </td>
                  <td className="scan-col--num">
                    <Tag tone={g.maxDrawdown >= 0 ? "up" : "down"}>{pct(g.maxDrawdown)}</Tag>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </Card>
      )}

      <Hint>{scan.disclaimer}</Hint>
    </div>
  );
}
