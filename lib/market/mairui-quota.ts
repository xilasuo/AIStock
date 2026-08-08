// 麦蕊（mairuiapi.com）每日额度预算协调器。
//
// 麦蕊免费档每天 10000 次调用额度，真实消耗由服务端 lib/market/mairui.ts 在每次真正
// 向麦蕊发起 HTTP 请求时累加进 D1（mairui_quota 表，跨 isolate / 多用户共享真值）。
//
// 本模块在前端做两层事情：
//   1) planRefresh：行情轮询节奏判断（交易时段 10s / 非交易停 / 失焦停 / 额度降级）。
//      优先使用后端真实配额（serverQuota），离线时回退本地 localStorage 估计。
//   2) useMairuiQuota Hook：角标展示真实今日消耗，可手动刷新 / 重置（super_admin）。

import React from "react";

const LS_KEY = "mairui_quota_v1";
export const DAILY_LIMIT = 10_000; // 麦蕊每日额度上限
export const SOFT_LIMIT = 8_000; // 软上限：超过则前端刷新降到 30s 降级档
export const HARD_LIMIT = 9_500; // 硬上限：超过则前端暂停主动刷新（仅手动/重进才刷）

type QuotaState = {
  date: string; // 本地日期 YYYY-MM-DD（按上海时区，与 server 口径一致）
  used: number; // 当日估计已消耗
};

type QuotaStatus = {
  used: number;
  limit: number;
  degraded: boolean;
  suspended: boolean;
  ratio: number;
};

// 后端真实配额缓存（由 fetchQuota 写入）。planRefresh 优先用它，离线时回退本地估计。
let serverQuota: QuotaStatus | null = null;

function todayKey(): string {
  // 用上海日期作为额度日界，避免跨时区把"昨天"的消耗算到"今天"。
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  void y; void m; void day;
  return new Date().toISOString().slice(0, 10);
}

function load(): QuotaState {
  if (typeof window === "undefined") return { date: todayKey(), used: 0 };
  try {
    const raw = window.localStorage.getItem(LS_KEY);
    if (!raw) return { date: todayKey(), used: 0 };
    const parsed = JSON.parse(raw) as QuotaState;
    if (parsed.date !== todayKey()) return { date: todayKey(), used: 0 };
    return parsed;
  } catch {
    return { date: todayKey(), used: 0 };
  }
}

function save(state: QuotaState) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LS_KEY, JSON.stringify(state));
  } catch {
    /* 配额记录失败不应影响主流程 */
  }
}

/** 记录一次（或 n 次）麦蕊额度消耗估计（离线兜底用，真实值由服务端 D1 累计）。 */
export function recordQuota(n = 1): void {
  const state = load();
  state.used += n;
  save(state);
}

export function quotaStatus(): QuotaStatus {
  const state = load();
  return {
    used: state.used,
    limit: DAILY_LIMIT,
    degraded: state.used >= SOFT_LIMIT,
    suspended: state.used >= HARD_LIMIT,
    ratio: Math.min(1, state.used / DAILY_LIMIT),
  };
}

/** 主动重置本地估计（服务端计数由 /api/mairui-quota POST 清零）。 */
export function resetQuota(): void {
  save({ date: todayKey(), used: 0 });
}

// --- 交易时段判断 + 刷新节奏 -------------------------------------------------

function shanghaiParts(date: Date): { h: number; m: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false,
  }).formatToParts(date);
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? "0";
  const dayMap: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 0 };
  return {
    h: parseInt(get("hour"), 10) || 0,
    m: parseInt(get("minute"), 10) || 0,
    day: dayMap[get("weekday")] ?? 0,
  };
}

/** 是否为 A 股盘中实时窗口（含上午/下午连续竞价，排除午休与周末）。 */
export function isRealtimeWindow(date: Date): boolean {
  const { h, m, day } = shanghaiParts(date);
  if (day === 0 || day === 6) return false;
  const t = h * 60 + m;
  return (t >= 9 * 60 + 30 && t <= 11 * 60 + 30) || (t >= 13 * 60 && t <= 15 * 60);
}

