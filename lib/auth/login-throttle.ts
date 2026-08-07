// 登录失败限流（纯逻辑，无 env / Request 依赖，便于单测）。
//
// 背景：登录接口原先无任何失败计数与退避，配合已公开的部署地址，暴力破解成本极低。
// 这里按「用户名 + 客户端 IP」双维度计数，任一维度超阈值即拒绝，防止：
//   - 单账号密码爆破（用户名维度）；
//   - 撞库 / 账号枚举（IP 维度，换用户名也拦得住）。
//
// 实现取舍：Workers 每个 isolate 内存独立，此处为进程内限流，
// 并非全局强一致——但对暴力破解已能形成数量级上的成本提升。
// 若需跨 isolate 严格限流，应改由 D1 或 Durable Object 承载。

/** 计数窗口：15 分钟内的失败次数累计。 */
export const WINDOW_MS = 15 * 60 * 1000;
/** 同一用户名允许的连续失败次数。 */
export const MAX_FAILURES_PER_USER = 5;
/** 同一 IP 允许的连续失败次数（高于用户维度，容忍公司内网共用出口 IP）。 */
export const MAX_FAILURES_PER_IP = 20;
/** 触发限流后的基础锁定时长，随失败次数指数退避。 */
export const BASE_LOCK_MS = 60 * 1000;
/** 锁定时长上限，避免无限增长导致正常用户长期无法登录。 */
export const MAX_LOCK_MS = 30 * 60 * 1000;

type Bucket = {
  failures: number;
  firstFailureAt: number;
  lockedUntil: number;
};

export type ThrottleDecision =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

const buckets = new Map<string, Bucket>();

/**
 * 上限保护：防止攻击者用海量随机用户名 / 伪造 IP 撑爆内存。
 * 超过上限时清理已过期条目，仍然超限则整体重置（宁可放宽限流也不 OOM）。
 */
const MAX_BUCKETS = 10_000;

function sweep(now: number): void {
  for (const [key, bucket] of buckets) {
    const expired = now - bucket.firstFailureAt >= WINDOW_MS && now >= bucket.lockedUntil;
    if (expired) buckets.delete(key);
  }
  if (buckets.size > MAX_BUCKETS) buckets.clear();
}

function lockDurationFor(failures: number, threshold: number): number {
  // 超出阈值后每多失败一次，锁定时长翻倍：60s → 120s → 240s ... 直至上限。
  const excess = Math.max(0, failures - threshold);
  return Math.min(BASE_LOCK_MS * 2 ** excess, MAX_LOCK_MS);
}

function peek(key: string, now: number): ThrottleDecision {
  const bucket = buckets.get(key);
  if (!bucket) return { allowed: true };
  if (now < bucket.lockedUntil) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.lockedUntil - now) / 1000)),
    };
  }
  return { allowed: true };
}

/**
 * 登录尝试前检查是否已被限流。返回 allowed=false 时应直接拒绝，
 * 不要执行密码哈希校验（既省 CPU，也避免通过响应耗时区分账号是否存在）。
 */
export function checkLoginAllowed(
  username: string,
  clientIp: string,
  now: number = Date.now(),
): ThrottleDecision {
  sweep(now);
  const userDecision = peek(userKey(username), now);
  if (!userDecision.allowed) return userDecision;
  return peek(ipKey(clientIp), now);
}

/** 登录失败后调用：累加计数，达到阈值则进入指数退避锁定。 */
export function recordLoginFailure(
  username: string,
  clientIp: string,
  now: number = Date.now(),
): void {
  bump(userKey(username), MAX_FAILURES_PER_USER, now);
  bump(ipKey(clientIp), MAX_FAILURES_PER_IP, now);
}

/** 登录成功后调用：清空该用户名与该 IP 的失败计数。 */
export function recordLoginSuccess(
  username: string,
  clientIp: string,
): void {
  buckets.delete(userKey(username));
  buckets.delete(ipKey(clientIp));
}

function bump(key: string, threshold: number, now: number): void {
  const existing = buckets.get(key);
  if (!existing || now - existing.firstFailureAt >= WINDOW_MS) {
    // 新窗口：重新计数。未达阈值时不锁定。
    const failures = 1;
    buckets.set(key, {
      failures,
      firstFailureAt: now,
      lockedUntil: failures >= threshold ? now + lockDurationFor(failures, threshold) : 0,
    });
    return;
  }
  existing.failures += 1;
  if (existing.failures >= threshold) {
    existing.lockedUntil = now + lockDurationFor(existing.failures, threshold);
  }
}

/**
 * 从请求头解析客户端 IP。Cloudflare always 注入 CF-Connecting-IP，
 * 该头由边缘覆写、客户端无法伪造，优先采用；其余头仅作自托管部署的兜底。
 */
export function clientIpFrom(headers: Headers): string {
  return (
    headers.get("cf-connecting-ip") ||
    headers.get("x-real-ip") ||
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

function userKey(username: string): string {
  return `u:${username.toLowerCase()}`;
}

function ipKey(ip: string): string {
  return `ip:${ip}`;
}

/** 仅供测试使用：重置全部限流状态。 */
export function __resetLoginThrottle(): void {
  buckets.clear();
}
