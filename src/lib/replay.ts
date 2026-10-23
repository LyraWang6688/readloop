/**
 * 回放评估的公共数学与真实日志回放（纯函数，不碰网络）。
 *
 * 两件事：
 * 1. **预测质量**：给定「预测的回忆概率」和「实际对错」，算校准分箱、Brier、log-loss；
 * 2. **真实日志回放**：用户已经按自己的节奏复习过，没法重排历史；能做的是把每条历史记录
 *    「按 SM-2 / FSRS 的口径重新预测一次」，比较谁的概率更准（而不是谁排得更好）。
 *
 * 合成调度对比（谁排得更好）在 scripts/replay-compare.ts 里；这里只放可单测的部分。
 */

import { applyGrade, INITIAL_STATE, type Grade, type KnowledgeState } from "./scheduler";
import {
  FSRS_TARGET_RETENTION,
  newCard,
  retrievability,
  reviewCardAtElapsed,
  type FsrsCard,
} from "./fsrs-lite";
import { normalizeDateField } from "./selection";
import { parseCorrectFlag, parseQuestionType } from "./metrics";

// ============================================================
// 预测质量
// ============================================================

export interface PredictionSample {
  /** 预测的「到作答时还能回忆」概率，0–1 */
  predicted: number;
  /** 实际结果：1 对 / 0 错 */
  actual: 0 | 1;
}

export interface CalibrationBin {
  key: string;
  min: number;
  max: number;
  count: number;
  avgPredicted: number | null;
  actualRate: number | null;
}

export interface PredictionScores {
  count: number;
  /** 均方误差（Brier score），越小越好 */
  brier: number | null;
  /** 对数损失，越小越好 */
  logLoss: number | null;
  bins: CalibrationBin[];
}

const BIN_EDGES = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0];

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function binKey(predicted: number): string {
  const value = clamp01(predicted);
  for (let index = 0; index < BIN_EDGES.length - 1; index += 1) {
    if (value < BIN_EDGES[index + 1]) {
      return `${BIN_EDGES[index].toFixed(1)}–${BIN_EDGES[index + 1].toFixed(1)}`;
    }
  }
  return "1.0";
}

/**
 * 评估预测质量。
 *
 * - 只统计预测值在 [0,1] 的样本；空样本返回 null 分数；
 * - log-loss 会把概率夹到 [1e-6, 1-1e-6]，避免 ln(0)
 */
export function evaluatePredictions(samples: readonly PredictionSample[]): PredictionScores {
  const valid = samples.filter(
    (sample) =>
      Number.isFinite(sample.predicted) &&
      sample.predicted >= 0 &&
      sample.predicted <= 1 &&
      (sample.actual === 0 || sample.actual === 1)
  );

  if (valid.length === 0) {
    return { count: 0, brier: null, logLoss: null, bins: [] };
  }

  let squared = 0;
  let logSum = 0;
  const buckets = new Map<string, { predicted: number; actual: number; count: number }>();

  for (const sample of valid) {
    const predicted = clamp01(sample.predicted);
    squared += (predicted - sample.actual) ** 2;
    const bounded = Math.min(1 - 1e-6, Math.max(1e-6, predicted));
    logSum += -(sample.actual * Math.log(bounded) + (1 - sample.actual) * Math.log(1 - bounded));

    const key = binKey(predicted);
    const bucket = buckets.get(key) ?? { predicted: 0, actual: 0, count: 0 };
    bucket.predicted += predicted;
    bucket.actual += sample.actual;
    bucket.count += 1;
    buckets.set(key, bucket);
  }

  const bins: CalibrationBin[] = BIN_EDGES.slice(0, -1).map((edge, index) => {
    const key = `${edge.toFixed(1)}–${BIN_EDGES[index + 1].toFixed(1)}`;
    const bucket = buckets.get(key);
    const [min, max] = key.split("–").map(Number);
    return {
      key,
      min,
      max,
      count: bucket?.count ?? 0,
      avgPredicted: bucket ? bucket.predicted / bucket.count : null,
      actualRate: bucket ? bucket.actual / bucket.count : null,
    };
  });

  return {
    count: valid.length,
    brier: squared / valid.length,
    logLoss: logSum / valid.length,
    bins,
  };
}

