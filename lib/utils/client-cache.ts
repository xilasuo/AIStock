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

/**
 * 清空全部应用缓存（aistock: 前缀）。
 * 用于退出登录时彻底抹除本地行情/分析等数据，避免不同账号间残留。
 */
export function clearAllAppCache(): void {
  if (!isClient()) return;
  try {
    const targets: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (key && key.startsWith(PREFIX)) targets.push(key);
    }
    for (const key of targets) window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/** 按前缀删除缓存项（如清空 assistant:{userId}:* 对话历史） */
export function removeCacheByPrefix(prefix: string): void {
  if (!isClient()) return;
  try {
    const targets: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (key && key.startsWith(PREFIX + prefix)) targets.push(key);
    }
    for (const key of targets) window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/**
 * 多值字典缓存（如行情快照 quotes）：与 readCache/writeCache 的「单值单时间戳」不同，
 * 这里按「单只 key 独立时间戳」存储，读取时逐项剔除过期数据，避免某一只股票长期
 * 显示陈旧行情；同时限制条目数并对体积做保护，避免无限增长撑爆 localStorage。
 *
 * 约定：写入的 value 应已裁剪为展示必需字段（如 stock/quote/history），否则体积过大时
 * 会被 2MB 保护直接放弃写入。
 */
const KEYED_CACHE_MAX_ENTRIES = 60;

export function writeKeyedCache<T>(
  key: string,
  entries: Record<string, T>,
  maxEntries: number = KEYED_CACHE_MAX_ENTRIES,
): void {
  if (!isClient()) return;
  try {
    const now = Date.now();
    const codes = Object.keys(entries).slice(-maxEntries);
    const payload: Record<string, { ts: number; data: T }> = {};
    for (const code of codes) payload[code] = { ts: now, data: entries[code] };
    const raw = JSON.stringify({ ts: now, data: payload });
    // 单个缓存文件超过 2MB 直接放弃，避免撑爆 localStorage（约 5MB）
    if (raw.length > 2 * 1024 * 1024) return;
    window.localStorage.setItem(buildKey(key), raw);
  } catch {
    /* 配额不足等异常静默忽略 */
  }
}

/** 读取多值字典缓存，逐项剔除过期 key；无有效数据返回 null。剔除了过期项会回写精简缓存。 */
export function readKeyedCache<T>(
  key: string,
  ttlMs: number,
  maxEntries: number = KEYED_CACHE_MAX_ENTRIES,
): Record<string, T> | null {
  if (!isClient()) return null;
  try {
    const raw = window.localStorage.getItem(buildKey(key));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      ts: number;
      data: Record<string, { ts: number; data: T } | T>;
    };
    const now = Date.now();
    const result: Record<string, T> = {};
    let changed = false;
    for (const [code, wrapped] of Object.entries(parsed.data ?? {})) {
      if (wrapped == null) continue;
      // 兼容旧格式：旧缓存直接把值作为 data（无内层 {ts,data}），用外层 ts 判定过期
      const isWrapped = typeof wrapped === "object" && "ts" in wrapped && "data" in wrapped;
      const entryTs = isWrapped ? (wrapped as { ts: number }).ts : parsed.ts;
      const entryData = isWrapped ? (wrapped as { data: T }).data : (wrapped as T);
      if (entryData == null) continue;
      if (now - entryTs > ttlMs) {
        changed = true;
        continue;
      }
      result[code] = entryData;
    }
    if (Object.keys(result).length === 0) {
      window.localStorage.removeItem(buildKey(key));
      return null;
    }
    // 剔除了过期项则回写精简后的缓存，避免缓存体积只增不减
    if (changed) writeKeyedCache(key, result, maxEntries);
    return result;
  } catch {
    return null;
  }
}

/**
 * 读取多值字典缓存并返回每项的时间戳（{ data, tsByKey }）。
 * 供前端恢复行情快照时同步恢复"新鲜度时间戳"：刷新页面后内存 ref 丢失，
 * 若直接用空 ref 判定全部过期，会触发一轮全量重拉（localStorage 缓存形同虚设）。
 * 复用 readKeyedCache 的过期剔除逻辑。
 */
export function readKeyedCacheWithMeta<T>(
  key: string,
  ttlMs: number,
  maxEntries: number = KEYED_CACHE_MAX_ENTRIES,
): { data: Record<string, T>; tsByKey: Record<string, number> } | null {
  if (!isClient()) return null;
  try {
    const raw = window.localStorage.getItem(buildKey(key));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      ts: number;
      data: Record<string, { ts: number; data: T } | T>;
    };
    const now = Date.now();
    const result: Record<string, T> = {};
    const tsByKey: Record<string, number> = {};
    let changed = false;
    for (const [code, wrapped] of Object.entries(parsed.data ?? {})) {
      if (wrapped == null) continue;
      const isWrapped = typeof wrapped === "object" && "ts" in wrapped && "data" in wrapped;
      const entryTs = isWrapped ? (wrapped as { ts: number }).ts : parsed.ts;
      const entryData = isWrapped ? (wrapped as { data: T }).data : (wrapped as T);
      if (entryData == null) continue;
      if (now - entryTs > ttlMs) {
        changed = true;
        continue;
      }
      result[code] = entryData;
      tsByKey[code] = entryTs;
    }
    if (Object.keys(result).length === 0) {
      window.localStorage.removeItem(buildKey(key));
      return null;
    }
    if (changed) writeKeyedCache(key, result, maxEntries);
    return { data: result, tsByKey };
  } catch {
    return null;
  }
}
