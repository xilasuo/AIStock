import { desc, eq, or, isNull } from "drizzle-orm";
import { requireApiUser, pushSharedSecret, getAuthenticatedUser } from "../../../lib/auth";
import { getDb, ensureSchema } from "../../../db";
import { strategyWriteback } from "../../../db/schema";
import { shanghaiIso } from "../../../lib/time";

const MAX_PUSH_BYTES = 1_000_000;

/**
 * 回写结果接口（跨机器联动 · 本地 PC 推送 / 云端读取）
 *
 * 部署形态：trading_agent 运行在本地 PC，AIStock（本服务）部署在远程云服务器。
 * - GET  ：前端「回写结果」页读取最新候选回写信号（来自 D1 表 strategy_writeback）。
 * - POST ：本地 trading_agent 推送候选回写 JSON，校验 token 后写入 D1。
 *
 * 存储：使用 D1（Cloudflare Workers 原生、受沙箱允许），而非裸文件系统写入。
 *   docker-compose 把 ./data 挂为 --persist-to /data，D1 持久化与此卷绑定，容器重建不丢。
 *
 * 鉴权：POST 需要 header `x-push-token`，值等于云端环境变量
 *   STRATEGY_PUSH_TOKEN（未设置时回退到 CRON_SECRET）。
 *
 * 说明：当前本环境的 tdx-connector 仅暴露查询工具（无 place_order），
 *   因此枢纽推送过来的信号恒为「候选回写 / dry-run」，真实下单需接入带下单能力的连接器。
 */
export async function GET() {
  const unauthorized = await requireApiUser();
  if (unauthorized) return unauthorized;
  // 按登录用户隔离：优先返回本人回写结果；本人从未推送过时回退全局默认（user_id IS NULL）。
  const user = await getAuthenticatedUser();
  const userId = user?.id;
  try {
    await ensureSchema();
    const db = getDb();
    const rows = await db
      .select()
      .from(strategyWriteback)
      .where(userId != null ? or(eq(strategyWriteback.userId, userId), isNull(strategyWriteback.userId)) : isNull(strategyWriteback.userId))
      .orderBy(desc(strategyWriteback.createdAt))
      .limit(1);
    if (!rows.length) {
      return Response.json(
        {
          ok: false,
          error:
            "尚未生成回写结果。请先在本地 PC 运行 trading_agent，并推送到本服务（POST /api/writeback-signals）。",
        },
        { status: 404 },
      );
    }
    const writeback = JSON.parse(rows[0].payload);
    return Response.json({ ok: true, writeback, scope: rows[0].userId != null ? "user" : "global" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
}

export async function POST(req: Request) {
  // 推送鉴权：本地 PC 持有的 token 需与云端一致
  const secret = pushSharedSecret();
  const provided =
    req.headers.get("x-push-token") ||
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ||
    undefined;
  if (!secret || provided !== secret) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const contentLength = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_PUSH_BYTES) {
    return Response.json({ ok: false, error: "payload too large" }, { status: 413 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  if (
    !body ||
    typeof body !== "object" ||
    !("signals" in (body as Record<string, unknown>))
  ) {
    return Response.json(
      { ok: false, error: "invalid payload: missing 'signals'" },
      { status: 400 },
    );
  }

  try {
    const payload = JSON.stringify(body);
    if (payload.length > MAX_PUSH_BYTES) {
      return Response.json({ ok: false, error: "payload too large" }, { status: 413 });
    }
    await ensureSchema();
    const db = getDb();
    // 身份归属：携带有效登录会话（Cookie）则写入本人隔离桶（user_id=本人），
    // 仅持共享令牌（无登录身份）则写入全局桶（user_id=NULL）。禁止由请求体伪造 user_id。
    const user = await getAuthenticatedUser();
    const userId = user?.id ?? null;
    await db.insert(strategyWriteback).values({ userId, payload });
    return Response.json({ ok: true, savedAt: shanghaiIso(), scope: userId != null ? "user" : "global" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json(
      { ok: false, error: `write failed: ${msg}` },
      { status: 500 },
    );
  }
}
