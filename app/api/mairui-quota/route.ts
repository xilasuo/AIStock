import { env } from "cloudflare:workers";
import { getAuthenticatedUser } from "../../../lib/auth/auth";

const DAILY_LIMIT = 10_000;
const SOFT_LIMIT = 8_000;
const HARD_LIMIT = 9_500;

export type MairuiQuota = {
  date: string;
  used: number;
  limit: number;
  degraded: boolean;
  suspended: boolean;
  ratio: number;
};

/** 读取当日麦蕊真实消耗（D1 累计真值）。 */
export async function readMairuiQuota(): Promise<MairuiQuota> {
  const date = new Date().toISOString().slice(0, 10);
  const db = env.DB;
  const row = (await db
    .prepare(`SELECT used FROM mairui_quota WHERE date = ?`)
    .bind(date)
    .first<{ used: number } | null>()) as { used: number } | null;
  const used = row?.used ?? 0;
  return {
    date,
    used,
    limit: DAILY_LIMIT,
    degraded: used >= SOFT_LIMIT,
    suspended: used >= HARD_LIMIT,
    ratio: Math.min(1, used / DAILY_LIMIT),
  };
}

export async function POST(request: Request) {
  const user = await getAuthenticatedUser();
  if (!user) return Response.json({ error: "请先登录" }, { status: 401 });
  if (user.role !== "super_admin") {
    return Response.json({ error: "仅超级管理员可重置麦蕊额度计数" }, { status: 403 });
  }
  const date = new Date().toISOString().slice(0, 10);
  const db = env.DB;
  await db
    .prepare(`INSERT INTO mairui_quota(date, used) VALUES(?, 0) ON CONFLICT(date) DO UPDATE SET used = 0`)
    .bind(date)
    .run();
  return Response.json(await readMairuiQuota());
}

export async function GET() {
  const user = await getAuthenticatedUser();
  if (!user) return Response.json({ error: "请先登录" }, { status: 401 });
  return Response.json(await readMairuiQuota());
}
