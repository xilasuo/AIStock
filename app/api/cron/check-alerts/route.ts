import { checkAndNotifyAlerts } from "../../../../lib/utils/notify";
import { getAuthenticatedUser } from "../../../../lib/auth/auth";

/** 读取 Cron 预共享密钥（用于无 Cookie 的定时器调用）。 */
async function getCronSecret(): Promise<string | undefined> {
  try {
    const mod = await import("cloudflare:workers");
    const env = (mod as unknown as { env?: Record<string, string | undefined> }).env ?? {};
    return env.CRON_SECRET ?? process.env?.CRON_SECRET;
  } catch {
    return process.env?.CRON_SECRET;
  }
}

export async function POST(request: Request) {
  // 调度器通道：Cloudflare Cron 定时器无会话，凭 CRON_SECRET（Bearer）调用。
  const header = request.headers.get("authorization") ?? "";
  const secret = await getCronSecret();
  if (secret && header === `Bearer ${secret}`) {
    const result = await checkAndNotifyAlerts();
    return Response.json(result);
  }
  // 人工触发：必须是已登录的超级管理员，避免任意普通用户触发全站 webhook 推送。
  const user = await getAuthenticatedUser();
  if (!user) {
    return Response.json({ error: "请先登录后再使用" }, { status: 401 });
  }
  if (user.role !== "super_admin") {
    return Response.json({ error: "仅超级管理员可手动触发提醒检查" }, { status: 403 });
  }
  const result = await checkAndNotifyAlerts();
  return Response.json(result);
}

export async function GET(request: Request) {
  return POST(request);
}
