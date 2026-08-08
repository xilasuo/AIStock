/**
 * 安全数字转换：将 unknown 值转为有限 number，不可转换时返回 null。
 * 统一替代 market-data.ts / mairui.ts 中各自的 num 函数。
 */
export function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}