export type RefreshPlan = {
  /** 下次轮询应等待的毫秒数；返回 Infinity 表示当前应暂停主动刷新。 */
  delayMs: number;
  /** 轻量行情 TTL：超过该时长才视为过期重新拉取。 */
  ttlMs: number;
  /** 暂停原因（调试/UI 展示用），null 表示正常。 */
  paused: "off-hours" | "quota-suspended" | "hidden" | null;
};

/**
 * 计算下一轮轻量行情轮询的节奏：
 * - 非交易时段：停刷（Infinity），仅进入页面/手动时刷一次。
 * - 交易时段：openMs 间隔（默认 10s）。
 * - 额度软上限：间隔拉长到 30s。
 * - 额度硬上限或页面隐藏：暂停（Infinity）。
 * 配额优先取后端真实值 serverQuota，离线回退本地估计。
 */
export function planRefresh(date: Date, opts?: { openMs?: number; hidden?: boolean }): RefreshPlan {
  const openMs = opts?.openMs ?? 10_000;
  if (opts?.hidden) return { delayMs: Infinity, ttlMs: openMs, paused: "hidden" };
  const status = serverQuota ?? quotaStatus();
  if (status.suspended) return { delayMs: Infinity, ttlMs: openMs, paused: "quota-suspended" };
  if (!isRealtimeWindow(date)) return { delayMs: Infinity, ttlMs: 60_000, paused: "off-hours" };
  if (status.degraded) return { delayMs: 30_000, ttlMs: 30_000, paused: null };
  return { delayMs: openMs, ttlMs: openMs, paused: null };
}

// --- 前端 Hook：以服务端 D1 真实计数为准，localStorage 估计仅作离线兜底 --------

export type QuotaView = QuotaStatus & { source: "server" | "local" };

let cachedView: QuotaView | null = null;

/** 从后端读取真实今日额度（D1 累计）。失败回退到本地估计值。 */
export async function fetchQuota(): Promise<QuotaView> {
  try {
    const res = await fetch("/api/mairui-quota", { headers: { "Cache-Control": "no-store" } });
    if (res.ok) {
      const data = (await res.json()) as QuotaStatus;
      serverQuota = data; // 同步给 planRefresh 用
      cachedView = { ...data, source: "server" };
      return cachedView;
    }
  } catch {
    /* 网络/未登录：回退本地估计 */
  }
  const local = quotaStatus();
  cachedView = { ...local, source: "local" };
  return cachedView;
}

/**
 * 麦蕊额度角标 Hook：优先展示后端真实消耗，定期拉取刷新。
 * 返回最新视图 + 手动刷新 + 重置（重置需服务端 super_admin 权限，本地估计一并清零）。
 */
export function useMairuiQuota(pollMs = 30_000) {
  // 初始值统一用 used=0（SSR 与首次 CSR 一致），避免 hydration mismatch；
  // 真实额度由下方 useEffect 在挂载后从 localStorage / 后端异步读取并更新。
  const [view, setView] = React.useState<QuotaView>(() => {
    // 客户端首次渲染即读取 localStorage，避免挂载后 effect 里同步 setState 造成的闪烁；
    // SSR 阶段无 window，返回 0 占位，与后端/CSR 水合一致。
    if (typeof window !== "undefined") {
      const local = quotaStatus();
      return { ...local, source: "local" };
    }
    return { used: 0, limit: DAILY_LIMIT, degraded: false, suspended: false, ratio: 0, source: "local" };
  });

  const refresh = React.useCallback(async () => {
    const v = await fetchQuota();
    setView(v);
  }, []);

  const reset = React.useCallback(async () => {
    resetQuota();
    try {
      const res = await fetch("/api/mairui-quota", { method: "POST" });
      if (res.ok) {
        const data = (await res.json()) as QuotaStatus;
        serverQuota = data;
        setView({ ...data, source: "server" });
        return;
      }
    } catch {
      /* 忽略，回退本地清零 */
    }
    const local = quotaStatus();
    setView({ ...local, source: "local" });
  }, []);

  React.useEffect(() => {
    // 初始额度已在 useState 惰性初始化时从 localStorage 读取，这里仅异步拉取后端最新值。
    // refresh 内部 setState，属正常的异步数据刷新，非同步级联渲染。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    const t = window.setInterval(refresh, pollMs);
    return () => window.clearInterval(t);
  }, [refresh, pollMs]);

  return { quota: view, refresh, reset };
}
