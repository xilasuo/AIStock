import { and, desc, eq } from "drizzle-orm";
import { ensureSchema, getDb } from "../../../db";
import { accountSettings, capitalFlows } from "../../../db/schema";
import { getCurrentUser, requireApiUser } from "../../../lib/auth/auth";
import { shanghaiIso } from "../../../lib/utils/time";

export async function GET() {
  const unauthorized = await requireApiUser();
  if (unauthorized) return unauthorized;
  try {
    const user = await getCurrentUser();
    await ensureSchema();
    const db = getDb();
    const [settings, flows] = await Promise.all([
      db.select().from(accountSettings).where(eq(accountSettings.userId, user.id)).limit(1),
      db.select().from(capitalFlows)
        .where(eq(capitalFlows.userId, user.id))
        .orderBy(desc(capitalFlows.flowDate), desc(capitalFlows.id)),
    ]);
    return Response.json({
      initialCapitalCents: settings[0]?.initialCapitalCents ?? null,
      capitalFlows: flows.map((f) => ({
        id: f.id,
        amountCents: f.amountCents,
        flowDate: f.flowDate,
        note: f.note,
        createdAt: f.createdAt,
      })),
    });
  } catch {
    return Response.json({ error: "账户资金设置暂时无法读取" }, { status: 503 });
  }
}

export async function PUT(request: Request) {
  const unauthorized = await requireApiUser();
  if (unauthorized) return unauthorized;

  const user = await getCurrentUser();
  const payload = await request.json().catch(() => null) as {
    initialCapital?: number;
    action?: string;
    amountCents?: number;
    flowDate?: string;
    note?: string;
    flowId?: number;
  } | null;

  await ensureSchema();
  const db = getDb();

  // 删除出入金流水
  if (payload?.action === "delete_flow" && payload.flowId) {
    try {
      await db.delete(capitalFlows)
        .where(and(eq(capitalFlows.id, payload.flowId), eq(capitalFlows.userId, user.id)));
      return Response.json({ ok: true });
    } catch {
      return Response.json({ error: "删除失败" }, { status: 500 });
    }
  }

  // 新增出入金流水
  if (payload?.action === "create_flow") {
    const amount = Number(payload.amountCents);
    const flowDate = String(payload.flowDate ?? "").trim();
    if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 1_000_000_000_00) {
      return Response.json({ error: "金额无效，范围 1~10亿 元" }, { status: 400 });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(flowDate)) {
      return Response.json({ error: "日期格式无效" }, { status: 400 });
    }
    try {
      await db.insert(capitalFlows).values({
        userId: user.id,
        amountCents: Math.round(amount),
        flowDate,
        note: String(payload.note ?? "").trim() || null,
        createdAt: shanghaiIso(),
      });
      return Response.json({ ok: true });
    } catch {
      return Response.json({ error: "保存失败" }, { status: 500 });
    }
  }

  // 设置初始资金
  if (payload?.initialCapital !== undefined) {
    const initialCapital = Number(payload.initialCapital);
    if (!Number.isFinite(initialCapital) || initialCapital < 100 || initialCapital > 1_000_000_000) {
      return Response.json({ error: "账户初始资金应在100元到10亿元之间" }, { status: 400 });
    }
    try {
      const initialCapitalCents = Math.round(initialCapital * 100);
      await db.insert(accountSettings).values({
        userId: user.id,
        initialCapitalCents,
        updatedAt: shanghaiIso(),
      }).onConflictDoUpdate({
        target: accountSettings.userId,
        set: { initialCapitalCents, updatedAt: shanghaiIso() },
      });
      return Response.json({ initialCapitalCents });
    } catch {
      return Response.json({ error: "账户资金设置保存失败" }, { status: 500 });
    }
  }

  return Response.json({ error: "无效的请求" }, { status: 400 });
}
