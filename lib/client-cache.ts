/**
 * 前端 localStorage 缓存工具。
 *
 * 用途：
 *  - 将「最近分析」与「行情快照」持久化到 localStorage，刷新页面时免首屏空白。
 *  - 每个缓存项附带过期时间（TTL），读取时自动剔除过期数据，避免展示陈旧行情。
 *
 * 说明：
 *  - localStorage 在 SSR 环境不可用，所有读写都需判断 typeof window。
 *  - 写入前做大小保护，避免单文件撑爆 localStorage（约 5MB）。
 */

const PREFIX = "aistock:";

const DEFAULT_TTL_MS = {
  /** 最近分析记录，长期保留 */
  recent: 7 * 24 * 60 * 60 * 1000,
  /** 行情快照，短暂保留，刷新页面时用于首屏，随后由轮询覆盖 */
  quote: 10 * 60 * 1000,
};

type TtlKey = keyof typeof DEFAULT_TTL_MS;

function isClient() {
  return typeof window !== "undefined";
}

function buildKey(key: string) {
  return PREFIX + key;
}

/** 读取缓存，若不存在或已过期返回 null */
export function readCache<T>(key: string, ttlKey: TtlKey = "recent"): T | null {
  if (!isClient()) return null;
  try {
    const raw = window.localStorage.getItem(buildKey(key));
    if (!raw) return null;
    const entry = JSON.parse(raw) as { ts: number; data: T };
    if (typeof entry?.ts !== "number" || typeof entry?.data === "undefined") return null;
    const ttl = DEFAULT_TTL_MS[ttlKey];
    if (ttl > 0 && Date.now() - entry.ts > ttl) {
      window.localStorage.removeItem(buildKey(key));
      return null;
    }
    return entry.data;
  } catch {
    // 解析失败视为无缓存
    return null;
  }
}

/** 写入缓存。若序列化后超限则放弃写入，避免撑爆 localStorage。 */
export function writeCache(key: string, data: unknown): void {
  if (!isClient()) return;
  try {
    const raw = JSON.stringify({ ts: Date.now(), data });
    // 行情快照可能较大，超过 2MB 直接放弃（约等于 localStorage 容量的一半）
    if (raw.length > 2 * 1024 * 1024) return;
    window.localStorage.setItem(buildKey(key), raw);
  } catch {
    // 配额不足等异常静默忽略
  }
}

/** 删除缓存项 */
export function removeCache(key: string): void {
  if (!isClient()) return;
  try {
    window.localStorage.removeItem(buildKey(key));
  } catch {
    /* ignore */
  }
}
