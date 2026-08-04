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
} from "../components/ui";
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
  /** 入选理由（解释性，screener 生成）；旧 payload 可能缺失，故可选 */
  rationale?: string;
  /** 行业（行业分散约束）；旧 payload 可能缺失，故可选 */
  sector?: string;
  /** 主力净流入占流通市值千分比（正值=主力净流入）；数据源未提供则缺失 */
  fundFlowPct?: number | null;
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
  /** 本次扫描所属时段档位：pre_market / intraday / post_market，用于结果区标注「盘前/盘中/盘后」 */
  profile?: string;
  period: { beg: string; end: string };
  universeSize: number;
  selectedCount: number;
  selected: ScanSelected[];
  backtest: {
    baseSignal?: ScanSignal;
    baseMetrics?: ScanMetrics;
    finalSignal?: ScanSignal;
    finalMetrics?: ScanMetrics;
    optimized?: {
      bestSignal: ScanSignal;
      bestMetrics: ScanMetrics;
      sharpeImprovement: number;
      grid: ScanGridItem[];
      /** 样本外绩效（时间序列切分验证，防过拟合） */
      outOfSample?: ScanMetrics | null;
      split?: {
        trainRatio: number;
        testBars?: Record<string, number>;
      };
    };
  };
  equityCurve: Array<{ date: string; value: number }>;
  marketState?: {
    state: string;
    positionFactor?: number;
    score?: number;
    detail?: string;
    maGap?: number;
    momentum?: number;
    shortMom?: number;
    volRatio?: number;
  };
  /** 实际生效的因子权重（预设失真透明化） */
  screenerMeta?: {
    configured?: Record<string, number>;
    applied?: Record<string, number>;
    skipped?: string[];
  };
  /** 真实历史模拟（滚动再平衡回测，消除幸存者偏差） */
  walkForward?: {
    metrics: ScanMetrics;
    rebalanceDays: number;
    equityCurve: Array<{ date: string; value: number }>;
  };
  disclaimer: string;
};

/** 时段档位 → 中文标签（与 run_hub --profile / 配置面板档位一致） */
const PROFILE_LABEL: Record<string, string> = {
  pre_market: "盘前",
  intraday: "盘中",
  post_market: "盘后",
};

