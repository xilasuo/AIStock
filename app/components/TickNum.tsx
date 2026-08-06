"use client";

import { useEffect, useRef, useState } from "react";

type TickNumProps = {
  value: number;
  /** 数值格式化函数（如 money / pct / toFixed） */
  format?: (v: number) => string;
  className?: string;
  /**
   * 方向语义：默认 true，即「数值变大 = up = 红（A股涨色）」。
   * 个别场景（如回撤、跌幅）可传 false 让「变小 = up」。
   */
  positiveIsUp?: boolean;
};

/**
 * TickNum —— 实时数值跳动闪烁。
 * 值变化时按方向闪一下（红涨绿跌，沿用项目 token 语义色），600ms 后渐隐。
 * 首帧 / 值未变化时不闪；与 BigScreenView 的实时窗口门控配合：窗口外不刷新即不会误闪。
 */
export function TickNum({ value, format, className = "", positiveIsUp = true }: TickNumProps) {
  const prev = useRef<number | null>(null);
  const [flash, setFlash] = useState<"" | "up" | "down">("");

  useEffect(() => {
    if (prev.current !== null && value !== prev.current) {
      const rose = positiveIsUp ? value > prev.current : value < prev.current;
      setFlash(rose ? "up" : "down");
      const id = window.setTimeout(() => setFlash(""), 600);
      prev.current = value;
      return () => window.clearTimeout(id);
    }
    prev.current = value;
  }, [value, positiveIsUp]);

  const text = format ? format(value) : String(value);
  return <span className={`tick-num ${flash} ${className}`.trim()}>{text}</span>;
}
