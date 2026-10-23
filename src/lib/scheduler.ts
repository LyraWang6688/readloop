/**
 * 复习调度：确定性、纯函数、零依赖。
 *
 * 规则来源：docs/REVIEW_RULES.md
 * 参考实现：ankitects/anki（状态机）、VienDinhCom/supermemo（SM-2 间隔公式）
 *
 * 这个文件不碰数据库、不调模型、不读时间戳（时间由调用方传入），
 * 所以可以直接单元测试，换存储或换宿主都不影响它。
 */

export type Grade = "again" | "hard" | "good" | "easy";

export type KnowledgeStateName =
  | "new"
  | "learning"
  | "review"
  | "relearning"
  | "mastered";

export interface KnowledgeState {
  state: KnowledgeStateName;
  /** 当前间隔；0 表示当天重考 */
  intervalDays: number;
  /** 难度因子，区间 [1.3, 2.8] */
  ease: number;
  /** 连续答对次数 */
  streak: number;
  /** 累计答错次数 */
  lapses: number;
  /** 练习债务，0–8 */
  need: number;
}

export const EASE_MIN = 1.3;
export const EASE_MAX = 2.8;
export const NEED_MAX = 8;
/** 连续答错达到这个次数就标记为难词 */
export const LEECH_THRESHOLD = 4;
/** 归档前必须经历过的间隔（天）：验证长间隔后的保持率 */
export const MASTERY_MIN_INTERVAL_DAYS = 7;
/** 间隔上限，防止滚到无穷大 */
const INTERVAL_CAP_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

export const INITIAL_STATE: KnowledgeState = {
  state: "new",
  intervalDays: 0,
  ease: 2.5,
  streak: 0,
  lapses: 0,
  need: 3,
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const roundMin1 = (value: number) => Math.max(1, Math.round(value));

/** 应用一次作答，返回新状态（不修改入参） */
export function applyGrade(
  current: KnowledgeState,
  grade: Grade
): KnowledgeState {
  if (grade === "again") {
    return {
      state: current.state === "review" ? "relearning" : "learning",
      intervalDays: 0,
      ease: clamp(current.ease - 0.2, EASE_MIN, EASE_MAX),
      streak: 0,
      lapses: current.lapses + 1,
      need: clamp(current.need + 1, 0, NEED_MAX),
    };
  }

  const interval =
    current.intervalDays === 0
      ? grade === "easy"
        ? 4
        : 1
      : grade === "hard"
        ? roundMin1(current.intervalDays * 1.2)
        : grade === "good"
          ? roundMin1(current.intervalDays * current.ease)
          : roundMin1(current.intervalDays * current.ease * 1.3);

  const intervalDays = Math.min(interval, INTERVAL_CAP_DAYS);
  const ease = clamp(
    current.ease + (grade === "hard" ? -0.15 : grade === "easy" ? 0.15 : 0),
    EASE_MIN,
    EASE_MAX
  );
  const streak = current.streak + 1;
  const need = clamp(current.need - 1, 0, NEED_MAX);

  const mastered =
    need === 0 &&
    streak >= 3 &&
    // 关键：要求「这次是在 ≥7 天的间隔之后答对的」，
    // 而不是「刚把下次间隔排到 7 天以上」。否则第 3 次连对就归档，
    // 从未验证过长间隔后的保持率。
    current.intervalDays >= MASTERY_MIN_INTERVAL_DAYS;

  return {
    state: mastered ? "mastered" : intervalDays >= 1 ? "review" : "learning",
    intervalDays,
    ease,
    streak,
    lapses: current.lapses,
    need,
  };
}

/** 下一次该复习的时间（UTC 毫秒） */
export function nextReviewAt(state: KnowledgeState, now: number): number {
  // 答错：次日必出（REVIEW_RULES §五，我们对「每天推一次」的适配）
  const days = state.intervalDays > 0 ? state.intervalDays : 1;
  return now + days * DAY_MS;
}

/** 到现在为止是否到期 */
export function isDue(nextReviewAtMs: number, now: number): boolean {
  return nextReviewAtMs <= now;
}

/** 是否已标记为难词：出题时降频并给提示 */
export function isLeech(state: KnowledgeState): boolean {
  return state.lapses >= LEECH_THRESHOLD;
}

/** 从零开始连续答对 n 次后的状态，便于估算间隔曲线 */
export function simulateGood(count: number): KnowledgeState {
  let state = INITIAL_STATE;
  for (let i = 0; i < count; i += 1) state = applyGrade(state, "good");
  return state;
}

/** 四种档位各自的判定来源，供服务端与 Skill 对齐口径 */
export const GRADE_RULES: Array<{
  grade: Grade;
  label: string;
  when: string;
}> = [
  { grade: "again", label: "Again", when: "答错" },
  { grade: "hard", label: "Hard", when: "答对，但用过提示或超时" },
  { grade: "good", label: "Good", when: "答对" },
  { grade: "easy", label: "Easy", when: "答对，且是生成式作答（真正自己译出来）" },
];
