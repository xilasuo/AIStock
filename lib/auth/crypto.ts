// 与 Workers 运行时无关的密码学工具：PBKDF2 密码哈希、会话 token 签发/验证。
// 抽离自 lib/auth.ts，便于在 Node 测试环境下直接单测（auth.ts 顶层 import
// "cloudflare:workers" 无法在普通 Node 运行时解析）。

const SESSION_SECONDS = 60 * 60 * 24 * 30;

export type SessionUser = {
  id: number;
  username: string;
  displayName: string;
  role: "super_admin" | "user";
  email?: string;
};

export function generateSalt(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

export async function hashPassword(password: string, salt: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: encoder.encode(salt), iterations: 100_000, hash: "SHA-256" },
    keyMaterial,
    256,
  );
  return bytesToBase64Url(new Uint8Array(bits));
}

export async function signToken(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return bytesToBase64Url(new Uint8Array(signature));
}

export async function verifyToken(
  token: string,
  secret: string,
): Promise<SessionUser | null> {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) return null;
  if (!(await safeEqual(signature, await signToken(payload, secret)))) return null;

  try {
    const parsed = JSON.parse(fromBase64Url(payload)) as {
      sub?: unknown;
      username?: unknown;
      role?: unknown;
      expiresAt?: unknown;
    };
    if (
      typeof parsed.sub !== "number" ||
      typeof parsed.username !== "string" ||
      (parsed.role !== "super_admin" && parsed.role !== "user") ||
      typeof parsed.expiresAt !== "number"
    ) {
      return null;
    }
    if (parsed.expiresAt <= Math.floor(Date.now() / 1000)) return null;
    return {
      id: parsed.sub,
      username: parsed.username,
      displayName: parsed.username,
      role: parsed.role,
    };
  } catch {
    return null;
  }
}

export async function createSessionToken(
  user: { id: number; username: string; role: "super_admin" | "user" },
  secret: string,
  nowMs = Date.now(),
): Promise<string> {
  const expiresAt = Math.floor(nowMs / 1000) + SESSION_SECONDS;
  const payload = toBase64Url(
    JSON.stringify({ sub: user.id, username: user.username, role: user.role, expiresAt }),
  );
  const signature = await signToken(payload, secret);
  return `${payload}.${signature}`;
}

export async function safeEqual(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftHash);
  const rightBytes = new Uint8Array(rightHash);
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index] ^ rightBytes[index];
  }
  return difference === 0;
}

function toBase64Url(value: string): string {
  return bytesToBase64Url(new TextEncoder().encode(value));
}

function fromBase64Url(value: string): string {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  return new TextDecoder().decode(Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)));
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/**
 * 纯逻辑比较「请求方提供的令牌」与「云端共享密钥」是否一致。
 * 抽离出 env/Request 依赖以便单测（verifyPushToken 在 auth.ts 中读 env 后调用）。
 *
 * 规则：
 * - 密钥或令牌任一为空 → false（不允许空令牌通过）
 * - 统一恒定时间比较（safeEqual），避免响应耗时侧信道逐字节爆破
 */
export function verifyPushTokenValue(
  provided: string | undefined,
  secret: string | undefined,
): Promise<boolean> {
  if (!secret || !provided) return Promise.resolve(false);
  return safeEqual(provided, secret);
}

export { SESSION_SECONDS };
