import { desc, eq } from "drizzle-orm";
import { requireApiUser, getCurrentUser } from "../../../lib/auth/auth";
import { getDb, ensureSchema } from "../../../db";
import { strategyFeedback } from "../../../db/schema";

/**
 * 用户反馈接口（对应架构图「用户 → 本项目 → 优化策略」闭环）
 *
 * - GET  ：返回当前用户的历史反馈（隔离）。
 * - POST ：用户在前端「策略扫描」页对某只标的/某次信号给出有效/无效评价，落库。
 *
 * 鉴权：需登录会话（requireApiUser）。
 */
export async function GET() {
  const unauthorized = await requireApiUser();
  if (unauthorized) return unauthorized;

  try {
    const user = await getCurrentUser();
    await ensureSchema();
    const db = getDb();
    const rows = await db
      .select()
      .from(strategyFeedback)
      .where(eq(strategyFeedback.userId, user.id))
      .orderBy(desc(strategyFeedback.createdAt))
      .limit(100);
    return Response.json({ ok: true, feedback: rows });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const unauthorized = await requireApiUser();
  if (unauthorized) return unauthorized;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  const b = body as Record<string, unknown>;
  const symbol = String(b.symbol ?? "").trim();
  if (!symbol) {
    return Response.json({ ok: false, error: "symbol required" }, { status: 400 });
  }
  const verdict = b.verdict === "无效" ? "无效" : "有效";
  const name = String(b.name ?? "").trim();
  const note = String(b.note ?? "").trim().slice(0, 500);
  const source = String(b.source ?? "web").trim().slice(0, 20);
  // 因子贡献明细（前端选股结果里的 factors）：供 optimizer 反向调权重。
  let factors = "";
  if (b.factors && typeof b.factors === "object") {
    try {
      factors = JSON.stringify(b.factors);
    } catch {
      factors = "";
    }
  }

  try {
    const user = await getCurrentUser();
    await ensureSchema();
    const db = getDb();
    await db.insert(strategyFeedback).values({ userId: user.id, symbol, name, verdict, note, source, factors });
    return Response.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
}
