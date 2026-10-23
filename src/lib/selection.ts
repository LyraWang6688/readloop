/**
 * 每日选题与输入归一化：确定性、纯函数、零网络。
 *
 * 规则来源：docs/REVIEW_RULES.md §六、docs/API_IMPLEMENTATION.md §4.2
 *
 * 这个文件只回答两件事：
 * 1. 宿主从飞书表里读出来的「中文表字段」怎么变成内部 `ReviewPoint`；
 * 2. 今天该练哪 8 个点、按什么顺序练（随机只用于池内打散，不改变选中集合）。
 *
 * 题面构造在 questions.ts，today/submit 编排在 review.ts，
 * 这样选题逻辑可以被 tsx 直接单测，不依赖 Next.js / 数据库 / 模型。
 */

import { daysBetween, isDateString, msToDate } from "./date";
import { EASE_MAX, EASE_MIN, NEED_MAX, type KnowledgeStateName } from "./scheduler";
import type { QuestionType } from "./grading";

// ============================================================
// 类型与常量
// ============================================================

export type PointType = "word" | "phrase" | "pattern" | "comprehension_point";

/** 状态直接复用调度状态机的枚举，避免两套名字 */
export type PointState = KnowledgeStateName;

/** 知识点来源：到期 / 新点 / 补位（对应 REVIEW_RULES §六 的 ①②③） */
export type SelectionBucket = "due" | "new" | "fill";

export interface ReviewPoint {
  /** 归一化内容（去重键） */
  id: string;
  /** 知识点原文 */
  content: string;
  type: PointType;
  meaning: string;
  explanation?: string;
  /** 来源原句（出题语境） */
  example?: string;
  state: PointState;
  intervalDays: number;
  ease: number;
  streak: number;
  lapses: number;
  need: number;
  /** YYYY-MM-DD（上海时区） */
  nextReview?: string;
  /** YYYY-MM-DD（上海时区） */
  lastSeen?: string;
  sourceUrl?: string;
}

/** 每日题量：对应 REVIEW_RULES §六 的 N = 8 */
export const DAILY_SIZE = 8;
/** 到期配额上限：到期积压再多也只取 5 题（§六 ①） */
export const DUE_QUOTA = 5;
/** 新点配额：默认 2（difficulty.ts 的 DEFAULT_QUOTA.newQuota） */
export const NEW_QUOTA = 2;

export const POINT_TYPES: readonly PointType[] = [
  "word",
  "phrase",
  "pattern",
  "comprehension_point",
];

/** 状态机的五种状态（顺序即文档 §二 的顺序） */
export const POINT_STATES: readonly PointState[] = [
  "new",
  "learning",
  "review",
  "relearning",
  "mastered",
];

/** 字段缺省时使用的初始值（REVIEW_RULES §四、§九） */
export const POINT_DEFAULT_NUMBERS = {
  intervalDays: 0,
  ease: 2.5,
  streak: 0,
  lapses: 0,
  need: 3,
} as const;

export function isPointType(value: unknown): value is PointType {
  return typeof value === "string" && (POINT_TYPES as readonly string[]).includes(value);
}

export function isPointState(value: unknown): value is PointState {
  return typeof value === "string" && (POINT_STATES as readonly string[]).includes(value);
}

// ============================================================
// 输入归一化（中文表字段 → ReviewPoint）
// ============================================================

export type PointsParseResult =
  | { ok: true; points: ReviewPoint[] }
  | {
      ok: false;
      code: "POINTS_EMPTY" | "POINTS_INVALID";
      message: string;
      details?: string;
    };

export type PointRowResult =
  | { ok: true; point: ReviewPoint }
  | { ok: false; details: string };

