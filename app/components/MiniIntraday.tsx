"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { InteractiveKline } from "./InteractiveKline";

/**
 * MiniIntraday：在列表中内联展示「当日分时」迷你走势图（麦蕊分时优先，东财兜底）。
 * 设计目标：
 *  - 轻量：只取闭盘价连成曲线，不绘制均线 / 坐标轴；
 *  - 不阻塞首屏：进场后在微任务中 lazy 拉取 /api/kline/{code}.json?period=dn；
 *  - 缓存：进程内 Map + localStorage（TTL 10 分钟），同一股票多次出现只拉一次；
 *  - 可点击放大：点击弹窗用 InteractiveKline 展示大图，并可在 5分/15分/30分/60分/当日分时切换。
 */

type IntradayPoint = { date: string; close: number };

const MEM_CACHE = new Map<string, IntradayPoint[]>();
const CACHE_KEY = "mini-intraday";
const TTL_MS = 10 * 60 * 1000;
/** 迷你图固定取当日分时；缓存键会带上它，避免以后加周期切换时串数据 */
const MINI_PERIOD = "dn";

/** key 形如 `${code}:${period}` */
function loadFromStore(key: string): IntradayPoint[] | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(`aistock:${CACHE_KEY}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { ts: number; data: Record<string, IntradayPoint[]> };
    if (Date.now() - parsed.ts > TTL_MS) return null;
    const hit = parsed.data?.[key];
    return hit && hit.length ? hit : null;
  } catch {
    return null;
  }
}

/** key 形如 `${code}:${period}` */
function saveToStore(key: string, bars: IntradayPoint[]) {
  if (typeof window === "undefined") return;
  try {
    let merged: Record<string, IntradayPoint[]> = {};
    const raw = window.localStorage.getItem(`aistock:${CACHE_KEY}`);
    if (raw) {
      try {
        merged = (JSON.parse(raw) as { data: Record<string, IntradayPoint[]> }).data ?? {};
      } catch {
        merged = {};
      }
    }
    merged[key] = bars;
    const next = JSON.stringify({ ts: Date.now(), data: merged });
    if (next.length <= 2 * 1024 * 1024) {
      window.localStorage.setItem(`aistock:${CACHE_KEY}`, next);
    }
  } catch {
    /* 忽略配额异常 */
  }
}

export function MiniIntraday({
  code,
  name,
  width = 120,
  height = 32,
  expandable = true,
  onAnalyze,
  onBuy,
}: {
  code: string;
  name?: string;
  width?: number;
  height?: number;
  /** 是否允许点击放大（弹窗大图 + 周期切换）。默认 true。 */
  expandable?: boolean;
  /** 点击「查看分析」时触发，传入股票代码。由父级负责跳转 + 拉取分析。 */
  onAnalyze?: (code: string) => void;
  /** 点击「记录买入」时触发，传入股票代码。由父级负责拉分析 + 打开买入弹窗。 */
  onBuy?: (code: string, name?: string) => void;
}) {
  const [points, setPoints] = useState<IntradayPoint[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [watchState, setWatchState] = useState<"idle" | "adding" | "done" | "existed" | "error">("idle");
  const [flash, setFlash] = useState<string | null>(null);
  const reqId = useRef(0);

  async function handleAddWatch() {
    if (watchState === "adding" || watchState === "done") return;
    setWatchState("adding");
    setFlash(null);
    try {
      const res = await fetch("/api/watchlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ symbol: code, name: name ?? code }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { existed?: boolean };
      if (data.existed) {
        setWatchState("existed");
        setFlash("已在关注列表中");
      } else {
        setWatchState("done");
        setFlash("已加入关注");
      }
    } catch (e) {
      setWatchState("error");
      setFlash(`加入关注失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  useEffect(() => {
    const id = ++reqId.current;

    // 缓存键必须带上 period，否则将来给迷你图加周期切换时会串数据
    // （API 侧 memCache 已用 `${code}:${period}`，这里保持一致）。
    const cacheKey = `${code}:${MINI_PERIOD}`;
    const cached = MEM_CACHE.get(cacheKey) ?? loadFromStore(cacheKey);
    if (cached) {
      // 命中本地缓存：在 effect 内同步设置状态是必要的（依赖 code/period 重新拉取）。
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPoints(cached);
      return;
    }

    let cancelled = false;
    // 延迟到下一帧执行，避免表格批量渲染时阻塞首屏绘制
    const timer = window.setTimeout(() => {
      fetch(`/api/kline/${code}.json?period=${MINI_PERIOD}`)
        .then((res) => res.json() as Promise<{ ok?: boolean; bars?: { date: string; close: number }[] }>)
        .then((data) => {
          if (cancelled || id !== reqId.current) return;
          const bars = data.ok && data.bars ? data.bars.map((b) => ({ date: b.date, close: b.close })) : [];
          if (bars.length >= 2) {
            MEM_CACHE.set(cacheKey, bars);
            saveToStore(cacheKey, bars);
            setPoints(bars);
          } else {
            setFailed(true);
          }
        })
        .catch(() => {
          if (!cancelled && id === reqId.current) setFailed(true);
        });
    }, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [code]);

  // 弹窗打开时支持 ESC 关闭
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  if (failed) return <span className="mini-intraday mini-intraday--empty" aria-hidden="true" />;
  if (!points || points.length < 2) {
    return <span className="mini-intraday mini-intraday--loading" aria-hidden="true" />;
  }

  const closes = points.map((p) => p.close);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const range = Math.max(max - min, 1e-6);
  const stepX = width / (points.length - 1);
  const y = (v: number) => height - ((v - min) / range) * (height - 4) - 2;
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${(i * stepX).toFixed(1)},${y(p.close).toFixed(1)}`).join(" ");
  const first = points[0].close;
  const last = points[points.length - 1].close;
  const up = last >= first;
  const cls = up ? "up" : "down";

  const Wrapped = (
    <span
      className={`mini-intraday mini-intraday--${cls}${expandable ? " mini-intraday--clickable" : ""}`}
      title={`${name ?? code} 当日分时${up ? "上涨" : "下跌"}${expandable ? "（点击放大）" : ""}`}
      onClick={expandable ? () => setExpanded(true) : undefined}
      role={expandable ? "button" : undefined}
      tabIndex={expandable ? 0 : undefined}
      onKeyDown={
        expandable
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setExpanded(true);
              }
            }
          : undefined
      }
    >
      <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-label="当日分时走势">
        <path d={path} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      </svg>
    </span>
  );

  if (!expandable || typeof document === "undefined") return Wrapped;

  return (
    <>
      {Wrapped}
      {expanded &&
        createPortal(
          <div className="mini-intraday-modal" onClick={() => setExpanded(false)}>
            <div className="mini-intraday-modal__panel" onClick={(e) => e.stopPropagation()}>
              <div className="mini-intraday-modal__head">
                <span className="mini-intraday-modal__title">
                  {name ?? code} <small>{code}</small> · 分时走势
                </span>
                <button type="button" className="mini-intraday-modal__close" onClick={() => setExpanded(false)}>
                  ✕
                </button>
              </div>
              <div className="mini-intraday-modal__chart">
                <InteractiveKline code={code} name={name ?? code} fillParent />
              </div>
              <div className="mini-intraday-modal__actions">
                <button
                  type="button"
                  className="mini-intraday-modal__btn"
                  onClick={handleAddWatch}
                  disabled={watchState === "adding" || watchState === "done"}
                >
                  {watchState === "done"
                    ? "✓ 已加入关注"
                    : watchState === "existed"
                      ? "已在关注列表"
                      : watchState === "adding"
                        ? "加入中…"
                        : "加入关注"}
                </button>
                {onAnalyze && (
                  <button
                    type="button"
                    className="mini-intraday-modal__btn"
                    onClick={() => {
                      setExpanded(false);
                      onAnalyze(code);
                    }}
                  >
                    查看分析
                  </button>
                )}
                {onBuy && (
                  <button
                    type="button"
                    className="mini-intraday-modal__btn mini-intraday-modal__btn--primary"
                    onClick={() => {
                      setExpanded(false);
                      onBuy(code, name);
                    }}
                  >
                    记录买入
                  </button>
                )}
                {flash && <span className="mini-intraday-modal__flash">{flash}</span>}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
