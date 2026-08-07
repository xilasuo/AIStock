"use client";

import { useEffect, useState, useCallback } from "react";
import { Target, CheckCircle, XCircle, HelpCircle, TrendingUp, Loader2, FileText } from "lucide-react";
import type { Outcome } from "../../lib/strategy-suggestions";

interface LinkedReviewInfo {
  reviewId: number;
  followedPlan: boolean;
  createdAt: string;
}

interface SuggestionItem {
  id: number;
  symbol: string;
  name: string;
  action: string | null;
  source: string;
  aiAction: string | null;
  ruleAction: string | null;
  diff: number | null;
  priceAtTime: number | null;
  createdAt: string;
  outcome: string;
  outcomeNote: string;
  outcomePrice: number | null;
  validationWarnings: string | null;
  contextQualityScore: number | null;
  linkedReview: LinkedReviewInfo | null;
}

interface Stats {
  total: number; pending: number; correct: number; wrong: number; uncertain: number;
  accuracy: number | null;
  byAction: Array<{ action: string; total: number; correct: number; accuracy: number | null }>;
  bySource: Array<{ source: string; total: number; correct: number; accuracy: number | null }>;
}

const SOURCE_LABELS: Record<string, string> = {
  rule: "规则引擎", ai: "AI生成", hybrid: "AI+规则一致",
};
const SOURCE_CLASS: Record<string, string> = {
  rule: "src-rule", ai: "src-ai", hybrid: "src-hybrid",
};
const ACTION_BADGE_CLASS: Record<string, string> = {
  "开新仓": "act-buy", "加仓": "act-add", "持有": "act-hold",
  "减仓": "act-cut", "清仓": "act-sell", "观望": "act-wait",
};

function formatTime(iso: string): string {
  if (!iso) return "";
  const t = iso.replace("T", " ").slice(0, 16);
  return t;
}

/** 解析 validation_warnings JSON，分离幻觉和注意 */
function parseWarnings(raw: string | null): { hallucinations: string[]; warnings: string[] } {
  if (!raw) return { hallucinations: [], warnings: [] };
  try {
    const arr = JSON.parse(raw) as string[];
    return {
      hallucinations: arr.filter(s => s.startsWith("[幻觉]")),
      warnings: arr.filter(s => !s.startsWith("[幻觉]")),
    };
  } catch {
    return { hallucinations: [], warnings: [] };
  }
}

function qualityClass(score: number): string {
  if (score >= 90) return "q-excellent";
  if (score >= 70) return "q-good";
  if (score >= 50) return "q-fair";
  return "q-poor";
}

