/** 统一时间处理：所有面向中国用户的「业务日期 / 显示 / 存储时间戳」都以 Asia/Shanghai 为准，
 * 不再依赖运行环境时区（Cloudflare Workers 默认 UTC）。
 *
 * 约定：
 * - shanghaiDate(): 返回 "YYYY-MM-DD"（交易日 / 今日判断 / 导出文件名）
 * - shanghaiIso(): 返回 "YYYY-MM-DDTHH:mm:ss"（无 Z，按上海墙钟存储，避免被二次按浏览器时区偏移）
 * - formatDateTimeShanghai(): 把任意时间输入格式化为"上海本地可读时间"，用于前端展示
 */

const SH = "Asia/Shanghai";

export function shanghaiDate(date: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: SH, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

export function shanghaiIso(date: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: SH,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;
}

/** 把 Date / 时间戳字符串 / 数字 格式化为上海可读时间，如 "2026-08-01 23:45:30"。 */
export function formatDateTimeShanghai(input: string | number | Date): string {
  const date = typeof input === "string" ? new Date(input) : input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return String(input);
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: SH,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

/** 仅日期部分（上海），如 "2026/08/01"。 */
export function formatDateShanghai(input: string | number | Date): string {
  const date = typeof input === "string" ? new Date(input) : input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return String(input);
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: SH,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).format(date);
}

/**
 * 引擎时间戳展示（trading_agent 生成的「生成于 / generatedAt / selectedAt」等）。
 * 约定（与 trading_agent/timeutil.py 配套）：
 * - naive 无时区字符串（如 "2026-08-04T22:41:13"）→ 引擎已按上海墙钟输出，直接展示，
 *   不再交给 new Date() 按浏览器本地时区二次解析（避免跨时区浏览器显示偏移）；
 * - 带时区后缀（"Z" / "+08:00" 等）→ 视为瞬时，换算成上海可读时间。
 */
export function formatEngineTime(ts: string | undefined | null): string {
  if (!ts) return "—";
  const s = ts.trim();
  if (!s) return "—";
  if (/Z$|[+-]\d{2}:?\d{2}$/.test(s)) {
    return formatDateTimeShanghai(s);
  }
  const cleaned = s.replace("T", " ");
  return cleaned.length >= 19 ? cleaned.slice(0, 19) : cleaned;
}