/** 单位时间/单位复习的保持率（长期保持率 ÷ 复习强度） */
export function unitRetention(input: {
  reviews: number;
  days: number;
  longIntervalAttempts: number;
  longIntervalCorrect: number;
}): {
  reviewsPerDay: number;
  longRetention: number | null;
  /** 每次复习对应的长期保持率（×1000 展示为「‰/次」） */
  longRetentionPerReview: number | null;
  /** 每天每 1 次复习换来的长期保持率（无量纲，越大越划算） */
  longRetentionPerDailyLoad: number | null;
} {
  const reviewsPerDay = input.days > 0 ? input.reviews / input.days : 0;
  const longRetention =
    input.longIntervalAttempts > 0 ? input.longIntervalCorrect / input.longIntervalAttempts : null;
  return {
    reviewsPerDay,
    longRetention,
    longRetentionPerReview: longRetention === null ? null : longRetention / Math.max(1, input.reviews),
    longRetentionPerDailyLoad:
      longRetention === null || reviewsPerDay === 0 ? null : longRetention / reviewsPerDay,
  };
}

// ============================================================
// 真实日志回放（不重排历史，只比较预测质量）
// ============================================================

export type ReplayScheduler = "sm2" | "fsrs";

interface RealEvent {
  cardId: string;
  date: string | null;
  elapsedDays: number;
  correct: boolean;
  type: "choice" | "cloze" | null;
  order: number;
}

export interface RealReplayResult {
  scheduler: ReplayScheduler;
  events: number;
  skipped: number;
  predictions: PredictionSample[];
  lapses: number;
}

function readNumberLike(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function readTextLike(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** 从 practice_events 的行里取出回放需要的最小字段（缺 知识点 / 复习间隔 的行跳过） */
export function parseRealPracticeRows(rows: readonly unknown[]): {
  events: RealEvent[];
  skipped: number;
} {
  const events: RealEvent[] = [];
  let skipped = 0;
  rows.forEach((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      skipped += 1;
      return;
    }
    const record = row as Record<string, unknown>;
    const cardId = readTextLike(record["知识点"]) ?? readTextLike(record["归一化内容"]);
    const elapsed = readNumberLike(record["复习间隔"]);
    const correct = parseCorrectFlag(record["是否正确"]);
    if (!cardId || elapsed === null || elapsed < 0 || correct === null) {
      skipped += 1;
      return;
    }
    events.push({
      cardId,
      date: normalizeDateField(record["答题时间"]) ?? null,
      elapsedDays: Math.trunc(elapsed),
      correct,
      type: parseQuestionType(record["题型"]),
      order: index,
    });
  });

  events.sort((a, b) => {
    // 没有日期的记录排到最后（不知道发生顺序，不能排最前）
    const dateA = a.date ?? "\uffff";
    const dateB = b.date ?? "\uffff";
    if (dateA !== dateB) return dateA < dateB ? -1 : 1;
    return a.order - b.order;
  });
  return { events, skipped };
}

function gradeForReal(event: RealEvent): Grade {
  if (!event.correct) return "again";
  return event.type === "cloze" ? "easy" : "good";
}

/**
 * 回放真实日志：按历史顺序维护每个知识点的调度器状态，
 * 在**每次作答前**用当前状态算一个「预测回忆概率」，再与真实对错比较。
 *
 * 说明：历史间隔不可更改，所以这里评的是「预测得准不准」，不是「谁排得更好」。
 */
export function replayRealLogs(
  rows: readonly unknown[],
  scheduler: ReplayScheduler,
  fsrsRetention: number = FSRS_TARGET_RETENTION
): RealReplayResult {
  const { events, skipped } = parseRealPracticeRows(rows);

  const sm2States = new Map<string, KnowledgeState>();
  const fsrsStates = new Map<string, FsrsCard>();
  const predictions: PredictionSample[] = [];
  let lapses = 0;

  for (const event of events) {
    let predicted: number;
    if (scheduler === "sm2") {
      const state = sm2States.get(event.cardId) ?? { ...INITIAL_STATE };
      // SM-2 没有概率模型：假设它把「上次排的间隔」当 90% 保持点，按指数衰减折算
      predicted =
        state.intervalDays > 0
          ? Math.pow(0.9, event.elapsedDays / state.intervalDays)
          : // 首次接触没有历史：按 90% 先验，不假设「一定记得」
            0.9;
      const grade = gradeForReal(event);
      const next = applyGrade(state, grade);
      sm2States.set(event.cardId, next);
      if (grade === "again") lapses += 1;
    } else {
      const card = fsrsStates.get(event.cardId) ?? newCard(0);
      // 首次接触同样用 90% 先验
      predicted = card.reps === 0 ? 0.9 : retrievability(event.elapsedDays, card.stability);
      const next = reviewCardAtElapsed(
        card,
        event.correct ? (event.type === "cloze" ? 4 : 3) : 1,
        event.elapsedDays,
        0,
        fsrsRetention
      );
      fsrsStates.set(event.cardId, next);
      if (!event.correct) lapses += 1;
    }

    predictions.push({
      predicted: Math.min(1, Math.max(0, predicted)),
      actual: event.correct ? 1 : 0,
    });
  }

  return {
    scheduler,
    events: events.length,
    skipped,
    predictions,
    lapses,
  };
}
