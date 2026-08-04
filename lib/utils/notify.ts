/**
 * 主动提醒推送（Proactive alert notifications）
 *
 * 前端在线时每 5 分钟轮询检查止损/止盈并即时提醒（页面内）；这里补齐"到了就推送"
 * 的主动闭环，用于用户离线兜底：由 Cloudflare Cron Trigger（或外部定时器）触发，
 * 拉取实时价、判断止盈/止损是否触发，触发后通过 Webhook（企业微信 / 飞书 / Slack / Bark）
 * 推送，并标记 triggeredAt 避免重复提醒。
 *
 * 对标：交易软件的"价格提醒推送"。
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "../../db/schema";
import { ensureSchema, getDb } from "../../db";
import { getRealtime } from "../market/market-data";
import { shanghaiIso } from "./time";

type NotifyEnv = {
  NOTIFY_WEBHOOK_URLS?: string;
};

async function getNotifyEnv(): Promise<NotifyEnv> {
  try {
    const mod = await import("cloudflare:workers");
    const env = (mod as unknown as { env?: Record<string, string | undefined> }).env ?? {};
    return { NOTIFY_WEBHOOK_URLS: env.NOTIFY_WEBHOOK_URLS ?? process.env?.NOTIFY_WEBHOOK_URLS };
  } catch {
    return { NOTIFY_WEBHOOK_URLS: process.env?.NOTIFY_WEBHOOK_URLS };
  }
}

export async function sendNotify(env: NotifyEnv, title: string, message: string): Promise<string[]> {
  const errors: string[] = [];
  const urls = (env.NOTIFY_WEBHOOK_URLS ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
  if (!urls.length) {
    errors.push("未配置 NOTIFY_WEBHOOK_URLS，无法推送提醒");
    return errors;
  }
  for (const url of urls) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, message, content: message, text: message }),
      });
      if (!response.ok) errors.push(`提醒推送返回 ${response.status}`);
    } catch (error) {
      errors.push(`提醒推送异常：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return errors;
}

export type AlertCheckResult = {
  checked: number;
  notified: number;
  errors: string[];
};

export async function checkAndNotifyAlerts(
  db: DrizzleD1Database<typeof schema> = getDb(),
): Promise<AlertCheckResult> {
  await ensureSchema();
  const env = await getNotifyEnv();
  const errors: string[] = [];
  const rules = await db
    .select()
    .from(schema.alertRules)
    .where(and(eq(schema.alertRules.enabled, true), isNull(schema.alertRules.triggeredAt)));

  // 多用户隔离：按归属用户分组推送，消息中标注用户名以区分
  const userIds = [...new Set(rules.map((r) => r.userId).filter((id) => id))];
  const userRows = userIds.length
    ? await db.select({ id: schema.users.id, username: schema.users.username }).from(schema.users).where(inArray(schema.users.id, userIds))
    : [];
  const usernameById = new Map(userRows.map((u) => [u.id, u.username]));

  const priceCache = new Map<string, number | null>();
  let notified = 0;

  for (const rule of rules) {
    let priceMillis = priceCache.get(rule.symbol);
    if (priceMillis === undefined) {
      try {
        const realtime = await getRealtime(rule.symbol);
        priceMillis = realtime?.price != null ? Math.round(realtime.price * 1000) : null;
      } catch {
        priceMillis = null;
      }
      priceCache.set(rule.symbol, priceMillis);
    }
    if (priceMillis === null) {
      errors.push(`无法获取 ${rule.symbol} 现价，跳过提醒（行情源暂不可用，建议稍后重试或检查网络）`);
      continue;
    }
    const targetMillis = rule.targetPriceMillis ?? rule.targetPriceCents * 10;
    const triggered = rule.type === "止损" ? priceMillis <= targetMillis : priceMillis >= targetMillis;
    if (!triggered) continue;

    const owner = rule.userId ? usernameById.get(rule.userId) : undefined;
    const ownerTag = owner ? `【${owner}】` : "";
    const arrow = rule.type === "止损" ? "跌破" : "触及";
    const title = `${ownerTag}${rule.name}（${rule.symbol}）${rule.type}提醒`;
    const message = `${ownerTag}${rule.name} 现价约 ¥${(priceMillis / 1000).toFixed(2)}，${arrow}${rule.type}目标 ¥${(targetMillis / 1000).toFixed(2)}。`;
    const notifyErrors = await sendNotify(env, title, message);
    errors.push(...notifyErrors);
    if (notifyErrors.length === 0) {
      await db
        .update(schema.alertRules)
        .set({ triggeredAt: shanghaiIso() })
        .where(eq(schema.alertRules.id, rule.id));
      notified += 1;
    }
  }

  return { checked: rules.length, notified, errors };
}
