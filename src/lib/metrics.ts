/**
 * 学习效果指标：从宿主上报的「答题记录 + 当前知识点」算出一组可复核的指标。
 *
 * 为什么在服务端算（而不用模型/宿主自己算）：
 * - 指标定义必须唯一，换宿主不能换口径；
 * - 宿主只有原始表格，没有统一的算法；服务算完返回结构化结果，宿主只负责展示。
 *
 * 隐私：只接收宿主传上来的本机数据，算完即忘——服务端不落库、不写日志里的内容。
 *
 * 指标设计（2026-10-23 与产品确认）：
 * - 主要：**间隔后保持率**（当天 / 1–2 / 3–6 / 7–13 / 14+ 天分档）、整体正确率是否落在 70–85%
 * - 次要：答错率、leech 占比、每日完成率、每题用时
 * - 小样本保护：整体 < 20 题只给「样本不足」，不下结论
 * - 平滑：正确率用 difficulty.ts 的贝叶斯平滑，避免几道题就下判断
 *
 * 纯函数、零依赖（只依赖本仓库的日期/难度纯函数）。
 */

import { addDays, daysBetween, todayInShanghai } from "./date";
import {
  MIN_SAMPLE,
  PRIOR_SUCCESS_RATE,
  PRIOR_WEIGHT,
  TARGET_MAX,
  TARGET_MIN,
  rawSuccessRate,
  smoothSuccessRate,
} from "./difficulty";
import { normalizeDateField } from "./selection";

// ============================================================
// 输入 / 输出类型
// ============================================================

export interface MetricsInput {
  /** 窗口结束日（含），默认上海时区的今天 */
  date?: string;
  /** 回看天数，默认 28，范围 1–90 */
  windowDays?: number;
  /** 答题记录（practice_events 行，字段名用中文） */
  practice: unknown[];
  /** 当前知识点（knowledge_points 行），用于算 leech 占比；可选 */
  points?: unknown[];
}

export interface IntervalBucket {
  key: string;
  label: string;
  minDays: number;
  maxDays: number | null;
  attempts: number;
  correct: number;
  successRate: number | null;
  smoothedSuccessRate: number | null;
}

export interface GroupStats {
  attempts: number;
  correct: number;
  successRate: number | null;
  smoothedSuccessRate: number | null;
}

export interface TypeStats extends GroupStats {
  type: string;
}

export interface SourceStats extends GroupStats {
  source: string;
}

export interface MetricsRecommendation {
  code:
    | "SAMPLE_TOO_SMALL"
    | "TOO_EASY"
    | "TOO_HARD"
    | "LONG_INTERVAL_WEAK"
    | "LEECH_HEAVY"
    | "LOW_ADHERENCE"
    | "SLOW_ANSWERING"
    | "MISSING_INTERVAL";
  level: "info" | "warn";
  message: string;
}

export interface MetricsResult {
  window: { start: string; end: string; days: number; practiceRows: number; skippedRows: number };
  overall: GroupStats & {
    avgElapsedMs: number | null;
    hintUsedRate: number | null;
    hintSample: number;
  };
  /** 没有「复习间隔」字段时为 null（见 missing） */
  byInterval: IntervalBucket[] | null;
  byType: TypeStats[];
  bySource: SourceStats[];
  leech: { activePoints: number; leechPoints: number; leechRatio: number | null };
  adherence: { activeDays: number; windowDays: number; rate: number };
  target: { min: number; max: number; inBand: boolean | null; decisionRate: number | null };
  sample: { attempts: number; minSample: number; enough: boolean };
  prior: { rate: number; weight: number };
  missing: string[];
  recommendations: MetricsRecommendation[];
}

export class MetricsInputError extends Error {}

// ============================================================
// 解析
// ============================================================

interface PracticeRecord {
  date: string;
  point: string;
  type: string | null;
  correct: boolean;
  signal: string | null;
  elapsedMs: number | null;
  source: string | null;
  intervalDays: number | null;
}

