/**
 * 难度调节：把「合意困难（desirable difficulty）」做成闭环。
 *
 * 理论：最佳练习难度是「努力后能答对」，目标成功率 70–85%
 * （见 docs/MEMORY_SCIENCE.md）。
 *
 * 问题：原来的每日组题只有静态配额（新点 ≤25%、难题 ≤20%），
 * 系统不知道自己给用户的实际难度，也就无法调节。
 *
 * 这个文件根据「最近 N 题的真实正确率」算出明日该加难还是降难。
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
  /** 最近窗口正确率；样本不足时为 null */
  successRate: number | null;
  /** 给日志看的一句话理由 */
  reason: string;
}

/** 目标成功率区间（合意困难） */
export const TARGET_MIN = 0.7;
export const TARGET_MAX = 0.85;

/** 少于这个样本量不做调整——几道题说明不了水平 */
export const MIN_SAMPLE = 10;

export const DEFAULT_QUOTA: DifficultyQuota = { newQuota: 2, leechQuota: 2 };
const QUOTA_MIN = 1;
const QUOTA_MAX = 3;

const clampQuota = (value: number) =>
  Math.min(QUOTA_MAX, Math.max(QUOTA_MIN, value));

/**
 * 根据最近表现给出明日难度。
 *
 * - 正确率 > 85% → 加难：多给新点和难题
 * - 正确率 < 70% → 降难：少给新点，先消化存量
 * - 区间内 → 维持
 * - 样本 < 10 题 → 维持（不猜）
 */
export function adaptDifficulty(
  performance: RecentPerformance,
  base: DifficultyQuota = DEFAULT_QUOTA
): DifficultyProfile {
  const { attempts, correct } = performance;

  if (attempts < MIN_SAMPLE) {
    return {
      ...base,
      level: "steady",
      successRate: attempts > 0 ? correct / attempts : null,
      reason: `样本不足（${attempts}/${MIN_SAMPLE} 题），维持当前难度`,
    };
  }

  const rate = correct / attempts;

  if (rate > TARGET_MAX) {
    return {
      level: "harder",
      newQuota: clampQuota(base.newQuota + 1),
      leechQuota: clampQuota(base.leechQuota + 1),
      successRate: rate,
      reason: `正确率 ${(rate * 100).toFixed(0)}% 高于目标区（70–85%），加难`,
    };
  }

  if (rate < TARGET_MIN) {
    return {
      level: "easier",
      newQuota: clampQuota(base.newQuota - 1),
      leechQuota: clampQuota(base.leechQuota - 1),
      successRate: rate,
      reason: `正确率 ${(rate * 100).toFixed(0)}% 低于目标区（70–85%），降难`,
    };
  }

  return {
    ...base,
    level: "steady",
    successRate: rate,
    reason: `正确率 ${(rate * 100).toFixed(0)}% 在目标区内，维持`,
  };
}

/** 正确率是否落在合意困难区间 */
export function inTargetBand(rate: number): boolean {
  return rate >= TARGET_MIN && rate <= TARGET_MAX;
}
