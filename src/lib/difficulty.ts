/**
 * 难度调节：把「合意困难（desirable difficulty）」做成闭环。
 *
 * 理论：最佳练习难度是「努力后能答对」，目标成功率 70–85%
 * （见 docs/MEMORY_SCIENCE.md）。
 *
 * 关键设计（2026-10-23 修订）：
 * - **小样本保护**：少于 20 题不下结论（原来是 10 题，容易「昨天运气好就加难」）；
 * - **贝叶斯平滑**：正确率不是直接 correct/attempts，而是先向 78% 拉一拉
 *   （先验 10 题），这样 5 题全对不会被当成「太简单」；
 * - 决策用平滑后的正确率，展示与日志同时给原始值，便于解释「为什么这么调」。
 *
 * 纯函数、零依赖、不碰数据库。
 */

export interface RecentPerformance {
  /** 最近窗口内的作答次数 */
  attempts: number;
  /** 其中答对的次数 */
  correct: number;
}

export type DifficultyLevel = "easier" | "steady" | "harder";

export interface DifficultyQuota {
  /** 每天引入的新知识点数量 */
  newQuota: number;
  /** 每天出现的难题（leech）数量 */
  leechQuota: number;
}

export interface DifficultyProfile extends DifficultyQuota {
  level: DifficultyLevel;
  /** 原始正确率 correct / attempts；样本为 0 时为 null */
  successRate: number | null;
  /** 贝叶斯平滑后的正确率（决策依据）；样本为 0 时为 null */
  smoothedSuccessRate: number | null;
  /** 平滑使用的先验，便于排障与文档 */
  prior: { rate: number; weight: number };
  /** 给日志/界面看的一句话理由 */
  reason: string;
}

/** 目标成功率区间（合意困难） */
export const TARGET_MIN = 0.7;
export const TARGET_MAX = 0.85;

/** 少于这个样本量不做调整——20 题才够看出趋势 */
export const MIN_SAMPLE = 20;

/** 平滑先验：假设用户是个「78% 正确率」的普通学习者，相当于先验 10 题 */
export const PRIOR_SUCCESS_RATE = 0.78;
export const PRIOR_WEIGHT = 10;

export const DEFAULT_QUOTA: DifficultyQuota = { newQuota: 2, leechQuota: 2 };
const QUOTA_MIN = 1;
const QUOTA_MAX = 3;

const clampQuota = (value: number) =>
  Math.min(QUOTA_MAX, Math.max(QUOTA_MIN, value));

/**
 * 贝叶斯平滑正确率：(correct + priorRate × priorWeight) / (attempts + priorWeight)。
 * 样本为 0 时返回 null（没有信息，不猜）。
 */
export function smoothSuccessRate(
  correct: number,
  attempts: number,
  priorRate: number = PRIOR_SUCCESS_RATE,
  priorWeight: number = PRIOR_WEIGHT
): number | null {
  if (!Number.isFinite(attempts) || attempts <= 0) return null;
  const safeCorrect = Math.min(Math.max(0, correct), attempts);
  return (safeCorrect + priorRate * priorWeight) / (attempts + priorWeight);
}

/** 原始正确率；样本为 0 时返回 null */
export function rawSuccessRate(correct: number, attempts: number): number | null {
  if (!Number.isFinite(attempts) || attempts <= 0) return null;
  return Math.min(Math.max(0, correct), attempts) / attempts;
}

const pct = (rate: number | null) =>
  rate === null ? "—" : `${(rate * 100).toFixed(0)}%`;

/**
 * 根据最近表现给出明日难度。
 *
 * - 样本 < 20 题 → 维持（不猜）
 * - 平滑后正确率 > 85% → 加难：多给新点和难题
 * - 平滑后正确率 < 70% → 降难：少给新点，先消化存量
 * - 区间内 → 维持
 */
export function adaptDifficulty(
  performance: RecentPerformance,
  base: DifficultyQuota = DEFAULT_QUOTA
): DifficultyProfile {
  const attempts = Math.max(0, Math.trunc(performance.attempts));
  const correct = Math.min(Math.max(0, Math.trunc(performance.correct)), attempts);
  const rate = rawSuccessRate(correct, attempts);
  const smoothed = smoothSuccessRate(correct, attempts);
  const prior = { rate: PRIOR_SUCCESS_RATE, weight: PRIOR_WEIGHT };

  if (attempts < MIN_SAMPLE) {
    return {
      ...base,
      level: "steady",
      successRate: rate,
      smoothedSuccessRate: smoothed,
      prior,
      reason: `样本不足（${attempts}/${MIN_SAMPLE} 题），维持当前难度`,
    };
  }

  // 决策用平滑值（样本 >= 20 时它已很接近原始值，但能防止极端样本抖动）
  const decisionRate = smoothed ?? rate ?? PRIOR_SUCCESS_RATE;
  const evidence = `正确率 ${pct(rate)}（平滑后 ${pct(smoothed)}）`;

  if (decisionRate > TARGET_MAX) {
    return {
      level: "harder",
      newQuota: clampQuota(base.newQuota + 1),
      leechQuota: clampQuota(base.leechQuota + 1),
      successRate: rate,
      smoothedSuccessRate: smoothed,
      prior,
      reason: `${evidence} 高于目标区（70–85%），加难`,
    };
  }

  if (decisionRate < TARGET_MIN) {
    return {
      level: "easier",
      newQuota: clampQuota(base.newQuota - 1),
      leechQuota: clampQuota(base.leechQuota - 1),
      successRate: rate,
      smoothedSuccessRate: smoothed,
      prior,
      reason: `${evidence} 低于目标区（70–85%），降难`,
    };
  }

  return {
    ...base,
    level: "steady",
    successRate: rate,
    smoothedSuccessRate: smoothed,
    prior,
    reason: `${evidence} 在目标区内，维持`,
  };
}

/** 正确率是否落在合意困难区间（按原始值判断，供指标展示用） */
export function inTargetBand(rate: number): boolean {
  return rate >= TARGET_MIN && rate <= TARGET_MAX;
}