function asRow(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readText(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function readNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

/** 是否正确：兼容「correct/wrong」「对/错」「true/false」 */
export function parseCorrectFlag(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return null;
  const flag = value.trim().toLowerCase();
  if (["correct", "true", "1", "对", "正确"].includes(flag)) return true;
  if (["wrong", "false", "0", "错", "错误"].includes(flag)) return false;
  return null;
}

/** 题型：choice / cloze（大小写不敏感）；其它返回 null（仍计入整体） */
export function parseQuestionType(value: unknown): "choice" | "cloze" | null {
  if (typeof value !== "string") return null;
  const type = value.trim().toLowerCase();
  return type === "choice" || type === "cloze" ? type : null;
}

function parsePracticeRow(value: unknown): PracticeRecord | null {
  const record = asRow(value);
  if (!record) return null;
  const date = normalizeDateField(record["答题时间"]);
  const correct = parseCorrectFlag(record["是否正确"]);
  if (!date || correct === null) return null;

  const elapsed = readNumber(record, "用时毫秒");
  const interval = readNumber(record, "复习间隔");

  return {
    date,
    point: readText(record, "知识点") ?? "",
    type: parseQuestionType(record["题型"]),
    correct,
    signal: readText(record, "信号强度"),
    elapsedMs: elapsed !== null && elapsed >= 0 ? elapsed : null,
    source: readText(record, "题源"),
    intervalDays: interval !== null && interval >= 0 ? Math.trunc(interval) : null,
  };
}

function parsePointRow(value: unknown): { lapses: number; active: boolean } | null {
  const record = asRow(value);
  if (!record) return null;
  const lapses = readNumber(record, "答错次数");
  const state = readText(record, "状态")?.toLowerCase() ?? "";
  return {
    lapses: lapses !== null && lapses >= 0 ? Math.trunc(lapses) : 0,
    active: state !== "mastered",
  };
}

// ============================================================
// 分档
// ============================================================

/** 间隔档位：对应「当天 / 约 1 天 / 约 3 天 / 约 7 天 / 14 天以上」 */
export const INTERVAL_BUCKETS: ReadonlyArray<{
  key: string;
  label: string;
  minDays: number;
  maxDays: number | null;
}> = [
  { key: "same_day", label: "当天（0 天）", minDays: 0, maxDays: 0 },
  { key: "1_2", label: "1–2 天", minDays: 1, maxDays: 2 },
  { key: "3_6", label: "3–6 天", minDays: 3, maxDays: 6 },
  { key: "7_13", label: "7–13 天", minDays: 7, maxDays: 13 },
  { key: "14_plus", label: "14 天以上", minDays: 14, maxDays: null },
];

export function intervalBucketKey(days: number): string {
  const bucket = INTERVAL_BUCKETS.find(
    (item) => days >= item.minDays && (item.maxDays === null || days <= item.maxDays)
  );
  return bucket?.key ?? "14_plus";
}

// ============================================================
// 计算
// ============================================================

const MAX_ROWS = 5000;
const MAX_WINDOW_DAYS = 90;
const DEFAULT_WINDOW_DAYS = 28;

function stats(correct: number, attempts: number): GroupStats {
  return {
    attempts,
    correct,
    successRate: rawSuccessRate(correct, attempts),
    smoothedSuccessRate: smoothSuccessRate(correct, attempts),
  };
}

function validateInput(input: unknown): MetricsInput & { practice: unknown[]; points: unknown[] } {
  const record = asRow(input);
  if (!record) throw new MetricsInputError("请求体必须是 JSON 对象");
  if (!Array.isArray(record.practice)) {
    throw new MetricsInputError("practice 必须是数组（practice_events 的行）");
  }
  if (record.practice.length > MAX_ROWS) {
    throw new MetricsInputError(`practice 一次最多 ${MAX_ROWS} 条`);
  }
  const pointsRaw = record.points;
  if (pointsRaw !== undefined && pointsRaw !== null && !Array.isArray(pointsRaw)) {
    throw new MetricsInputError("points 必须是数组（knowledge_points 的行）");
  }
  if (Array.isArray(pointsRaw) && pointsRaw.length > MAX_ROWS) {
    throw new MetricsInputError(`points 一次最多 ${MAX_ROWS} 条`);
  }
  return {
    date: typeof record.date === "string" ? record.date : undefined,
    windowDays: typeof record.windowDays === "number" ? record.windowDays : undefined,
    practice: record.practice,
    points: Array.isArray(pointsRaw) ? pointsRaw : [],
  };
}

/**
 * 计算指标。入参不合法时抛 MetricsInputError（路由层转 400），
 * 单条记录脏数据不抛错——跳过并计入 skippedRows。
 */
export function computeMetrics(rawInput: unknown): MetricsResult {
  const input = validateInput(rawInput);

  const end = input.date && normalizeDateField(input.date) ? normalizeDateField(input.date)! : todayInShanghai();
  const requestedDays = input.windowDays ?? DEFAULT_WINDOW_DAYS;
  if (!Number.isFinite(requestedDays) || requestedDays < 1 || requestedDays > MAX_WINDOW_DAYS) {
    throw new MetricsInputError(`windowDays 必须是 1–${MAX_WINDOW_DAYS} 的整数`);
  }
  const windowDays = Math.trunc(requestedDays);
  const start = addDays(end, -(windowDays - 1));

  // ---------- 逐条解析 ----------
  const parsed: PracticeRecord[] = [];
  let skippedRows = 0;
  for (const row of input.practice) {
    const record = parsePracticeRow(row);
    if (!record) {
      skippedRows += 1;
      continue;
    }
    // 只统计窗口内；窗口外的记录不算本窗口，但不算「脏数据」
    if (record.date < start || record.date > end) continue;
    parsed.push(record);
  }

  // ---------- 整体 ----------
  const attempts = parsed.length;
  const correct = parsed.filter((item) => item.correct).length;
  const overallStats = stats(correct, attempts);

  const elapsedSamples = parsed
    .map((item) => item.elapsedMs)
    .filter((value): value is number => value !== null);
  const avgElapsedMs =
    elapsedSamples.length > 0
      ? Math.round(elapsedSamples.reduce((sum, value) => sum + value, 0) / elapsedSamples.length)
      : null;

  const signalSamples = parsed.filter((item) => item.signal !== null);
  const hintUsed = signalSamples.filter((item) => item.signal!.includes("提示")).length;
  const hintSample = signalSamples.length;
  const hintUsedRate = hintSample > 0 ? hintUsed / hintSample : null;

  // ---------- 间隔分档 ----------
  const intervalRows = parsed.filter((item) => item.intervalDays !== null);
  let byInterval: IntervalBucket[] | null = null;
  const missing: string[] = [];
  if (intervalRows.length > 0) {
    byInterval = INTERVAL_BUCKETS.map((bucket) => {
      const rows = intervalRows.filter((item) => intervalBucketKey(item.intervalDays!) === bucket.key);
      const bucketCorrect = rows.filter((item) => item.correct).length;
      return {
        key: bucket.key,
        label: bucket.label,
        minDays: bucket.minDays,
        maxDays: bucket.maxDays,
        ...stats(bucketCorrect, rows.length),
      };
    });
  } else {
    missing.push("复习间隔");
  }

  // ---------- 题型 / 题源 ----------
  const byType: TypeStats[] = (["choice", "cloze"] as const)
    .map((type) => {
      const rows = parsed.filter((item) => item.type === type);
      return {
        type,
        ...stats(rows.filter((item) => item.correct).length, rows.length),
      };
    })
    .filter((item) => item.attempts > 0);

  const sourceMap = new Map<string, { attempts: number; correct: number }>();
  for (const item of parsed) {
    if (!item.source) continue;
    const entry = sourceMap.get(item.source) ?? { attempts: 0, correct: 0 };
    entry.attempts += 1;
    if (item.correct) entry.correct += 1;
    sourceMap.set(item.source, entry);
  }
  const bySource: SourceStats[] = [...sourceMap.entries()]
    .map(([source, value]) => ({ source, ...stats(value.correct, value.attempts) }))
    .sort((a, b) => b.attempts - a.attempts);

  // ---------- leech ----------
  let activePoints = 0;
  let leechPoints = 0;
  for (const row of input.points) {
    const point = parsePointRow(row);
    if (!point || !point.active) continue;
    activePoints += 1;
    if (point.lapses >= 4) leechPoints += 1;
  }
  const leechRatio = activePoints > 0 ? leechPoints / activePoints : null;

  // ---------- 完成率 ----------
  const activeDays = new Set(parsed.map((item) => item.date)).size;
  const adherence = {
    activeDays,
    windowDays,
    rate: windowDays > 0 ? activeDays / windowDays : 0,
  };

  // ---------- 结论 ----------
  const decisionRate = overallStats.smoothedSuccessRate;
  const inBand =
    overallStats.successRate === null
      ? null
      : overallStats.successRate >= TARGET_MIN && overallStats.successRate <= TARGET_MAX;

  const enough = attempts >= MIN_SAMPLE;
  const recommendations: MetricsRecommendation[] = [];

  if (!enough) {
    recommendations.push({
      code: "SAMPLE_TOO_SMALL",
      level: "info",
      message: `样本不足（${attempts}/${MIN_SAMPLE} 题），先积累数据，不下难度结论`,
    });
  } else if (decisionRate !== null && decisionRate > TARGET_MAX) {
    recommendations.push({
      code: "TOO_EASY",
      level: "info",
      message: `正确率高于目标区（70–85%），可以加难：多给新点/难词`,
    });
  } else if (decisionRate !== null && decisionRate < TARGET_MIN) {
    recommendations.push({
      code: "TOO_HARD",
      level: "warn",
      message: `正确率低于目标区（70–85%），建议降难：少给新点，先消化存量`,
    });
  }

  const longInterval = (byInterval ?? []).filter(
    (bucket) => bucket.key === "7_13" || bucket.key === "14_plus"
  );
  const longAttempts = longInterval.reduce((sum, bucket) => sum + bucket.attempts, 0);
  const longCorrect = longInterval.reduce((sum, bucket) => sum + bucket.correct, 0);
  const longRate = longAttempts > 0 ? longCorrect / longAttempts : null;
  if (longAttempts >= 5 && longRate !== null && longRate < TARGET_MIN) {
    recommendations.push({
      code: "LONG_INTERVAL_WEAK",
      level: "warn",
      message: `长间隔（7 天以上）保持率 ${(longRate * 100).toFixed(0)}% 偏低：缩短间隔，或答对后给提示`,
    });
  }

  if (leechRatio !== null && leechPoints >= 3 && leechRatio >= 0.2) {
    recommendations.push({
      code: "LEECH_HEAVY",
      level: "warn",
      message: `难词占比 ${(leechRatio * 100).toFixed(0)}%（${leechPoints}/${activePoints}）：这些点降频并给提示`,
    });
  }

  if (windowDays >= 7 && adherence.rate < 0.5) {
    recommendations.push({
      code: "LOW_ADHERENCE",
      level: "warn",
      message: `近 ${windowDays} 天只有 ${activeDays} 天练习（完成率 ${(adherence.rate * 100).toFixed(0)}%）：建议减少每日题量，先稳住习惯`,
    });
  }

  if (avgElapsedMs !== null && attempts >= 5 && avgElapsedMs >= 90_000) {
    recommendations.push({
      code: "SLOW_ANSWERING",
      level: "info",
      message: `平均每题 ${Math.round(avgElapsedMs / 1000)} 秒，偏长：题目可能过难，或题面太绕`,
    });
  }

  if (missing.includes("复习间隔")) {
    recommendations.push({
      code: "MISSING_INTERVAL",
      level: "info",
      message: "缺少「复习间隔」字段，算不出分档保持率；答题记录里补上作答前的间隔天数即可",
    });
  }

  return {
    window: { start, end, days: windowDays, practiceRows: parsed.length, skippedRows },
    overall: {
      ...overallStats,
      avgElapsedMs,
      hintUsedRate,
      hintSample,
    },
    byInterval,
    byType,
    bySource,
    leech: { activePoints, leechPoints, leechRatio },
    adherence,
    target: { min: TARGET_MIN, max: TARGET_MAX, inBand, decisionRate },
    sample: { attempts, minSample: MIN_SAMPLE, enough },
    prior: { rate: PRIOR_SUCCESS_RATE, weight: PRIOR_WEIGHT },
    missing,
    recommendations: recommendations.slice(0, 3),
  };
}

/** 窗口天数与起止日（给路由做展示用，也方便测试） */
export function metricsWindow(date?: string, windowDays?: number): { start: string; end: string; days: number } {
  const end = date && normalizeDateField(date) ? normalizeDateField(date)! : todayInShanghai();
  const days = Math.min(
    MAX_WINDOW_DAYS,
    Math.max(1, Math.trunc(windowDays ?? DEFAULT_WINDOW_DAYS))
  );
  return { start: addDays(end, -(days - 1)), end, days };
}

/** 给测试用：窗口内天数差 */
export function daysInWindow(date?: string, windowDays?: number): number {
  const window = metricsWindow(date, windowDays);
  return daysBetween(window.start, window.end) + 1;
}
