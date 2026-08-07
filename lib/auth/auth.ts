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
  verifyPushTokenValue,
  type SessionUser,
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

  // 验签只证明 token 未被篡改，不代表账号当前仍然有效。必须回查数据库，
  // 否则「禁用 / 删除 / 改密 / 降级」在 token 自然过期前（最长 30 天）全部无效：
  //   - 已禁用或已删除的用户仍能访问全部业务接口；
  //   - 被降级的超管凭旧 token 仍可通过 requireSuperAdmin，构成权限提升。
  // 角色一律以库为准，不信任 token 内的 role。
  return resolveLiveUser(payload);
}

/**
 * 用会话 payload 回查数据库，返回「当前仍然有效」的用户；任一条件不满足即视为未登录：
 * 用户不存在（已删除）、已禁用、token_version 已自增（改密/禁用/改角色后作废存量会话）。
 *
 * 返回值中的 role / username 以数据库为准，避免 token 内的陈旧值被信任。
 */
async function resolveLiveUser(session: SessionUser): Promise<AuthenticatedUser | null> {
  let row;
  try {
    const db = getDb();
    const rows = await db
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        role: users.role,
        disabled: users.disabled,
        tokenVersion: users.tokenVersion,
      })
      .from(users)
      .where(eq(users.id, session.id))
      .limit(1);
    row = rows[0];
  } catch (error) {
    // 数据库不可用时保守判定为未登录（fail-closed），不放行任何请求。
    console.error("[auth] 回查用户失败，按未登录处理", error);
    return null;
  }

  if (!row || row.disabled) return null;
  if ((row.tokenVersion ?? 0) !== session.tokenVersion) return null;

  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName || row.username,
    role: row.role as "super_admin" | "user",
  };
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
 * 比较逻辑在 crypto.verifyPushTokenValue（纯函数，可单测）；此处仅负责从
 * 请求头提取令牌并读取云端密钥。统一恒定时间比较，避免响应耗时侧信道。
 */
export async function verifyPushToken(req: Request): Promise<boolean> {
  const secret = pushSharedSecret();
  const provided =
    req.headers.get("x-push-token") ||
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ||
    undefined;
  return verifyPushTokenValue(provided, secret);
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

async function verifySessionToken(token: string, secret: string): Promise<SessionUser | null> {
  return verifyToken(token, secret);
}

// 账户管理接口复用同一套密码哈希工具（实现位于 lib/crypto.ts）
export { generateSalt, hashPassword };
