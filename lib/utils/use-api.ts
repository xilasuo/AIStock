"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface UseApiOptions<T> {
  /** 初始数据（如服务端预取），提供后首次渲染直接进入已加载态 */
  initialData?: T | null;
  /** 初始错误信息 */
  initialError?: string;
  /** 请求超时（毫秒），默认 15s；传 0 关闭超时 */
  timeoutMs?: number;
  /** 依赖项变化时自动重新拉取（默认挂载即拉取） */
  deps?: ReadonlyArray<unknown>;
  /** 是否自动加载，默认 true */
  autoLoad?: boolean;
}

export interface UseApiResult<T> {
  data: T | null;
  loading: boolean;
  error: string;
  /** 手动重新拉取 */
  reload: () => void;
  /** 本地更新数据（乐观更新 / 外部注入） */
  setData: (next: T | null) => void;
  /** 本地设置错误 */
  setError: (msg: string) => void;
}

/**
 * 统一封装「fetch + loading + error + abort + 超时」样板。
 * fetcher 返回 T；约定业务响应形如 { ok, data?, error? } 或可直接是 T。
 */
export function useApi<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  options: UseApiOptions<T> = {},
): UseApiResult<T> {
  const {
    initialData = null,
    initialError = "",
    timeoutMs = 15_000,
    deps = [],
    autoLoad = true,
  } = options;

  const [data, setData] = useState<T | null>(initialData);
  const [loading, setLoading] = useState<boolean>(autoLoad && initialData == null);
  const [error, setError] = useState<string>(initialError);
  const fetcherRef = useRef(fetcher);
  // 在提交阶段同步最新 fetcher。render 期间直接写 ref.current 会破坏并发渲染语义
  // （React 19 明确禁止，react-hooks/refs）。此 effect 声明在下方「自动加载」effect
  // 之前，而 effect 按声明顺序执行，因此后者调用 run() 时读到的必定是最新 fetcher。
  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  const run = useCallback(() => {
    let alive = true;
    const ctrl = new AbortController();
    const timer =
      timeoutMs > 0 ? window.setTimeout(() => ctrl.abort(), timeoutMs) : 0;
    setLoading(true);
    setError("");
    void (async () => {
      try {
        const result = await fetcherRef.current(ctrl.signal);
        if (alive) setData(result);
      } catch (e: unknown) {
        if (!alive) return;
        const aborted =
          e instanceof DOMException && e.name === "AbortError";
        setError(
          aborted
            ? "请求超时，请检查网络或数据库连接后重试。"
            : e instanceof Error && e.message
              ? e.message
              : "请求失败，请稍后重试",
        );
      } finally {
        if (timer) window.clearTimeout(timer);
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeoutMs]);

  useEffect(() => {
    if (!autoLoad) return;
    // 初始已有数据则不自动拉取，避免重复加载闪烁。
    // 这里无需 setLoading(false)：loading 的初值已由 useState 计算为
    // `autoLoad && initialData == null`，有初始数据时本就是 false。
    // 反之若此刻 loading 为 true，只可能是 reload() 正在飞行中，
    // 强行置 false 会误清进行中的加载态，且在 effect 内同步 setState 会触发级联渲染。
    if (initialData != null) return;
    // 「挂载即拉取」是数据获取的正常形态，非派生 state 反模式：run() 内的
    // setLoading(true)/setError("") 在此刻的取值与初值完全相同（loading 初值即
    // `autoLoad && initialData == null`），React 会直接 bail out，不产生级联渲染。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    const cleanup = run();
    return cleanup;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, loading, error, reload: run, setData, setError };
}
