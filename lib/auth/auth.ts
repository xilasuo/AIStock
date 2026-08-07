import { env } from "cloudflare:workers";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { getDb, ensureSchema } from "../../db";
import { users } from "../../db/schema";
import {
  createSessionToken,
  verifyToken,
  safeEqual,
  generateSalt,
  hashPassword,
  SESSION_SECONDS,
} from "./crypto";

export type AuthenticatedUser = {
  id: number;
  username: string;
  displayName: string;
  role: "super_admin" | "user";
  email?: string;
};

const COOKIE_NAME = "stock_assistant_session";

type AuthConfig = {
  secret: string;
};

export function isAuthConfigured(): boolean {
  const runtimeEnv = env as unknown as { APP_AUTH_SECRET?: string };
  const secret = runtimeEnv.APP_AUTH_SECRET ?? "";
  return secret.length >= 32;
}

export async function getAuthenticatedUser(): Promise<AuthenticatedUser | null> {
  // 任何鉴权请求都先确保 schema 就绪（建表 + 初始化超级管理员 + 老数据归属）。
  // 这样首次部署后无需先走登录接口也能建表，避免未登录请求提前返回 401 导致表永不创建。
  try {
    await ensureSchema();
  } catch {
    // 建表失败不应阻断鉴权流程，交由后续逻辑处理
  }

  const config = getAuthConfig();
  if (!config) return null;

  const token = (await cookies()).get(COOKIE_NAME)?.value;
  if (!token) return null;

  const payload = await verifySessionToken(token, config.secret);
  if (!payload) return null;

  return payload;
}

export async function requireAuthenticatedUser(): Promise<AuthenticatedUser> {
  const user = await getAuthenticatedUser();
  if (user) return user;
  redirect("/login");
}

export async function requireApiUser(): Promise<Response | null> {
  const user = await getAuthenticatedUser();
  if (user) return null;
  return Response.json({ error: "请先登录后再使用" }, { status: 401 });
}

/** 推送令牌（与扫描/回写推送同源）：STRATEGY_PUSH_TOKEN，未设置时回退 CRON_SECRET。 */
export function pushSharedSecret(): string | undefined {
  const runtimeEnv = env as unknown as {
    STRATEGY_PUSH_TOKEN?: string;
    CRON_SECRET?: string;
  };
  return runtimeEnv.STRATEGY_PUSH_TOKEN || runtimeEnv.CRON_SECRET || undefined;
}

/**
 * 校验请求头中的推送令牌是否与云端 STRATEGY_PUSH_TOKEN（回退 CRON_SECRET）一致。
 *
 * 统一使用恒定时间比较（safeEqual），避免通过响应耗时侧信道逐字节爆破令牌；
 * 未配置密钥或未携带令牌时一律返回 false（不允许空令牌通过）。
 */
export async function verifyPushToken(req: Request): Promise<boolean> {
  const secret = pushSharedSecret();
  const provided =
    req.headers.get("x-push-token") ||
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ||
    undefined;
  if (!secret || !provided) return false;
  return safeEqual(provided, secret);
}

/**
 * 登录会话「或」推送令牌任一通过即可（用于读取类接口，如策略配置 GET）。
 *
 * 设计意图：多用户改造后所有 API 都要求登录会话（requireApiUser）。
 * 但本地程序 / 自动化（run_hub / pull_cloud_config）是无浏览器会话的机器调用，
 * 靠 admin 密码登录容易因云端管理员密码变更而失败。允许复用已验证可用的
 * 推送令牌（x-push-token）拉取配置，避免「多用户」登录态导致云端配置拉取失败。
 * 写入类接口（如保存配置 POST）仍保持 requireApiUser，不开放令牌写入。
 */
export async function requireApiUserOrPushToken(
  req: Request,
): Promise<Response | null> {
  const user = await getAuthenticatedUser();
  if (user) return null;
  if (await verifyPushToken(req)) return null;
  return Response.json({ error: "请先登录后再使用" }, { status: 401 });
}

/** 当前登录用户，未登录抛 401 Response（供需要 userId 的路由快速取用）。 */
export async function getCurrentUser(): Promise<AuthenticatedUser> {
  const user = await getAuthenticatedUser();
  if (!user) {
    throw Response.json({ error: "请先登录后再使用" }, { status: 401 });
  }
  return user;
}

/** 仅超级管理员可通过，否则抛 403 Response。 */
export async function requireSuperAdmin(): Promise<AuthenticatedUser> {
  const user = await getCurrentUser();
  if (user.role !== "super_admin") {
    throw Response.json({ error: "仅超级管理员可执行此操作" }, { status: 403 });
  }
  return user;
}

export async function authenticate(username: string, password: string): Promise<string | null> {
  const config = getAuthConfig();
  if (!config) return null;

  await ensureSchema();
  const db = getDb();
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.username, username))
    .limit(1);
  const user = rows[0];
  if (!user || user.disabled) return null;

  const hash = await hashPassword(password, user.salt);
  if (!await safeEqual(hash, user.passwordHash)) return null;

  return createSessionToken(user, config.secret);
}

export function sessionCookie(token: string, secure: boolean): string {
  return [
    `${COOKIE_NAME}=${token}`,
    "Path=/",
    `Max-Age=${SESSION_SECONDS}`,
    "HttpOnly",
    "SameSite=Lax",
    secure ? "Secure" : "",
  ].filter(Boolean).join("; ");
}

export function clearSessionCookie(secure: boolean): string {
  return [
    `${COOKIE_NAME}=`,
    "Path=/",
    "Max-Age=0",
    "HttpOnly",
    "SameSite=Lax",
    secure ? "Secure" : "",
  ].filter(Boolean).join("; ");
}

function getAuthConfig(): AuthConfig | null {
  const runtimeEnv = env as unknown as { APP_AUTH_SECRET?: string };
  const secret = runtimeEnv.APP_AUTH_SECRET ?? "";
  if (secret.length < 32) return null;
  return { secret };
}

async function verifySessionToken(token: string, secret: string): Promise<AuthenticatedUser | null> {
  const session = await verifyToken(token, secret);
  if (!session) return null;
  return {
    id: session.id,
    username: session.username,
    displayName: session.displayName,
    role: session.role,
  };
}

// 账户管理接口复用同一套密码哈希工具（实现位于 lib/crypto.ts）
export { generateSalt, hashPassword };
