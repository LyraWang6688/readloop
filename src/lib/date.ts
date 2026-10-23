/**
 * 日期工具：纯函数、零依赖、可单测。
 *
 * 约定（见 docs/API_IMPLEMENTATION.md）：
 * - 外部接口里的日期一律是「上海时区的日历日期」字符串 `YYYY-MM-DD`
 * - 服务端不做时区猜测，也不依赖运行环境的 TZ
 */

/** 上海时区相对 UTC 的固定偏移（中国不实行夏令时） */
export const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

export const DAY_MS = 24 * 60 * 60 * 1000;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** 是否是合法的 `YYYY-MM-DD`（含日历合法性校验，拒绝 2026-02-30） */
export function isDateString(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  if (y < 1970 || y > 9999 || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const probe = new Date(Date.UTC(y, m - 1, d));
  return (
    probe.getUTCFullYear() === y &&
    probe.getUTCMonth() === m - 1 &&
    probe.getUTCDate() === d
  );
}

/**
 * 把 `YYYY-MM-DD` 解析成「该日期上海时间 00:00」对应的 UTC 毫秒。
 * 这样两点相减得到的天数就是自然日差，不受运行环境时区影响。
 */
export function dateToMs(date: string): number {
  if (!isDateString(date)) throw new Error(`非法日期：${date}`);
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d) - SHANGHAI_OFFSET_MS;
}

/** UTC 毫秒 → 上海时区的日历日期 */
export function msToDate(ms: number): string {
  const shifted = new Date(ms + SHANGHAI_OFFSET_MS);
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;
}

/** 今天的日期（按上海时区） */
export function todayInShanghai(nowMs: number = Date.now()): string {
  return msToDate(nowMs);
}

/** `b - a` 的整数天数 */
export function daysBetween(a: string, b: string): number {
  return Math.round((dateToMs(b) - dateToMs(a)) / DAY_MS);
}

/** 日期加减天数 */
export function addDays(date: string, days: number): string {
  return msToDate(dateToMs(date) + days * DAY_MS);
}

/** 该日期上海时间 23:59:59.999 的 UTC 毫秒 */
export function endOfDayMs(date: string): number {
  return dateToMs(date) + DAY_MS - 1;
}
