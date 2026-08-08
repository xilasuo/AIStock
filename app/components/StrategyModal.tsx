"use client";

import React, { useEffect, useMemo, useState } from "react";
import { Target, Sparkles, AlertCircle } from "lucide-react";
import type { AssistantContext } from "../../lib/ai/assistant";
import { calculatePortfolio, type Trade } from "../../lib/domain/domain";
import type { PortfolioInsights } from "../../lib/domain/portfolio-insights";
import { Modal } from "./ui";
import { StrategyBlocks } from "./StrategyBlocks";

// /api/analyze 返回的分析结构（explain=true 时）
type Analysis = {
  stock: {
    code: string;
    name: string;
    industry: string;
    instrumentType: "stock" | "etf";
  };
  quote: {
    price: number;
    changePercent: number;
    ma20: number;
    support: number;
    resistance: number;
    volatility: number;
    marketTime: string | null;
  };
  financials: {
    revenueGrowth: number | null;
    profitGrowth: number | null;
    debtRatio: number | null;
    pe: number | null;
    pb: number | null;
    roe: number | null;
  };
  explanation: {
    summary: string;
    risks: string[];
    missingInformation: string[];
  };
  volume: {
    latest: number;
    ma5: number;
    ma20: number;
    ratio: number | null;
    divergence: "顶背离" | "底背离" | "无明显背离" | null;
    upDaysWithVolume: number;
    downDaysWithVolume: number;
  } | null;
  oscillators: AssistantContext["oscillators"];
  source: { name: string; fetchedAt: string; url?: string };
};

function cqClass(score: number): string {
  if (score >= 90) return "q-excellent";
  if (score >= 70) return "q-good";
  if (score >= 50) return "q-fair";
  return "q-poor";
}

export type StrategyModalProps = {
  code: string;
  name: string;
  trades: Trade[];
  portfolioInsights: PortfolioInsights;
  onClose: () => void;
};

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  const payload = (await res.json().catch(() => ({}))) as { error?: string } & Record<string, unknown>;
  if (!res.ok) throw new Error(payload.error ?? `请求失败 ${res.status}`);
  return payload as T;
}

function buildContextFromAnalysis(
  analysis: Analysis,
  position: ReturnType<typeof calculatePortfolio>["positions"][number] | null,
  portfolioInsights: PortfolioInsights,
): AssistantContext {
  const allocationPercent = position
    ? portfolioInsights.positions.find((item) => item.symbol === position.symbol)?.allocationPercent ?? null
    : null;
  const positionContext = position
    ? {
        quantity: position.quantity,
        averageCost: position.averageCostTenThousandths / 10000,
        // 盈亏统一用后端 calculatePortfolio 的 returnPercent（基于最近收盘价），避免前端实时价重算与后端口径不一致。
        returnPercent: position.returnPercent ?? null,
        stockPositionPercent: allocationPercent,
      }
    : null;

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
      profitPercentNote: portfolioInsights.profitPercentNote,
    },
  };
}

export function StrategyModal({
  code,
  name,
  trades,
  portfolioInsights,
  onClose,
}: StrategyModalProps) {
  const [strategy, setStrategy] = useState<{
    content: string; mode: string;
    ruleAction?: string | null; aiAction?: string | null; diff?: boolean | null;
    validationWarnings?: string[];
    contextQuality?: { overall: number };
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const position = useMemo(() => {
    const portfolio = calculatePortfolio(trades);
    return portfolio.positions.find((p: ReturnType<typeof calculatePortfolio>["positions"][number]) => p.symbol === code) ?? null;
  }, [trades, code]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      setStrategy(null);
      try {
        const analysis = await jsonRequest<Analysis & { error?: string }>("/api/analyze", {
          method: "POST",
          body: JSON.stringify({ query: code, explain: true, force: true }),
        });
        if (cancelled) return;
        if (analysis.error) throw new Error(analysis.error);

        const context = buildContextFromAnalysis(analysis, position, portfolioInsights);
        const result = await jsonRequest<{
          strategy?: { content: string; mode: string; ruleAction?: string | null; aiAction?: string | null; diff?: boolean | null; validationWarnings?: string[]; contextQuality?: { overall: number; dimensions?: Array<{ label: string; score: number; detail: string }> } };
          strategyWarning?: string;
          error?: string;
        }>("/api/analyze", {
          method: "POST",
          body: JSON.stringify({
            query: code,
            explain: false,
            strategy: true,
            context,
          }),
        });
        if (cancelled) return;
        if (result.error) throw new Error(result.error);
        if (result.strategyWarning) throw new Error(result.strategyWarning);
        if (!result.strategy) throw new Error("未返回策略内容");
        setStrategy(result.strategy);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "生成策略失败");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [code, position, portfolioInsights]);

  return (
    <Modal title={`${name}（${code}）操盘策略`} onClose={onClose}>
      <div style={{ width: "100%", maxWidth: 760, maxHeight: "80vh", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "16px 24px 0" }}>
          <p style={{ margin: 0, fontSize: 13, color: "var(--muted)" }}>
            结合你的持仓与账户概况，由 AI 生成该股操作建议。仅作为复盘参考，不构成投资建议。
          </p>
        </div>

        <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden", padding: "16px 24px 20px" }}>
          {loading && (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, padding: 40 }}>
              <Sparkles size={18} className="spin" style={{ color: "var(--accent)" }} />
              <span style={{ fontSize: 14, color: "var(--muted)" }}>正在结合持仓生成策略…</span>
            </div>
          )}

          {!loading && error && (
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 10,
                padding: 16,
                borderRadius: 10,
                background: "rgba(255,82,82,.08)",
                border: "0.5px solid rgba(255,82,82,.3)",
                color: "var(--danger)",
                fontSize: 13,
              }}
            >
              <AlertCircle size={18} />
              <span>{error}</span>
            </div>
          )}

          {!loading && !error && strategy && (
            <div className="strategy-card" style={{ margin: 0 }}>
              <div className="strategy-header">
                <Target size={18} />
                <span>操盘策略</span>
                <span className="strategy-mode">{strategy.mode === "deepseek" || strategy.mode === "openai" ? "AI 生成" : "规则生成"}</span>
                {strategy.diff === true && (
                  <span className="strategy-diff strategy-diff--warn">{`AI→${strategy.aiAction ?? "?"} 规则→${strategy.ruleAction ?? "?"}`}</span>
                )}
                {strategy.diff === false && (
                  <span className="strategy-diff strategy-diff--ok">AI与规则一致</span>
                )}
                {strategy.aiAction === null && strategy.mode === "automatic" && (
                  <span className="strategy-diff strategy-diff--fallback">仅规则引擎</span>
                )}
                {strategy.contextQuality && (
                  <span className={`quality-badge ${cqClass(strategy.contextQuality.overall)}`}
                    title={`上下文质量: ${strategy.contextQuality.overall}/100`}>
                    数据{strategy.contextQuality.overall}
                  </span>
                )}
              </div>
              <StrategyBlocks content={strategy.content} />
              {strategy.validationWarnings && strategy.validationWarnings.length > 0 && (
                <div className="strategy-validation-warnings">
                  {strategy.validationWarnings.map((w, i) => (
                    <div key={i} className="strategy-validation-warning">
                      <AlertCircle size={14} />
                      <span>{w}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
