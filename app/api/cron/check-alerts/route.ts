import { checkAndNotifyAlerts } from "../../../../lib/utils/notify";
import { requireApiUser } from "../../../../lib/auth/auth";

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
  const unauthorized = await requireApiUser();
  if (!unauthorized) {
    const result = await checkAndNotifyAlerts();
    return Response.json(result);
  }
  const header = request.headers.get("authorization") ?? "";
  const secret = await getCronSecret();
  if (!secret || header !== `Bearer ${secret}`) {
    return Response.json({ error: "未授权" }, { status: 401 });
  }
  const result = await checkAndNotifyAlerts();
  return Response.json(result);
}

export async function GET(request: Request) {
  return POST(request);
}
