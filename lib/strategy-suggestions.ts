import { getDb } from "../db";
import { strategySuggestions, reviews } from "../db/schema";
import type { StrategyResult } from "./ai/trading-strategy";
import { eq, and, desc, inArray } from "drizzle-orm";

export type Outcome = "pending" | "correct" | "wrong" | "uncertain";

export interface SuggestionRecord {
  id: number;
  userId: number;
  symbol: string;
  name: string;
  action: string | null;
  source: string;
  aiAction: string | null;
  ruleAction: string | null;
  diff: number | null;
  priceAtTime: number | null;
  contextJson: string | null;
  outcome: string;
  outcomeNote: string;
  outcomePrice: number | null;
  createdAt: string;
  outcomeAt: string | null;
  validationWarnings: string | null;
  contextQualityScore: number | null;
}

/** 关联的复盘摘要 */
export interface LinkedReview {
  reviewId: number;
  followedPlan: boolean;
  createdAt: string;
}

/** 在策略生成后自动保存一条建议记录，供用户事后标注 */
export async function saveStrategySuggestion(params: {
  userId: number;
  symbol: string;
  name: string;
  price: number;
  result: StrategyResult;
  context?: unknown;
}): Promise<void> {
  const { userId, symbol, name, price, result, context } = params;
  // 最终采纳的动作：规则引擎优先（确定性），AI不可用时回退规则
  const action = result.ruleAction ?? result.aiAction;
  // 来源分类
  let source = "rule";
  if (result.mode !== "automatic" && result.aiAction !== null && result.ruleAction !== null) {
    source = result.diff === false ? "hybrid" : "ai";
  } else if (result.mode !== "automatic") {
    source = "ai";
  }
  const diffCol = result.diff === true ? 1 : result.diff === false ? 0 : null;
  const warnings = result.validationWarnings?.length ? JSON.stringify(result.validationWarnings) : "";
  await getDb().insert(strategySuggestions).values({
    userId,
    symbol,
    name,
    action,
    source,
    aiAction: result.aiAction,
    ruleAction: result.ruleAction,
    diff: diffCol,
    priceAtTime: price,
    contextJson: context ? JSON.stringify(context) : null,
    outcome: "pending",
    outcomeNote: "",
    validationWarnings: warnings,
    contextQualityScore: result.contextQuality?.overall ?? null,
    createdAt: new Date().toISOString().replace("T", " ").slice(0, 19),
  });
}

/** 查询当前用户的建议列表（支持按 outcome/symbol 过滤、时间倒序） */
export async function listSuggestions(params: {
  userId: number;
  limit?: number;
  offset?: number;
  outcome?: Outcome;
  symbol?: string;
}): Promise<SuggestionRecord[]> {
  const { userId, limit = 50, offset = 0, outcome, symbol } = params;

  const conditions = [eq(strategySuggestions.userId, userId)];
  if (outcome !== undefined) {
    conditions.push(eq(strategySuggestions.outcome, outcome as Outcome));
  }
  if (symbol) {
    conditions.push(eq(strategySuggestions.symbol, symbol));
  }

  const rows = await getDb()
    .select().from(strategySuggestions)
    .where(and(...conditions))
    .orderBy(desc(strategySuggestions.createdAt))
    .limit(limit).offset(offset)
    .all();
  return rows as unknown as SuggestionRecord[];
}

/** 根据建议 ID 列表批量查询关联的复盘记录，返回 id→LinkedReview 映射 */
export async function getLinkedReviewsMap(
  suggestionIds: number[],
  userId: number,
): Promise<Map<number, LinkedReview>> {
  if (suggestionIds.length === 0) return new Map();
  const reviewRows = await getDb()
    .select({
      id: reviews.id,
      strategySuggestionId: reviews.strategySuggestionId,
      followedPlan: reviews.followedPlan,
      createdAt: reviews.createdAt,
    })
    .from(reviews)
    .where(and(
      eq(reviews.userId, userId),
      inArray(reviews.strategySuggestionId, suggestionIds),
    ))
    .all();
  const map = new Map<number, LinkedReview>();
  for (const r of reviewRows) {
    if (r.strategySuggestionId !== null) {
      map.set(r.strategySuggestionId, {
        reviewId: r.id,
        followedPlan: r.followedPlan as unknown as boolean,
        createdAt: r.createdAt,
      });
    }
  }
  return map;
}

/** 更新单条建议的结果标注 */
export async function updateSuggestionOutcome(params: {
  id: number;
  userId: number;
  outcome: Outcome;
  outcomeNote?: string;
  outcomePrice?: number;
}): Promise<void> {
  const { id, userId, outcome, outcomeNote = "", outcomePrice } = params;
  const outcomeAt = new Date().toISOString().replace("T", " ").slice(0, 19);
  // drizzle 对 enum 列做严格类型约束，使用 set 的便捷写法
  const db = getDb();
  await db.update(strategySuggestions)
    .set({
      outcome: outcome as typeof strategySuggestions.outcome.default,
      outcomeNote,
      outcomePrice: outcomePrice ?? null,
      outcomeAt,
    })
    .where(and(eq(strategySuggestions.id, id), eq(strategySuggestions.userId, userId)));
}

