import { and, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { watchDetails, watchItems } from "../../../db/schema";
import { isStockCode } from "../../../lib/domain/domain";
import { canonicalStockName } from "../../../lib/domain/stocks";
import { withAuth } from "../../../lib/auth/auth";
import { shanghaiIso } from "../../../lib/utils/time";

export const GET = withAuth(async (_request, { user }) => {
  const db = getDb();
  const [items, details] = await Promise.all([
    db.select().from(watchItems).where(eq(watchItems.userId, user.id)).orderBy(watchItems.id),
    db.select().from(watchDetails).where(eq(watchDetails.userId, user.id)),
  ]);
  const detailsBySymbol = new Map(details.map((detail) => [detail.symbol, detail]));
  return Response.json({
    items: items.map((item) => ({
      ...item,
      conditionText: detailsBySymbol.get(item.symbol)?.conditionText ?? item.note ?? "等待自己的买入条件",
      status: detailsBySymbol.get(item.symbol)?.status ?? "研究中",
      lastReviewedAt: detailsBySymbol.get(item.symbol)?.lastReviewedAt ?? null,
      updatedAt: detailsBySymbol.get(item.symbol)?.updatedAt ?? item.createdAt,
      conditionMetric: detailsBySymbol.get(item.symbol)?.conditionMetric ?? null,
      conditionDirection: detailsBySymbol.get(item.symbol)?.conditionDirection ?? null,
      conditionValue: detailsBySymbol.get(item.symbol)?.conditionValue ?? null,
    })),
  });
}, "关注列表暂时无法读取");

export const POST = withAuth(async (request, { user }) => {
  const payload = await request.json() as { symbol?: string; name?: string; note?: string; conditionText?: string };
  const symbol = payload.symbol?.trim() ?? "";
  const name = canonicalStockName(symbol, payload.name?.trim() ?? "");
  const note = payload.note?.trim() ?? "";
  const conditionText = payload.conditionText?.trim() || note || "等待自己的买入条件";
  if (!isStockCode(symbol) || !name || name.length > 30 || note.length > 200 || conditionText.length > 300) {
    return Response.json({ error: "关注信息不正确" }, { status: 400 });
  }

  const db = getDb();
  const existing = await db.select().from(watchItems)
    .where(and(eq(watchItems.symbol, symbol), eq(watchItems.userId, user.id))).limit(1);
  if (existing.length) {
    const detail = await db.select().from(watchDetails)
      .where(and(eq(watchDetails.symbol, symbol), eq(watchDetails.userId, user.id))).limit(1);
    return Response.json({
      item: {
        ...existing[0],
        conditionText: detail[0]?.conditionText ?? existing[0].note ?? "等待自己的买入条件",
        status: detail[0]?.status ?? "研究中",
        lastReviewedAt: detail[0]?.lastReviewedAt ?? null,
        updatedAt: detail[0]?.updatedAt ?? existing[0].createdAt,
      },
      existed: true,
    });
  }
  // 防御性清理：若此前 DELETE 的 db.batch 部分失败，watchDetails 可能残留孤儿行
  await db.delete(watchDetails).where(and(eq(watchDetails.symbol, symbol), eq(watchDetails.userId, user.id)));
  // 不使用 db.batch：D1 的 batch 对 RETURNING 支持不稳定，且写入非原子会留孤儿行。
  // 改用顺序 await，先写主表取回自增 id，再写明细，逻辑等价且更稳。
  const [item] = await db.insert(watchItems).values({
    userId: user.id,
    symbol,
    name,
    note,
    createdAt: shanghaiIso(),
  }).returning();
  await db.insert(watchDetails).values({ userId: user.id, symbol, conditionText, status: "研究中" });
  return Response.json({ item: { ...item, conditionText, status: "研究中", lastReviewedAt: null } }, { status: 201 });
}, "加入关注失败");

export const PATCH = withAuth(async (request, { user }) => {
  const payload = await request.json() as {
    symbol?: string;
    conditionText?: string;
    status?: string;
    conditionMetric?: string;
    conditionDirection?: string;
    conditionValue?: number;
  };
  const symbol = payload.symbol?.trim() ?? "";
  const conditionText = payload.conditionText?.trim() ?? "";
  const statuses = new Set(["研究中", "等待条件", "已买入", "暂停"]);
  if (!isStockCode(symbol) || !conditionText || conditionText.length > 300 || !statuses.has(payload.status ?? "")) {
    return Response.json({ error: "观察条件或状态不正确" }, { status: 400 });
  }

  const metric = (payload.conditionMetric ?? "").trim();
  const direction = (payload.conditionDirection ?? "").trim();
  const rawValue = Number(payload.conditionValue);
  const metricSet = new Set(["price", "change"]);
  const directionSet = new Set(["above", "below"]);
  let conditionMetric: string | null = null;
  let conditionDirection: string | null = null;
  let conditionValue: number | null = null;
  if (metric) {
    if (!metricSet.has(metric) || !directionSet.has(direction) || !Number.isFinite(rawValue)) {
      return Response.json({ error: "触发条件不正确" }, { status: 400 });
    }
    conditionMetric = metric;
    conditionDirection = direction;
    conditionValue = rawValue;
  }

  const db = getDb();
  const item = await db.select({ symbol: watchItems.symbol })
    .from(watchItems)
    .where(and(eq(watchItems.symbol, symbol), eq(watchItems.userId, user.id)))
    .limit(1);
  if (!item.length) {
    return Response.json({ error: "关注股票不存在" }, { status: 404 });
  }
  const existing = await db.select().from(watchDetails)
    .where(and(eq(watchDetails.symbol, symbol), eq(watchDetails.userId, user.id))).limit(1);
  const values = {
    conditionText,
    status: payload.status as "研究中" | "等待条件" | "已买入" | "暂停",
    lastReviewedAt: shanghaiIso(),
    updatedAt: shanghaiIso(),
    conditionMetric,
    conditionDirection,
    conditionValue,
  };
  const [detail] = existing.length
    ? await db.update(watchDetails).set(values)
      .where(and(eq(watchDetails.symbol, symbol), eq(watchDetails.userId, user.id))).returning()
    : await db.insert(watchDetails).values({ userId: user.id, symbol, ...values }).returning();
  return Response.json({ detail });
}, "观察条件保存失败");

export const DELETE = withAuth(async (request, { user }) => {
  const symbol = new URL(request.url).searchParams.get("symbol")?.trim() ?? "";
  if (!isStockCode(symbol)) {
    return Response.json({ error: "股票代码不正确" }, { status: 400 });
  }
  const db = getDb();
  // 先删主表确认存在性，再清理明细 — 不用 db.batch 避免非原子操作导致孤儿行
  const deleted = await db.delete(watchItems)
    .where(and(eq(watchItems.symbol, symbol), eq(watchItems.userId, user.id)))
    .returning({ symbol: watchItems.symbol });
  if (!deleted.length) {
    return Response.json({ error: "关注股票不存在" }, { status: 404 });
  }
  await db.delete(watchDetails).where(and(eq(watchDetails.symbol, symbol), eq(watchDetails.userId, user.id)));
  return Response.json({ ok: true });
}, "取消关注失败");