function pct(x: number | undefined | null): string {
  if (x == null || Number.isNaN(x)) return "—";
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

  async function submitFeedback(symbol: string, name: string, verdict: "有效" | "无效", factors?: Record<string, number>) {
    if (feedbackBusy) return;
    setFeedbackBusy(symbol + verdict);
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol, name, verdict, source: "web", factors: factors ?? {} }),
      });
      if (res.ok) setFeedback((prev) => ({ ...prev, [symbol]: verdict }));
    } finally {
      setFeedbackBusy("");
    }
  }

  // 反馈优化：把历史「有效/无效」评价反向作用到因子权重，写回云端配置，下次扫描生效。
  const [optimizeBusy, setOptimizeBusy] = useState(false);
  const [optimizeResult, setOptimizeResult] = useState<{
    ok: boolean;
    adjusted?: boolean;
    note?: string;
    up?: number;
    down?: number;
    usedFeedback?: number;
    newWeights?: Record<string, number>;
  } | null>(null);
  // 当前扫描所属的时段档位（用于把反馈优化作用到正确的档位权重）
  const [scanProfile, setScanProfile] = useState<string>("pre_market");
  async function optimizeFromFeedback() {
    if (optimizeBusy) return;
    setOptimizeBusy(true);
    setOptimizeResult(null);
    try {
      const res = await fetch("/api/feedback/optimize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile: scanProfile }),
      });
      const json = (await res.json()) as {
        ok: boolean;
        adjusted?: boolean;
        note?: string;
        up?: number;
        down?: number;
        usedFeedback?: number;
        newWeights?: Record<string, number>;
      };
      if (json.ok) setOptimizeResult(json);
    } finally {
      setOptimizeBusy(false);
    }
  }

  async function handleRunInteractive(overrides: ScreenerOverrides, profile?: string) {
    setScanBusy(true);
    setScanError("");
    setScanProfile(profile || "pre_market");
    try {
      // 90 秒超时（略大于后端 60s 超时，给网络留余量）
      const ctrl = new AbortController();
      const timer = window.setTimeout(() => ctrl.abort(), 90_000);
      const res = await fetch("/api/strategy-scan/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(profile ? { ...overrides, profile } : overrides),
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

  const fm = scan.backtest.finalMetrics ?? {};
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
        subtitle={`【${PROFILE_LABEL[scan.profile ?? "pre_market"] ?? "盘前"}】候选池 ${scan.universeSize} 只 → 选出 ${scan.selectedCount} 只 ｜ 生成于 ${scan.generatedAt}`}
        desc="由 trading_agent 回测引擎生成，经文件桥同步到本页展示。"
      />

      {scan.marketState && (
        (() => {
          const ms = scan.marketState!;
          const tone =
            ms.state === "bull" ? "success" : ms.state === "bear" ? "danger" : "info";
          const label =
            ms.state === "bull" ? "牛市 · 满仓" : ms.state === "bear" ? "熊市 · 空仓" : ms.state === "neutral" ? "中性 · 半仓" : "未知 · 中性";
          const leadingBits = [
            ms.shortMom != null ? `短期动量 ${pct(ms.shortMom)}` : null,
            ms.volRatio != null ? `波动比 ${ms.volRatio.toFixed(2)}` : null,
          ].filter(Boolean).join(" ｜ ");
          return (
            <Banner tone={tone} title={`市场状态：${label}（仓位系数 ${(ms.positionFactor ?? 0).toFixed(2)}）`}>
              {ms.detail}
              {leadingBits && <div className="scan-muted-line">{leadingBits}</div>}
            </Banner>
          );
        })()
      )}

      <div className="stat-grid scan-stats">
        <Stat
          label="最终信号"
          value={
            scan.backtest.finalSignal
              ? `MA${scan.backtest.finalSignal.fastMa}/MA${scan.backtest.finalSignal.slowMa}`
              : "—"
          }
        />
        <Stat
          label="总收益"
          value={pct(fm.totalReturn)}
          hint={(fm.totalReturn ?? 0) >= 0 ? "盈利" : "亏损"}
        />
        <Stat label="年化收益" value={pct(fm.annualReturn)} />
        <Stat label="夏普比率" value={(fm.sharpe ?? 0).toFixed(2)} hint="风险调整收益" />
        <Stat label="最大回撤" value={pct(fm.maxDrawdown)} hint="越低越好" />
        <Stat label="交易胜率" value={pct(fm.winRate)} hint="已平仓交易盈利占比" />
        <Stat label="交易次数" value={String(fm.trades ?? 0)} />
      </div>

      {scan.walkForward && (
        <Banner tone="warn" title={`真实历史模拟（滚动再平衡，${scan.walkForward.rebalanceDays} 交易日换仓）`}>
          消除幸存者偏差：每期仅用「截至当期」的数据重新选股，按等权 + 单票风险预算建仓。
          这是策略在历史上的真实可期表现 —— 总收益{" "}
          <b>{pct(scan.walkForward.metrics.totalReturn)}</b>，夏普{" "}
          <b>{(scan.walkForward.metrics.sharpe ?? 0).toFixed(2)}</b>，最大回撤{" "}
          <b>{pct(scan.walkForward.metrics.maxDrawdown)}</b>，交易胜率{" "}
          <b>{pct(scan.walkForward.metrics.winRate)}</b>，交易{" "}
          <b>{scan.walkForward.metrics.trades ?? 0}</b> 次。
          上方「最终信号」指标为样本内参考，请以本真实历史模拟为准。
        </Banner>
      )}

      {opt && (
        <>
          <Banner
            tone="success"
            title={`参数优化有效：夏普 ${opt.sharpeImprovement >= 0 ? "+" : ""}${opt.sharpeImprovement.toFixed(2)}`}
          >
            优化后最佳参数 MA{opt.bestSignal.fastMa}/MA{opt.bestSignal.slowMa}，基准 MA
            {scan.backtest.baseSignal?.fastMa ?? "?"}/MA{scan.backtest.baseSignal?.slowMa ?? "?"}。
          </Banner>

          {opt.outOfSample && (
            <Banner tone="info" title="样本外验证（防过拟合）">
              采用时间序列切分（前 {Math.round((opt.split?.trainRatio ?? 0.7) * 100)}% 训练选参，
              后 {Math.round((1 - (opt.split?.trainRatio ?? 0.7)) * 100)}% 验证），
              样本外绩效更能反映策略真实可期表现：总收益{" "}
              <b>{pct(opt.outOfSample.totalReturn)}</b>，夏普{" "}
              <b>{(opt.outOfSample.sharpe ?? 0).toFixed(2)}</b>，最大回撤{" "}
              <b>{pct(opt.outOfSample.maxDrawdown)}</b>，交易胜率{" "}
              <b>{pct(opt.outOfSample.winRate)}</b>。
            </Banner>
          )}
        </>
      )}

      <Card>
        <CardHeader title="组合净值曲线（样本内参考）" desc="用当前选股结果在历史区间上的净值（起始归一化 1.0），可能存在幸存者偏差。" />
        {scan.equityCurve && scan.equityCurve.length > 0 ? (
          <StrategyCurveChart points={scan.equityCurve} />
        ) : (
          <div className="scan-empty-hint">暂无净值曲线数据。</div>
        )}
      </Card>

      {scan.walkForward && scan.walkForward.equityCurve && scan.walkForward.equityCurve.length > 0 && (
        <Card>
          <CardHeader
            title="真实历史模拟净值曲线"
            desc="滚动再平衡回测：每期只用「截至当期」数据重新选股，按风险预算建仓，消除幸存者偏差。"
          />
          <StrategyCurveChart points={scan.walkForward.equityCurve} />
          <p className="scan-muted-line">
            换仓周期 {scan.walkForward.rebalanceDays} 交易日 ｜ 起始归一化 1.0 ｜ 已含手续费与滑点
          </p>
        </Card>
      )}

      <Card>
        <div className="scan-feedback-bar">
          <button type="button" className="optimize-btn" disabled={optimizeBusy} onClick={optimizeFromFeedback}>
            {optimizeBusy ? "优化中…" : "用反馈优化权重"}
          </button>
          {optimizeResult && (
            <span className={`scan-optimize-note ${optimizeResult.adjusted ? "is-adjusted" : ""}`}>
              {optimizeResult.note}
            </span>
          )}
        </div>
        <CardHeader title="选股榜单（多因子打分）" desc="风险调整动量 + 趋势 + 估值 + RSI/MACD 技术确认 + 流动性/规模/资金流，加权打分取 Top N；行业分散约束限制单行业最多入选数。" />
        {scan.screenerMeta && (() => {
          const applied = scan.screenerMeta.applied || {};
          const skipped = scan.screenerMeta.skipped || [];
          const appliedStr = Object.entries(applied)
            .filter(([, w]) => w > 0)
            .map(([k, w]) => `${k}=${(w * 100).toFixed(0)}%`)
            .join(" ");
          if (!appliedStr) return null;
          const skipNote = skipped.length
            ? `（以下因子因数据缺失被剔除、权重已重新分摊：${skipped.join("、")}）`
            : "";
          return (
            <div className="scan-meta-note">
              <span className="scan-meta-note__label">实际生效权重：</span>
              <span className="scan-meta-note__text">{appliedStr}</span>
              {skipNote && <span className="scan-meta-note__warn">{skipNote}</span>}
            </div>
          );
        })()}
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
              <th className="scan-col--num">资金流‰</th>
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
                <td className="scan-col--num">{(s.score ?? 0).toFixed(3)}</td>
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
                <td className="scan-col--num">{(s.peTtm ?? 0).toFixed(2)}</td>
                <td className="scan-col--num">{(s.pb ?? 0).toFixed(2)}</td>
                <td className="scan-col--num">{(s.turnover ?? 0).toFixed(2)}</td>
                <td className="scan-col--num">
                  {s.fundFlowPct != null ? (
                    <Tag tone={s.fundFlowPct >= 0 ? "up" : "down"}>{s.fundFlowPct.toFixed(2)}</Tag>
                  ) : "-"}
                </td>
                <td className="scan-col--num">{s.signals}</td>
                <td className="scan-col--feedback">
                  <span className="scan-feedback">
                    <button
                      type="button"
                      className={`scan-feedback__btn scan-feedback__btn--up ${verdictOf(feedback, s.code) === "有效" ? "is-active" : ""}`}
                      disabled={feedbackBusy === s.code + "有效"}
                      onClick={() => submitFeedback(s.code, s.name, "有效", s.factors)}
                    >
                      有效
                    </button>
                    <button
                      type="button"
                      className={`scan-feedback__btn scan-feedback__btn--down ${verdictOf(feedback, s.code) === "无效" ? "is-active" : ""}`}
                      disabled={feedbackBusy === s.code + "无效"}
                      onClick={() => submitFeedback(s.code, s.name, "无效", s.factors)}
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

      {/* ② 解释性：为什么选这些票 */}
      <Card>
        <CardHeader
          title="为什么选这些票"
          desc="基于多因子归一化贡献自动生成入选理由，一眼看懂每只票的核心驱动。"
        />
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {scan.selected.map((s) => (
            <div
              key={s.code}
              style={{ borderBottom: "1px solid #e5e7eb", paddingBottom: 8 }}
            >
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <span style={{ fontWeight: 600 }}>{s.name}</span>
                <span style={{ color: "#6b7280", fontSize: 12 }}>{s.code}</span>
                <span style={{ marginLeft: "auto", color: "#1d4ed8", fontSize: 12 }}>
                  得分 {(s.score ?? 0).toFixed(2)}
                </span>
              </div>
              <div style={{ marginTop: 4, fontSize: 13, color: "#374151" }}>
                {s.rationale || "—"}
              </div>
            </div>
          ))}
        </div>
      </Card>

      {opt && (
        <Card>
          <CardHeader title="参数网格搜索 Top" desc="按夏普排序的参数组合表现。" />
          <div className="scan-table-wrap">
          <table className="scan-table scan-table--grid">
            <thead>
              <tr>
                <th>快线</th>
                <th>慢线</th>
                <th>夏普</th>
                <th>总收益</th>
                <th>最大回撤</th>
              </tr>
            </thead>
            <tbody>
              {opt.grid.map((g, i) => (
                <tr key={i}>
                  <td>MA{g.fastMa}</td>
                  <td>MA{g.slowMa}</td>
                  <td>{(g.metric ?? 0).toFixed(3)}</td>
                  <td>
                    <Tag tone={g.totalReturn >= 0 ? "up" : "down"}>{pct(g.totalReturn)}</Tag>
                  </td>
                  <td>
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