/**
 * 删除建议记录。三种模式（互斥，按优先级取第一个命中的）：
 * - ids：删除指定的若干条
 * - outcome：按标注状态批量删除（如清空所有 pending / 所有已标注）
 * - all：清空当前用户的全部记录
 *
 * 注意：reviews 表通过 strategy_suggestion_id 引用本表，删除前必须先解除引用，
 * 否则会留下指向不存在记录的悬空外键，导致复盘详情页取不到关联建议。
 * 这里选择置空而非级联删除复盘——复盘是用户手写的资产，不能因清理建议而丢失。
 */
export async function deleteSuggestions(params: {
  userId: number;
  ids?: number[];
  outcome?: Outcome;
  all?: boolean;
}): Promise<number> {
  const { userId, ids, outcome, all } = params;
  const db = getDb();

  const scope = [eq(strategySuggestions.userId, userId)];
  if (ids && ids.length > 0) {
    scope.push(inArray(strategySuggestions.id, ids));
  } else if (outcome !== undefined) {
    scope.push(eq(strategySuggestions.outcome, outcome as Outcome));
  } else if (!all) {
    // 三个条件都没给：拒绝执行，避免误清空
    return 0;
  }

  // 先查出将被删除的 id，用于解除复盘引用并返回准确的删除条数
  const targets = await db
    .select({ id: strategySuggestions.id })
    .from(strategySuggestions)
    .where(and(...scope))
    .all();
  const targetIds = targets.map((t) => t.id);
  if (targetIds.length === 0) return 0;

  // 解除复盘对这些建议的引用（保留复盘本身）
  await db
    .update(reviews)
    .set({ strategySuggestionId: null })
    .where(and(
      eq(reviews.userId, userId),
      inArray(reviews.strategySuggestionId, targetIds),
    ));

  await db
    .delete(strategySuggestions)
    .where(and(
      eq(strategySuggestions.userId, userId),
      inArray(strategySuggestions.id, targetIds),
    ));

  return targetIds.length;
}

/** 统计当前用户的建议准确率 */
export async function getSuggestionStats(userId: number): Promise<{
  total: number;
  pending: number;
  correct: number;
  wrong: number;
  uncertain: number;
  accuracy: number | null;
  byAction: Array<{ action: string; total: number; correct: number; accuracy: number | null }>;
  bySource: Array<{ source: string; total: number; correct: number; accuracy: number | null }>;
}> {
  const rows = await getDb()
    .select()
    .from(strategySuggestions)
    .where(eq(strategySuggestions.userId, userId))
    .orderBy(desc(strategySuggestions.createdAt))
    .all() as unknown as SuggestionRecord[];

  const total = rows.length;
  let pending = 0, correct = 0, wrong = 0, uncertain = 0;
  const actionMap = new Map<string, { total: number; correct: number }>();
  const sourceMap = new Map<string, { total: number; correct: number }>();

  for (const r of rows) {
    const o = r.outcome;
    if (o === "pending") pending++;
    else if (o === "correct") correct++;
    else if (o === "wrong") wrong++;
    else if (o === "uncertain") uncertain++;

    if (r.action) {
      const a = actionMap.get(r.action) || { total: 0, correct: 0 };
      a.total++;
      if (o === "correct") a.correct++;
      actionMap.set(r.action, a);
    }
    const s = sourceMap.get(r.source) || { total: 0, correct: 0 };
    s.total++;
    if (o === "correct") s.correct++;
    sourceMap.set(r.source, s);
  }

  const judged = correct + wrong;
  const accuracy = judged > 0 ? correct / judged : null;

  const byAction = Array.from(actionMap.entries())
    .map(([action, v]) => {
      const judgedA = v.correct + (rows.filter(r => r.action === action && r.outcome === "wrong").length);
      return { action, total: v.total, correct: v.correct, accuracy: v.total > 0 && judgedA > 0 ? v.correct / judgedA : null };
    })
    .sort((a, b) => b.total - a.total);

  const bySource = Array.from(sourceMap.entries())
    .map(([source, v]) => {
      const judgedS = v.correct + (rows.filter(r => r.source === source && r.outcome === "wrong").length);
      return { source, total: v.total, correct: v.correct, accuracy: v.total > 0 && judgedS > 0 ? v.correct / judgedS : null };
    })
    .sort((a, b) => b.total - a.total);

  return { total, pending, correct, wrong, uncertain, accuracy, byAction, bySource };
}
