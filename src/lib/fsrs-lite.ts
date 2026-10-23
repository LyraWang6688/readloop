/**
 * FSRS-4.5 的最小实现（仅用于离线回放评估，不参与线上调度）。
 *
 * 为什么放这里而不是装 ts-fsrs：
 * - 评估脚本只要「按 FSRS 公式排间隔」这一件事，不需要完整库；
 * - 避免为一个离线脚本增加运行时依赖；
 * - 线上仍然用 `scheduler.ts`（SM-2 简化版），是否切换等评估结论。
 *
 * 公式与默认参数来自 FSRS-4.5（19 参数默认值，见 open-spaced-repetition/fsrs4anki
 * 与 ts-fsrs 的默认配置）：
 *   R(t, S) = (1 + 19/81 × t/S)^(-0.5)
 *   目标保持率 0.9 时，理论间隔 I(S) = S（这正是因子 19/81 的来源）
 *
 * 简化（只影响模拟精度，不影响相对比较）：
 * - learning steps 折叠到「天」粒度：答错次日再见，答对按公式排；
 * - 不考虑同一天多次复习、时区/学习日边界。
 */

export const FSRS_FACTOR = 19 / 81;
export const FSRS_DECAY = -0.5;
export const FSRS_TARGET_RETENTION = 0.9;

/** FSRS-4.5 默认参数（w[0]–w[18]） */
export const FSRS_45_DEFAULT_PARAMS = [
  0.4072, 1.1829, 3.1262, 15.4722, 7.2102, 0.5316, 1.0651, 0.0234, 1.616, 0.1544, 1.0824, 1.9813,
  0.0953, 0.2975, 2.2042, 0.2407, 2.9466, 0.5034, 0.6567,
] as const;

/** 1=Again, 2=Hard, 3=Good, 4=Easy */
export type FsrsGrade = 1 | 2 | 3 | 4;

/** 0=New, 1=Learning, 2=Review, 3=Relearning */
export type FsrsState = 0 | 1 | 2 | 3;

export interface FsrsCard {
  state: FsrsState;
  stability: number;
  difficulty: number;
  reps: number;
  lapses: number;
  /** 上次复习的「第几天」（从 0 开始）；新卡为 null */
  lastReviewDay: number | null;
  /** 下次应复习的「第几天」 */
  dueDay: number;
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

/** t 天后仍能回忆的概率 */
export function retrievability(elapsedDays: number, stability: number): number {
  if (stability <= 0) return 0;
  if (elapsedDays <= 0) return 1;
  return Math.pow(1 + (FSRS_FACTOR * elapsedDays) / stability, FSRS_DECAY);
}

/** 达到目标保持率需要的间隔天数（0.9 → ≈stability） */
export function intervalForRetention(
  stability: number,
  retention: number = FSRS_TARGET_RETENTION
): number {
  if (stability <= 0) return 1;
  const raw = (stability / FSRS_FACTOR) * (Math.pow(retention, 1 / FSRS_DECAY) - 1);
  return Math.max(1, Math.round(raw));
}

function initialStability(grade: FsrsGrade, w = FSRS_45_DEFAULT_PARAMS): number {
  return Math.max(0.1, w[grade - 1]);
}

function initialDifficulty(grade: FsrsGrade, w = FSRS_45_DEFAULT_PARAMS): number {
  return clamp(w[4] - (grade - 3) * w[5], 1, 10);
}

function nextDifficulty(
  difficulty: number,
  grade: FsrsGrade,
  w = FSRS_45_DEFAULT_PARAMS
): number {
  const delta = -w[6] * (grade - 3);
  const damped = difficulty + (delta * (10 - difficulty)) / 9;
  // 均值回归到「Good 的初始难度」
  const reverted = w[7] * initialDifficulty(3, w) + (1 - w[7]) * damped;
  return clamp(reverted, 1, 10);
}

function nextStability(
  difficulty: number,
  stability: number,
  recallProbability: number,
  grade: FsrsGrade,
  w = FSRS_45_DEFAULT_PARAMS
): number {
  if (grade === 1) {
    // 遗忘：稳定性坍塌
    const next =
      w[11] *
      Math.pow(difficulty, -w[12]) *
      (Math.pow(stability + 1, w[13]) - 1) *
      Math.exp(w[14] * (1 - recallProbability));
    return clamp(next, 0.1, 36500);
  }

  const hardPenalty = grade === 2 ? w[15] : 1;
  const easyBonus = grade === 4 ? w[16] : 1;
  const next =
    stability *
    (1 +
      Math.exp(w[8]) *
        (11 - difficulty) *
        Math.pow(stability, -w[9]) *
        (Math.exp(w[10] * (1 - recallProbability)) - 1) *
        hardPenalty *
        easyBonus);
  return clamp(next, 0.1, 36500);
}

export function newCard(day = 0): FsrsCard {
  return {
    state: 0,
    stability: 0,
    difficulty: 0,
    reps: 0,
    lapses: 0,
    lastReviewDay: null,
    dueDay: day,
  };
}

/** 按一次作答更新卡片（返回新卡，不修改入参） */
export function reviewCard(
  card: FsrsCard,
  grade: FsrsGrade,
  day: number,
  targetRetention: number = FSRS_TARGET_RETENTION
): FsrsCard {
  const isFirst = card.reps === 0;
  const elapsed = card.lastReviewDay === null ? 0 : Math.max(0, day - card.lastReviewDay);
  const recall = isFirst ? 1 : retrievability(elapsed, card.stability);

  const stability = isFirst
    ? initialStability(grade)
    : nextStability(card.difficulty, card.stability, recall, grade);
  const difficulty = isFirst
    ? initialDifficulty(grade)
    : nextDifficulty(card.difficulty, grade);

  // 天粒度简化：Again 次日见；其余按目标保持率算间隔
  const interval = grade === 1 ? 1 : intervalForRetention(stability, targetRetention);

  return {
    state: isFirst ? 1 : grade === 1 ? 3 : 2,
    stability,
    difficulty,
    reps: card.reps + 1,
    lapses: card.lapses + (grade === 1 ? 1 : 0),
    lastReviewDay: day,
    dueDay: day + interval,
  };
}