interface NumberFieldOptions {
  fallback: number;
  min?: number;
  max?: number;
  /** 是否取整（间隔/连对/答错/待练都是整数字段） */
  integer?: boolean;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function readNumberField(
  record: Record<string, unknown>,
  key: string,
  position: number,
  options: NumberFieldOptions
): { ok: true; value: number } | { ok: false; details: string } {
  const raw = record[key];
  if (raw === undefined || raw === null) {
    return { ok: true, value: options.fallback };
  }

  let value: number;
  if (typeof raw === "number") {
    value = raw;
  } else if (typeof raw === "string") {
    const trimmed = raw.trim();
    // 飞书空单元格读出来可能是空串，按「缺省」处理
    if (trimmed === "") return { ok: true, value: options.fallback };
    value = Number(trimmed);
  } else {
    return { ok: false, details: `第 ${position} 条：「${key}」不是数字` };
  }

  if (!Number.isFinite(value)) {
    return { ok: false, details: `第 ${position} 条：「${key}」不是数字` };
  }

  if (options.integer) value = Math.round(value);
  if (options.min !== undefined) value = Math.max(options.min, value);
  if (options.max !== undefined) value = Math.min(options.max, value);
  return { ok: true, value };
}

/**
 * 日期字段归一化：接受 `YYYY-MM-DD`、ISO 8601、毫秒时间戳三种写法。
 * 宿主读表格式不一，统一落成上海时区的 `YYYY-MM-DD`；无法识别时返回 undefined
 * （不让一条脏日期把整套题打挂，只是这条点今天按「没有到期时间」处理）。
 */
export function normalizeDateField(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return msToDate(value);
  }
  if (typeof value !== "string") return undefined;

  const raw = value.trim();
  if (raw === "") return undefined;
  if (isDateString(raw)) return raw;

  // 毫秒时间戳字符串（通常 13 位）；秒级时间戳不在契约内，不猜
  if (/^\d{12,}$/.test(raw)) {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? msToDate(parsed) : undefined;
  }

  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) return undefined;
  return msToDate(parsed);
}

/**
 * 单条记录归一化。`index` 是 0 基下标，报错时换算成「第 N 条」方便宿主定位。
 *
 * 严格校验（§4.1）：`归一化内容` 非空、`状态` 必须在枚举里；
 * 数字字段缺省用初始值，非数字 → 422；
 * `类型` 不在枚举内时按 `word` 处理（不阻塞当天出题，记在实现差异里）。
 */
export function normalizePointRow(row: unknown, index: number): PointRowResult {
  const position = index + 1;
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return { ok: false, details: `第 ${position} 条：不是对象` };
  }
  const record = row as Record<string, unknown>;

  const id = readString(record, "归一化内容");
  if (!id) {
    return { ok: false, details: `第 ${position} 条：缺「归一化内容」` };
  }

  const stateRaw = readString(record, "状态")?.toLowerCase();
  if (!isPointState(stateRaw)) {
    return {
      ok: false,
      details: `第 ${position} 条：「状态」必须是 ${POINT_STATES.join(" / ")}`,
    };
  }

  const intervalDays = readNumberField(record, "间隔天数", position, {
    fallback: POINT_DEFAULT_NUMBERS.intervalDays,
    min: 0,
    integer: true,
  });
  if (!intervalDays.ok) return { ok: false, details: intervalDays.details };

  const ease = readNumberField(record, "难度因子", position, {
    fallback: POINT_DEFAULT_NUMBERS.ease,
    min: EASE_MIN,
    max: EASE_MAX,
  });
  if (!ease.ok) return { ok: false, details: ease.details };

  const streak = readNumberField(record, "连对次数", position, {
    fallback: POINT_DEFAULT_NUMBERS.streak,
    min: 0,
    integer: true,
  });
  if (!streak.ok) return { ok: false, details: streak.details };

  const lapses = readNumberField(record, "答错次数", position, {
    fallback: POINT_DEFAULT_NUMBERS.lapses,
    min: 0,
    integer: true,
  });
  if (!lapses.ok) return { ok: false, details: lapses.details };

  const need = readNumberField(record, "待练次数", position, {
    fallback: POINT_DEFAULT_NUMBERS.need,
    min: 0,
    max: NEED_MAX,
    integer: true,
  });
  if (!need.ok) return { ok: false, details: need.details };

  const rawType = readString(record, "类型")?.toLowerCase();
  const type: PointType = isPointType(rawType) ? rawType : "word";

  return {
    ok: true,
    point: {
      id,
      // 主字段缺失时退回归一化内容，保证题面总有东西可出
      content: readString(record, "知识点") ?? id,
      type,
      meaning: readString(record, "释义") ?? "",
      explanation: readString(record, "解释"),
      // 表里同时有「来源原句」与「例句」：出题优先用来源原句，没有就退到例句
      example: readString(record, "来源原句") ?? readString(record, "例句"),
      state: stateRaw,
      intervalDays: intervalDays.value,
      ease: ease.value,
      streak: streak.value,
      lapses: lapses.value,
      need: need.value,
      nextReview: normalizeDateField(record["下次复习"]),
      lastSeen: normalizeDateField(record["最近暴露"]),
      sourceUrl: readString(record, "来源链接"),
    },
  };
}

