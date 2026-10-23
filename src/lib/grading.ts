/**
 * 判分：确定性、纯函数、零依赖。
 *
 * 设计目标（见 docs/REVIEW_RULES.md §三）：
 * - 选择题 → 识别式，答对记 Good
 * - 填空题 → **用户自己输入**，生成式，答对记 Easy
 * - 容错仅限"拼写误差"，不允许语义近似——判分绝不调用大模型
 *
 * 为什么填空题要自己输入：识别式只能证明"认得出来"，
 * 生成式才要求"想得起来"（Bjork 的存储强度 vs 提取强度）。
 */

import type { Grade } from "./scheduler";

export type QuestionType = "choice" | "cloze";

export type JudgeReason = "exact" | "normalized" | "typo" | "mismatch";

export interface JudgeResult {
  correct: boolean;
  reason: JudgeReason;
  /** 归一化后的期望答案 */
  expected: string;
  /** 归一化后的用户答案 */
  actual: string;
  /** 编辑距离（归一化后） */
  distance: number;
  /** 允许的编辑距离 */
  allowed: number;
}

/** 归一化：去首尾空白、合并内部空白、转小写、去掉包裹的标点 */
export function normalizeAnswer(input: string): string {
  return input
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[^a-z0-9']+/, "")
    .replace(/[^a-z0-9']+$/, "");
}

/**
 * Damerau-Levenshtein（最优字符串对齐）：相邻字符对调算 1 次编辑。
 * 用来容忍 recieve → receive 这类常见拼写错误。
 */
export function damerauLevenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, () =>
    new Array<number>(cols).fill(0)
  );

  for (let i = 0; i < rows; i += 1) d[i][0] = i;
  for (let j = 0; j < cols; j += 1) d[0][j] = j;

  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + cost
      );
      // 相邻字符对调
      if (
        i > 1 &&
        j > 1 &&
        a[i - 1] === b[j - 2] &&
        a[i - 2] === b[j - 1]
      ) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }

  return d[rows - 1][cols - 1];
}

/**
 * 允许的编辑距离。
 * 短词（≤4）不容错——"from" 和 "form" 只差一次对调，但完全是两个词。
 */
export function allowedDistance(normalizedExpected: string): number {
  const len = normalizedExpected.length;
  if (len <= 4) return 0;
  if (len <= 8) return 1;
  return 2;
}

/** 判断题（选择题）：只看对错，不涉及拼写 */
export function judgeChoice(
  expected: string,
  actual: string
): JudgeResult {
  const e = normalizeAnswer(expected);
  const a = normalizeAnswer(actual);
  const correct = e === a && e.length > 0;
  return {
    correct,
    reason: correct ? "exact" : "mismatch",
    expected: e,
    actual: a,
    distance: correct ? 0 : damerauLevenshtein(e, a),
    allowed: 0,
  };
}

/** 填空题：归一化后比较，允许拼写误差 */
export function judgeCloze(
  expected: string,
  actual: string,
  acceptedAlternatives: string[] = []
): JudgeResult {
  const e = normalizeAnswer(expected);
  const a = normalizeAnswer(actual);
  const allowed = allowedDistance(e);

  const candidates = [e, ...acceptedAlternatives.map(normalizeAnswer)];
  let best = Infinity;
  for (const candidate of candidates) {
    best = Math.min(best, damerauLevenshtein(candidate, a));
  }

  const correct = best <= allowed;
  const reason: JudgeReason = !correct
    ? "mismatch"
    : a === e
      ? "exact"
      : best === 0
        ? "normalized"
        : "typo";

  return { correct, reason, expected: e, actual: a, distance: best, allowed };
}

/**
 * 由作答结果推导复习档位（四档，见 scheduler.ts）。
 *
 * - 选择题答对 → good
 * - 填空题答对 → easy（生成式作答，信号更强）
 * - 拼写容错通过 → hard（答对了，但不干净）
 * - 用了提示 → 降一档
 * - 答错 → again
 */
export function toGrade(
  type: QuestionType,
  outcome: JudgeResult,
  usedHint = false
): Grade {
  if (!outcome.correct) return "again";

  if (outcome.reason === "typo") return usedHint ? "again" : "hard";
  if (usedHint) return "hard";

  return type === "cloze" ? "easy" : "good";
}
