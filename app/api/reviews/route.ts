import { desc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { reviews, tradeRecords } from "../../../db/schema";
import { buildTradeCycles, isStockCode } from "../../../lib/domain/domain";
import { withAuth } from "../../../lib/auth/auth";
import { shanghaiIso } from "../../../lib/utils/time";

export function parseReviewTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const tag = item.trim().slice(0, 20);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    result.push(tag);
    if (result.length === 10) break;
  }
  return result;
}

export const GET = withAuth(async (_request, { user }) => {
  const rows = await getDb().select().from(reviews)
    .where(eq(reviews.userId, user.id)).orderBy(desc(reviews.id)).limit(500);
  return Response.json({
    reviews: rows.map((review) => ({ ...review, tags: parseReviewTags(review.tags) })),
  });
}, "复盘暂时无法读取");

export const POST = withAuth(async (request, { user }) => {
  const payload = await request.json() as Record<string, unknown>;
  const symbol = String(payload.symbol ?? "").trim();
  const name = String(payload.name ?? "").trim();
  const buyReason = String(payload.buyReason ?? "").trim();
  const sellReason = String(payload.sellReason ?? "").trim();
  const lesson = String(payload.lesson ?? "").trim();
  const followedPlan = payload.followedPlan === true;
  const deviationReason = String(payload.deviationReason ?? "").trim();
  const cycleEndTradeId = Number(payload.cycleEndTradeId);
  // 可选关联策略建议 ID
  let strategySuggestionId: number | null = null;
  if (payload.strategySuggestionId !== undefined && payload.strategySuggestionId !== null) {
    const sid = Number(payload.strategySuggestionId);
    if (Number.isInteger(sid) && sid > 0) strategySuggestionId = sid;
  }
  const tags = parseReviewTags(payload.tags);
  if (!isStockCode(symbol) || !name || !buyReason || !sellReason || !lesson) {
    return Response.json({ error: "请完整填写复盘内容" }, { status: 400 });
  }
  if (!Number.isInteger(cycleEndTradeId) || cycleEndTradeId <= 0) {
    return Response.json({ error: "复盘对应的持仓周期不正确" }, { status: 400 });
  }
  if (buyReason.length > 300 || sellReason.length > 300 || lesson.length > 500) {
    return Response.json({ error: "复盘内容过长" }, { status: 400 });
  }
  if (deviationReason.length > 300) {
    return Response.json({ error: "偏差原因过长" }, { status: 400 });
  }
  const db = getDb();
  const trades = await db.select().from(tradeRecords).where(eq(tradeRecords.userId, user.id));
  const cycle = buildTradeCycles(trades).find((item) =>
    item.symbol === symbol && item.endTradeId === cycleEndTradeId
  );
  if (!cycle) {
    return Response.json({ error: "没有找到已经清仓的对应交易" }, { status: 400 });
  }
  const duplicate = await db.select().from(reviews).where(eq(reviews.userId, user.id));
  if (duplicate.some((review) => review.cycleEndTradeId === cycleEndTradeId)) {
    return Response.json({ error: "这次持仓周期已经完成复盘" }, { status: 409 });
  }
  const [review] = await db.insert(reviews).values({
    userId: user.id,
    symbol,
    name: cycle.name,
    cycleEndTradeId,
    buyReason,
    sellReason,
    followedPlan,
    lesson,
    tags: JSON.stringify(tags),
    deviationReason,
    resultCents: cycle.realizedCents,
    strategySuggestionId,
    createdAt: shanghaiIso(),
  }).returning();
  return Response.json({ review: { ...review, tags } }, { status: 201 });
}, "复盘保存失败");