/**
 * 批量归一化 + 去重（按归一化内容，保留第一条）。
 * 空数组 → POINTS_EMPTY；任一条字段不合法 → POINTS_INVALID 并指出第几条。
 */
export function parsePoints(input: unknown): PointsParseResult {
  if (!Array.isArray(input) || input.length === 0) {
    return {
      ok: false,
      code: "POINTS_EMPTY",
      message: "points 必须是非空数组",
      details: "宿主需要先把 knowledge_points 表里的知识点读出来",
    };
  }

  const points: ReviewPoint[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < input.length; index += 1) {
    const result = normalizePointRow(input[index], index);
    if (!result.ok) {
      return {
        ok: false,
        code: "POINTS_INVALID",
        message: "points 里有字段不合法",
        details: result.details,
      };
    }
    // 同一知识点只保留第一条：多维表格里重复写入不该变成两道题
    if (seen.has(result.point.id)) continue;
    seen.add(result.point.id);
    points.push(result.point);
  }

  return { ok: true, points };
}

// ============================================================
// 确定性随机：FNV-1a + mulberry32
// ============================================================

/** FNV-1a 32 位哈希：同样的输入永远得到同一个种子 */
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32：小而稳定的伪随机数发生器，返回 [0, 1) */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 选题种子：`FNV1a(date + "|" + active.map(id).sort().join(","))`。
 * 只用「日期 + 活跃点集合」⇒ 同样的库状态、同一天，必得同一套题。
 */
export function selectionSeed(date: string, activeIds: readonly string[]): number {
  return fnv1a(`${date}|${[...activeIds].sort().join(",")}`);
}

