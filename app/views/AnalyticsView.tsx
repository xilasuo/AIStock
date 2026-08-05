"use client";

import { useMemo, useRef, useState } from "react";
import { Badge, SectionHeader, Stat, Button, Card, CardHeader } from "../components/ui";
import { BarList, DonutChart } from "../components/charts";
import { EquityCurveChart } from "../components/equity-chart";
import { calculateTradeStatistics, type ReasonStat } from "../../lib/domain/trade-statistics";
import type { CapitalFlow, Trade } from "../../lib/domain/domain";
import type { PortfolioInsights } from "../../lib/domain/portfolio-insights";
import { shanghaiDate } from "../../lib/utils/time";

export type AnalyticsReview = {
  cycleEndTradeId: number | null;
  symbol: string;
  resultCents: number | null;
  tags: string[];
  followedPlan: boolean;
};

type AnalyticsViewProps = {
  trades: Trade[];
  capitalFlows: CapitalFlow[];
  reviews: AnalyticsReview[];
  portfolioInsights: PortfolioInsights;
  initialCapitalCents: number | null;
};

function money(cents: number): string {
  return `¥${(cents / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function pct(value: number): string {
  if (!Number.isFinite(value)) return "∞";
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function todayStamp(): string {
  return shanghaiDate();
}

/** 展示某类理由归因：盈利 Top3（绿）+ 亏损 Top3（红），无数据时给空态。 */
function ReasonRows({ stats, emptyText }: { stats: ReasonStat[]; emptyText: string }) {
  const wins = stats.filter((item) => item.realizedCents > 0).slice(0, 3);
  const losses = stats.filter((item) => item.realizedCents < 0).slice(0, 3);
  if (!wins.length && !losses.length) return <p className="chart-empty">{emptyText}</p>;
  return (
    <>
      {wins.map((item) => (
        <p key={`w-${item.reason}`}><Badge tone="green">{item.reason}</Badge> <b>+{money(item.realizedCents)}</b><small>（{item.trades} 笔）</small></p>
      ))}
      {losses.map((item) => (
        <p key={`l-${item.reason}`}><Badge tone="red">{item.reason}</Badge> <b>{money(item.realizedCents)}</b><small>（{item.trades} 笔）</small></p>
      ))}
    </>
  );
}

export function AnalyticsView({
  trades,
  capitalFlows,
  reviews,
  portfolioInsights,
  initialCapitalCents,
}: AnalyticsViewProps) {
  const viewRef = useRef<HTMLDivElement>(null);
  const [exporting, setExporting] = useState(false);

  const stats = useMemo(
    () => calculateTradeStatistics(trades, capitalFlows, reviews, initialCapitalCents),
    [trades, capitalFlows, reviews, initialCapitalCents],
  );

  const allocationSegments = useMemo(() => {
    const positions = [...portfolioInsights.positions]
      .sort((a, b) => b.marketValueCents - a.marketValueCents)
      .map((position) => ({ label: position.name || position.symbol, value: position.marketValueCents }));
    if (positions.length > 8) {
      const top = positions.slice(0, 8);
      const rest = positions.slice(8).reduce((sum, item) => sum + item.value, 0);
      top.push({ label: "其他", value: rest });
      return top;
    }
    return positions;
  }, [portfolioInsights.positions]);

  const plan = stats.planAdherence;

  async function exportImage() {
    if (!viewRef.current || exporting) return;
    setExporting(true);
    try {
      const { toPng } = await import("html-to-image");
      const dataUrl = await toPng(viewRef.current, { backgroundColor: "#ffffff", pixelRatio: 2, cacheBust: true });
      const link = document.createElement("a");
      link.download = `复盘分析_${todayStamp()}.png`;
      link.href = dataUrl;
      link.click();
    } catch (error) {
      console.error("导出图片失败", error);
    } finally {
      setExporting(false);
    }
  }

  async function exportPdf() {
    if (!viewRef.current || exporting) return;
    setExporting(true);
    try {
      const { toPng } = await import("html-to-image");
      const { jsPDF } = await import("jspdf");
      const dataUrl = await toPng(viewRef.current, { backgroundColor: "#ffffff", pixelRatio: 2, cacheBust: true });
      const img = new Image();
      img.src = dataUrl;
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("图片生成失败"));
      });
      const pdf = new jsPDF({
        orientation: img.width >= img.height ? "landscape" : "portrait",
        unit: "pt",
        format: [img.width, img.height],
      });
      pdf.addImage(dataUrl, "PNG", 0, 0, img.width, img.height);
      pdf.save(`复盘分析_${todayStamp()}.pdf`);
    } catch (error) {
      console.error("导出 PDF 失败", error);
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="analytics-view" ref={viewRef}>
      <SectionHeader
        eyebrow="复盘分析"
        title="交易绩效与行为画像"
        subtitle="从记账升级到分析：胜率、盈亏比、回撤、按计划执行度，帮你找到自己的优势与弱点。"
        actions={
          <div className="export-toolbar">
            <Button variant="ghost" onClick={exportImage} disabled={exporting}>
              {exporting ? "导出中…" : "导出图片"}
            </Button>
            <Button variant="ghost" onClick={exportPdf} disabled={exporting}>
              {exporting ? "导出中…" : "导出 PDF"}
            </Button>
          </div>
        }
      />

      <div className="stat-grid stat-grid--analytics">
        <Stat label="已平仓交易" value={stats.totalTrades} hint={stats.scratchTrades ? `含 ${stats.scratchTrades} 笔平手` : undefined} />
        <Stat label="累计盈亏" value={money(stats.realizedCents)} hint={stats.realizedCents >= 0 ? "盈利" : "亏损"} />
        <Stat label="胜率" value={`${(stats.winRate * 100).toFixed(1)}%`} hint={`${stats.winningTrades}胜 / ${stats.losingTrades}负`} />
        <Stat label="盈亏比" value={stats.profitFactor === Infinity ? "∞" : stats.profitFactor.toFixed(2)} hint="总盈利 / 总亏损" />
        <Stat label="期望值" value={money(stats.expectancyCents)} hint="每笔平均盈亏" />
        <Stat label="最大回撤" value={money(stats.maxDrawdownCents)} hint={pct(stats.maxDrawdownPercent)} />
        <Stat label="平均持仓" value={`${Math.round(stats.avgHoldingDays)} 天`} hint={`最长 ${stats.maxHoldingDays} 天`} />
        <Stat
          label="连胜 / 连亏"
          value={`${stats.longestWinStreak} / ${stats.longestLossStreak}`}
          hint={`当前 ${stats.currentWinStreak > 0 ? `${stats.currentWinStreak}连胜` : stats.currentLossStreak > 0 ? `${stats.currentLossStreak}连亏` : "—"}`}
        />
      </div>

      <Card className="analytics-panel">
        <CardHeader
          title="权益走势与回撤"
          desc="基于本金、资金流水与已实现盈亏重建，无需实时行情。"
        />
        {stats.equityCurve.length > 1 ? (
          <EquityCurveChart title="资金权益曲线" points={stats.equityCurve} />
        ) : (
          <p className="chart-empty">暂无足够数据绘制曲线（需要先有清仓交易或资金流水）。</p>
        )}
      </Card>

      <Card className="analytics-panel">
        <CardHeader
          title="计划 vs 执行偏差"
          desc="按计划 vs 没按计划的盈亏和胜率对比，定位纪律缺口；复盘里填写「偏离原因」会越积越准。"
        />
        {reviews.length ? (
          <>
            <div className="stat-grid stat-grid--analytics">
              <Stat label="计划执行率" value={`${(plan.rate * 100).toFixed(1)}%`} hint={`${plan.followed}/${plan.total} 笔按计划`} />
              <Stat label="按计划盈亏" value={money(plan.followedRealizedCents)} hint={`胜率 ${(plan.followedWinRate * 100).toFixed(0)}%`} />
              <Stat label="偏离计划盈亏" value={money(plan.deviatedRealizedCents)} hint={`胜率 ${(plan.deviatedWinRate * 100).toFixed(0)}%`} />
            </div>
            <BarList
              items={[
                { label: "按计划", value: plan.followedRealizedCents, sub: `${plan.followed} 笔` },
                { label: "偏离计划", value: plan.deviatedRealizedCents, sub: `${plan.total - plan.followed} 笔` },
              ]}
            />
          </>
        ) : (
          <p className="chart-empty">还没有复盘记录，完成交易复盘后会统计计划执行度。</p>
        )}
      </Card>

      <div className="analytics-cols">
        <Card className="analytics-panel">
          <CardHeader title="按标签看盈亏" desc="来自复盘时打的标签，定位最赚钱/最亏钱的打法或错误。" />
          {stats.byTag.length ? (
            <BarList items={stats.byTag.map((item) => ({ label: item.tag, value: item.realizedCents, sub: `${Math.round(item.winRate * 100)}%胜` }))} />
          ) : (
            <p className="chart-empty">还没有给复盘打标签。在「交易记录」完成一笔复盘时添加标签，这里就会按标签统计。</p>
          )}
        </Card>

        <Card className="analytics-panel">
          <CardHeader title="仓位占比" desc="按市值分布的持仓结构。" />
          <DonutChart segments={allocationSegments} />
        </Card>
      </div>

      <div className="analytics-cols">
        <Card className="analytics-panel">
          <CardHeader title="按标的盈亏排行" />
          <BarList items={stats.bySymbol.map((item) => ({ label: item.name || item.symbol, value: item.realizedCents, sub: `${item.trades}笔` }))} />
        </Card>

        <Card className="analytics-panel">
          <CardHeader title="按月盈亏" />
          <BarList items={stats.byMonth.map((item) => ({ label: item.month, value: item.realizedCents, sub: `${Math.round(item.winRate * 100)}%胜` }))} />
        </Card>
      </div>

      <section className="analytics-panel">
        <SectionHeader
          eyebrow="优势定位"
          title="你的 Edge"
          subtitle="入场靠什么买法赚钱，退出靠什么纪律守钱——按建仓/清仓理由自动归因。"
          actions={<Badge tone="accent">数据驱动复盘</Badge>}
        />
        <div className="edge-grid">
          <div>
            <h4>入场 · 按买入理由</h4>
            <ReasonRows stats={stats.byReason} emptyText="暂无清仓记录可归因" />
          </div>
          <div>
            <h4>退出 · 按卖出理由</h4>
            <ReasonRows stats={stats.bySellReason} emptyText="暂无清仓记录可归因" />
          </div>
        </div>
        <p className="edge-source">按每笔已清仓周期的建仓/清仓理由自动归因（来自买卖记录，无需等复盘）；同类理由多笔合并统计。卖出一侧重点看：止盈/止损这类纪律卖是否守住了利润，怕回吐/拿不住/想换股这类情绪卖亏掉了多少。</p>
      </section>
    </div>
  );
}
