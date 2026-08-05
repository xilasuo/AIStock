import { and, desc, eq } from "drizzle-orm";
import { ensureSchema, getDb } from "../../../db";
import { alertRules } from "../../../db/schema";
import { isStockCode, toMillis } from "../../../lib/domain/domain";
import { shanghaiIso } from "../../../lib/utils/time";
import { canonicalStockName } from "../../../lib/domain/stocks";
import { getCurrentUser, requireApiUser } from "../../../lib/auth/auth";

const alertTypes = new Set(["止损", "止盈一", "止盈二"]);

export async function GET() {
  const unauthorized = await requireApiUser();
  if (unauthorized) return unauthorized;
  try {
    const user = await getCurrentUser();
    await ensureSchema();
    const alerts = await getDb().select().from(alertRules)
      .where(eq(alertRules.userId, user.id)).orderBy(desc(alertRules.id));
    return Response.json({ alerts });
  } catch {
    return Response.json({ error: "提醒暂时无法读取" }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const unauthorized = await requireApiUser();
  if (unauthorized) return unauthorized;
  try {
    const user = await getCurrentUser();
    const payload = await request.json() as { symbol?: string; name?: string; type?: string; targetPrice?: number };
    const symbol = payload.symbol?.trim() ?? "";
    const name = canonicalStockName(symbol, payload.name?.trim() ?? "");
    const type = payload.type?.trim() ?? "";
    const rawTargetPrice = Number(payload.targetPrice);
    const targetPriceMillis = toMillis(rawTargetPrice);
    if (!isStockCode(symbol) || !name || !alertTypes.has(type) || !Number.isFinite(rawTargetPrice) || targetPriceMillis <= 0) {
      return Response.json({ error: "提醒信息不正确" }, { status: 400 });
    }
    await ensureSchema();
    const [alert] = await getDb().insert(alertRules).values({
      userId: user.id,
      symbol,
      name,
      type: type as "止损" | "止盈一" | "止盈二",
      targetPriceCents: Math.round(targetPriceMillis / 10),
      targetPriceMillis,
      createdAt: shanghaiIso(),
    }).returning();
    return Response.json({ alert }, { status: 201 });
  } catch {
    return Response.json({ error: "提醒保存失败" }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  const unauthorized = await requireApiUser();
  if (unauthorized) return unauthorized;
  try {
    const user = await getCurrentUser();
    const payload = await request.json() as { id?: number; action?: string; targetPrice?: number };
    const id = Number(payload.id);
    if (!Number.isInteger(id) || id <= 0) {
      return Response.json({ error: "提醒编号不正确" }, { status: 400 });
    }
    if (payload.action !== "disable" && payload.action !== "acknowledge" && payload.action !== "trigger" && payload.action !== "update") {
      return Response.json({ error: "提醒操作不正确" }, { status: 400 });
    }
    await ensureSchema();
    let values: Partial<typeof alertRules.$inferInsert> = {};
    if (payload.action === "disable") {
      values = { enabled: false };
    } else if (payload.action === "acknowledge") {
      values = { acknowledgedAt: shanghaiIso() };
    } else if (payload.action === "trigger") {
      values = { triggeredAt: shanghaiIso() };
    } else {
      const rawTargetPrice = Number(payload.targetPrice);
      const targetPriceMillis = toMillis(rawTargetPrice);
      if (!Number.isFinite(rawTargetPrice) || targetPriceMillis <= 0) {
        return Response.json({ error: "目标价不正确" }, { status: 400 });
      }
      // 改价视为一条全新的提醒：必须清掉旧的触发/已读状态，
      // 否则前端 checkAlerts 会因 triggeredAt 非空而永远跳过这条提醒。
      values = {
        targetPriceCents: Math.round(targetPriceMillis / 10),
        targetPriceMillis,
        triggeredAt: null,
        acknowledgedAt: null,
      };
    }
    const [alert] = await getDb().update(alertRules).set(values)
      .where(and(eq(alertRules.id, id), eq(alertRules.userId, user.id))).returning();
    return alert
      ? Response.json({ alert })
      : Response.json({ error: "提醒不存在" }, { status: 404 });
  } catch {
    return Response.json({ error: "提醒更新失败" }, { status: 500 });
  }
}