export default function SuggestionTrackingView() {
  const [suggestions, setSuggestions] = useState<SuggestionItem[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState<number | null>(null);
  const [error, setError] = useState("");

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [listRes, statsRes] = await Promise.all([
        fetch("/api/strategy-suggestions?limit=50").then(r => r.json()),
        fetch("/api/strategy-suggestions/stats").then(r => r.json()),
      ]) as [{ code: number; data: SuggestionItem[] }, { code: number; data: Stats }];
      if (listRes.code === 0) setSuggestions(listRes.data);
      if (statsRes.code === 0) setStats(statsRes.data);
    } catch {
      setError("加载失败，请稍后重试");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const markOutcome = useCallback(async (id: number, outcome: Outcome) => {
    setUpdating(id);
    try {
      const res = await fetch("/api/strategy-suggestions", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, outcome }),
      }).then(r => r.json()) as { code: number };
      if (res.code === 0) {
        setSuggestions(prev => prev.map(s => s.id === id ? { ...s, outcome } : s));
        // 重取 stats
        const statsRes = await fetch("/api/strategy-suggestions/stats").then(r => r.json()) as { code: number; data: Stats };
        if (statsRes.code === 0) setStats(statsRes.data);
      }
    } catch {
      // ignore
    } finally {
      setUpdating(null);
    }
  }, []);

  if (loading) {
    return (
      <div className="suggestion-page">
        <div className="suggestion-loading"><Loader2 size={24} className="spin" /> 加载建议记录…</div>
      </div>
    );
  }

  return (
    <div className="suggestion-page">
      <h2 className="suggestion-title">
        <Target size={22} />
        建议追踪
        <span className="suggestion-subtitle">AI/规则建议事后验证，持续优化策略</span>
      </h2>

      {error && <div className="suggestion-error">{error}</div>}

      {/* 准确率统计 */}
      {stats && stats.total > 0 && (
        <div className="suggestion-stats">
          <div className="stat-card">
            <span className="stat-label">总建议</span>
            <span className="stat-value">{stats.total}</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">已标注</span>
            <span className="stat-value">{stats.correct + stats.wrong + stats.uncertain}</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">正确</span>
            <span className="stat-value stat-ok">{stats.correct}</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">错误</span>
            <span className="stat-value stat-err">{stats.wrong}</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">准确率</span>
            <span className="stat-value stat-accent">{stats.accuracy !== null ? `${(stats.accuracy * 100).toFixed(0)}%` : "—"}</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">待验证</span>
            <span className="stat-value stat-muted">{stats.pending}</span>
          </div>
        </div>
      )}

      {/* 按来源/动作明细 */}
      {stats && stats.byAction.length > 0 && (
        <div className="suggestion-breakdown">
          <div className="breakdown-col">
            <h4>按动作</h4>
            {stats.byAction.map(a => (
              <div key={a.action} className="breakdown-row">
                <span className={`action-badge ${ACTION_BADGE_CLASS[a.action] ?? ""}`}>{a.action}</span>
                <span className="breakdown-num">{a.total}次</span>
                <span className="breakdown-acc">{a.accuracy !== null ? `${(a.accuracy * 100).toFixed(0)}%` : "—"}</span>
              </div>
            ))}
          </div>
          <div className="breakdown-col">
            <h4>按来源</h4>
            {stats.bySource.map(s => (
              <div key={s.source} className="breakdown-row">
                <span className={`source-badge ${SOURCE_CLASS[s.source] ?? ""}`}>{SOURCE_LABELS[s.source] ?? s.source}</span>
                <span className="breakdown-num">{s.total}次</span>
                <span className="breakdown-acc">{s.accuracy !== null ? `${(s.accuracy * 100).toFixed(0)}%` : "—"}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 建议列表 */}
      {suggestions.length === 0 && !error && (
        <div className="suggestion-empty">
          <TrendingUp size={48} />
          <p>还没有建议记录</p>
          <span>分析个股时系统会自动记录策略建议，你可以事后回来标注正误。</span>
        </div>
      )}

      <div className="suggestion-list">
        {suggestions.map(item => (
          <div key={item.id} className={`suggestion-row ${item.outcome !== "pending" ? "suggestion-done" : ""}`}>
            <div className="suggestion-main">
              <div className="suggestion-symbol">
                <span className="sym-code">{item.symbol}</span>
                <span className="sym-name">{item.name}</span>
              </div>
              <div className="suggestion-meta">
                {item.action && <span className={`action-badge ${ACTION_BADGE_CLASS[item.action] ?? ""}`}>{item.action}</span>}
                <span className={`source-badge ${SOURCE_CLASS[item.source] ?? ""}`}>{SOURCE_LABELS[item.source] ?? item.source}</span>
                {item.contextQualityScore !== null && (
                  <span className={`quality-badge ${qualityClass(item.contextQualityScore)}`}
                    title={`上下文质量: ${item.contextQualityScore}/100`}>
                    质量{item.contextQualityScore}
                  </span>
                )}
                {item.diff === 1 && item.aiAction && item.ruleAction && (
                  <span className="diff-badge diff-warn" title="AI与规则引擎结论分歧">
                    AI→{item.aiAction} 规则→{item.ruleAction}
                  </span>
                )}
                {item.diff === 0 && (
                  <span className="diff-badge diff-ok">一致</span>
                )}
                {item.priceAtTime !== null && (
                  <span className="price-info">¥{item.priceAtTime.toFixed(2)}</span>
                )}
                <span className="time-info">{formatTime(item.createdAt)}</span>
              </div>
              {/* 数字回验警告 */}
              {(() => {
                const { hallucinations, warnings } = parseWarnings(item.validationWarnings);
                if (!hallucinations.length && !warnings.length) return null;
                return (
                  <div className="suggestion-warnings">
                    {hallucinations.map((w, i) => (
                      <div key={`h-${i}`} className="verify-badge verify-hallucination" title={w}>
                        {w.replace("[幻觉] ", "")}
                      </div>
                    ))}
                    {warnings.map((w, i) => (
                      <div key={`n-${i}`} className="verify-badge verify-note" title={w}>
                        {w.replace("[注意] ", "")}
                      </div>
                    ))}
                  </div>
                );
              })()}
            </div>
            <div className="suggestion-outcome">
              {item.outcome === "pending" ? (
                <>
                  <button
                    className="outcome-btn outcome-correct"
                    onClick={() => markOutcome(item.id, "correct")}
                    disabled={updating === item.id}
                    title="建议正确"
                  >
                    {updating === item.id ? <Loader2 size={14} className="spin" /> : <CheckCircle size={16} />}
                    正确
                  </button>
                  <button
                    className="outcome-btn outcome-wrong"
                    onClick={() => markOutcome(item.id, "wrong")}
                    disabled={updating === item.id}
                    title="建议错误"
                  >
                    <XCircle size={16} /> 错误
                  </button>
                  <button
                    className="outcome-btn outcome-uncertain"
                    onClick={() => markOutcome(item.id, "uncertain")}
                    disabled={updating === item.id}
                    title="无法判断"
                  >
                    <HelpCircle size={16} /> 不确定
                  </button>
                </>
              ) : (
                <span className={`outcome-result outcome-${item.outcome}`}>
                  {item.outcome === "correct" ? "✓ 正确" : item.outcome === "wrong" ? "✗ 错误" : "? 不确定"}
                </span>
              )}
            </div>
            {item.linkedReview && (
              <div className="suggestion-review-link">
                <FileText size={14} />
                <span>已复盘</span>
                <span className="review-plan-badge" title={item.linkedReview.followedPlan ? "按计划执行" : "未按计划"}>
                  {item.linkedReview.followedPlan ? "按计划" : "偏离计划"}
                </span>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
