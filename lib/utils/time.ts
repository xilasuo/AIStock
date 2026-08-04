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