/** Fisher-Yates 洗牌（不修改入参），随机源由调用方传入 */
export function shuffleWithRng<T>(items: readonly T[], rng: () => number): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(rng() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

/**
 * 题型分配：choice / cloze 严格交替，起点由 rng 决定；
 * 没有足够干扰项的点强制 cloze（§4.3）。
 */
export function assignQuestionTypes(
  canChoice: readonly boolean[],
  rng: () => number
): QuestionType[] {
  const startWithChoice = rng() < 0.5;
  return canChoice.map((capable, index) => {
    const even = index % 2 === 0;
    const planned: QuestionType =
      even === startWithChoice ? "choice" : "cloze";
    return capable ? planned : "cloze";
  });
}

// ============================================================
// 每日选题
// ============================================================

export interface SelectionOptions {
  /** 今日题量，默认 8 */
  size?: number;
  /** 到期题上限，默认 5 */
  dueQuota?: number;
  /** 新点上限，默认 2 */
  newQuota?: number;
}

export interface SelectedPoint {
  point: ReviewPoint;
  bucket: SelectionBucket;
}

export interface DailySelection {
  date: string;
  /** 选题种子（variant 与题型起点都由它派生） */
  seed: number;
  /** 界面变体：seed % 5，0–4 */
  variant: number;
  /** 选中的知识点，按「到期 → 新点 → 补位」的规范顺序保存 */
  selected: SelectedPoint[];
  /** 打散后的出题顺序：索引指向 selected */
  order: number[];
  /** 本套题里来自新点的题数 */
  newCount: number;
  /** 本套题里来自到期点的题数 */
  dueCount: number;
  /** 本套题里最该盯的 2 个知识点原文（lapses desc, need desc） */
  weakPoints: string[];
}

function compareById(a: ReviewPoint, b: ReviewPoint): number {
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/** 到期天数；不是到期点（状态不对/没有下次复习/还没到）返回 null */
function dueOverdueDays(point: ReviewPoint, date: string): number | null {
  if (point.state !== "review" && point.state !== "relearning") return null;
  if (!point.nextReview || !isDateString(point.nextReview)) return null;
  const overdue = daysBetween(point.nextReview, date);
  return overdue >= 0 ? overdue : null;
}

function compareDue(a: ReviewPoint, b: ReviewPoint, date: string): number {
  const overdueA = dueOverdueDays(a, date);
  const overdueB = dueOverdueDays(b, date);
  if (overdueA === null || overdueB === null) return 0;
  if (overdueA !== overdueB) return overdueB - overdueA;
  if (a.need !== b.need) return b.need - a.need;
  return compareById(a, b);
}

/** 新点排序：最近暴露越新越靠前；没有暴露记录的排最后 */
function compareNew(a: ReviewPoint, b: ReviewPoint): number {
  const seenA = a.lastSeen ?? "";
  const seenB = b.lastSeen ?? "";
  if (seenA !== seenB) return seenA < seenB ? 1 : -1;
  return compareById(a, b);
}

/** 补位排序：待练次数 desc → 答错次数 desc → id asc */
function compareFill(a: ReviewPoint, b: ReviewPoint): number {
  if (a.need !== b.need) return b.need - a.need;
  if (a.lapses !== b.lapses) return b.lapses - a.lapses;
  return compareById(a, b);
}

/**
 * 选出今天要练的知识点（REVIEW_RULES §六 的前三步）。
 *
 * ```
 * ① 到期：state ∈ {review, relearning} 且 nextReview ≤ date
 *        排序 (逾期天数 desc, need desc, id asc)，最多 dueQuota 题
 * ② 新点：state == "new"，排序 (lastSeen desc, id asc)，最多 newQuota 题
 * ③ 补位：活跃点里还没选中的，排序 (need desc, lapses desc, id asc)，补到 size 题
 * ```
 *
 * `mastered` 不在活跃集合里，不参与选题。
 * 随机只打散出题顺序（`order`），不改变选中集合。
 */
export function selectDailyPoints(
  points: readonly ReviewPoint[],
  date: string,
  options: SelectionOptions = {}
): DailySelection {
  if (!isDateString(date)) throw new Error(`非法日期：${date}`);

  const size = Math.max(0, Math.trunc(options.size ?? DAILY_SIZE));
  const dueQuota = Math.max(0, Math.trunc(options.dueQuota ?? DUE_QUOTA));
  const newQuota = Math.max(0, Math.trunc(options.newQuota ?? NEW_QUOTA));

  const active = points.filter((point) => point.state !== "mastered");
  const seed = selectionSeed(
    date,
    active.map((point) => point.id)
  );
  const rng = mulberry32(seed);

  const selected: SelectedPoint[] = [];
  const selectedIds = new Set<string>();
  const take = (point: ReviewPoint, bucket: SelectionBucket) => {
    if (selected.length >= size || selectedIds.has(point.id)) return;
    selected.push({ point, bucket });
    selectedIds.add(point.id);
  };

  // ① 到期：先把逾期最久、待练最多的捞出来，最多 5 题
  const dueLimit = Math.min(dueQuota, size);
  const dueCandidates = active
    .filter((point) => dueOverdueDays(point, date) !== null)
    .sort((a, b) => compareDue(a, b, date));
  for (const point of dueCandidates) {
    if (selected.length >= dueLimit) break;
    take(point, "due");
  }

  // ② 新点：按最近暴露倒序，最多 2 题
  const newLimit = Math.min(newQuota, size - selected.length);
  const newStart = selected.length;
  const newCandidates = active
    .filter((point) => point.state === "new" && !selectedIds.has(point.id))
    .sort(compareNew);
  for (const point of newCandidates) {
    if (selected.length >= newStart + newLimit) break;
    take(point, "new");
  }

  // ③ 补位：还差几题就从剩余活跃点里按债务补齐
  const fillCandidates = active
    .filter((point) => !selectedIds.has(point.id))
    .sort(compareFill);
  for (const point of fillCandidates) {
    if (selected.length >= size) break;
    take(point, "fill");
  }

  const order = shuffleWithRng(
    selected.map((_, index) => index),
    rng
  );

  const weakPoints = [...selected]
    .sort(
      (a, b) =>
        b.point.lapses - a.point.lapses ||
        b.point.need - a.point.need ||
        compareById(a.point, b.point)
    )
    .slice(0, 2)
    .map((item) => item.point.content || item.point.id);

  return {
    date,
    seed,
    variant: seed % 5,
    selected,
    order,
    newCount: selected.filter((item) => item.bucket === "new").length,
    dueCount: selected.filter((item) => item.bucket === "due").length,
    weakPoints,
  };
}
