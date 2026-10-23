/**
 * today / submit 的业务编排：确定性、可单测、不依赖 Next.js。
 *
 * 规则来源：docs/API_IMPLEMENTATION.md §4 §5
 *
 * 为什么编排单独成文件：
 * - 路由只做「鉴权 + 读 env + 信封」，这一段才是业务；
 * - 编排只依赖纯函数（selection / questions / grading / scheduler / token），
 *   scripts/review-check.ts 可以用 tsx 直接跑（真签名往返，不碰网络）；
 * - 服务端无状态：答案与作答前快照都放在 question_id 的签名里，
 *   submit 只靠一个 token 就能幂等地判分并算出新的复习状态。
 */

import { addDays, isDateString, todayInShanghai } from "./date";
import {
  adaptDifficulty,
  DEFAULT_QUOTA,
  type DifficultyProfile,
  type RecentPerformance,
} from "./difficulty";
import { ModelConfigError, normalizeModelConfig } from "./model";
import {
  isPointState,
  parsePoints,
  selectDailyPoints,
  type ReviewPoint,
} from "./selection";
import { buildQuestions } from "./questions";
import {
  decodeQuestionId,
  signQuestionId,
  type QuestionPayload,
} from "./token";
import {
  judgeChoice,
  judgeCloze,
  toGrade,
  type JudgeResult,
  type QuestionType,
} from "./grading";
import {
  applyGrade,
  type Grade,
  type KnowledgeState,
  type KnowledgeStateName,
} from "./scheduler";

// ============================================================
// 常量与返回结构
// ============================================================

/** 答对但超过这个时长（毫秒）降为 hard（REVIEW_RULES §三） */
export const ELAPSED_HARD_THRESHOLD_MS = 90_000;

/** 签名载荷里的讲解字段做截断，控制 question_id 体积（§2.3 要求 1KB 内） */
const MAX_MEANING_CHARS = 120;
const MAX_EXPLANATION_CHARS = 200;
const MAX_SOURCE_URL_CHARS = 400;
const MAX_ALT_CHARS = 60;

export type ReviewErrorCode =
  | "INVALID_PARAMS"
  | "MODEL_CONFIG_INVALID"
  | "POINTS_EMPTY"
  | "POINTS_INVALID"
  | "QUESTION_INVALID";

export type ReviewResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      status: 400 | 422;
      code: ReviewErrorCode;
      message: string;
      details?: string;
    };

function fail(
  status: 400 | 422,
  code: ReviewErrorCode,
  message: string,
  details?: string
): ReviewResult<never> {
  return { ok: false, status, code, message, ...(details ? { details } : {}) };
}

/** 对外的单题结构：只有题面、不含答案（答案在签名里） */
export interface TodayQuestion {
  question_id: string;
  type: QuestionType;
  stem: string;
  /** 仅选择题有；填空题为 undefined（JSON 里不出现） */
  options?: string[];
  context: string | null;
  hint: string | null;
}

export interface TodaySessionContext {
  new_count: number;
  due_count: number;
  weak_points: string[];
}

export interface TodayResponse {
  date: string;
  variant: number;
  total: number;
  /** 服务端不记进度，恒为 0；宿主自己数 submit 次数 */
  answered: 0;
  questions: TodayQuestion[];
  session_context: TodaySessionContext;
  /**
   * 按「最近表现」算出的今日难度（宿主可选传 performance）。
   * 不传时 = 默认配额 + 样本不足说明；宿主可以拿 reason 向用户解释。
   */
  difficulty: DifficultyProfile;
}

/** 回写飞书表的字段（宿主必须原样写回，不要自己重算） */
export interface SubmitUpdates {
  知识点: string;
  归一化内容: string;
  状态: KnowledgeStateName;
  间隔天数: number;
  难度因子: number;
  连对次数: number;
  答错次数: number;
  待练次数: number;
  下次复习: string;
  最近暴露: string;
}

export interface SubmitResponse {
  /** Store 契约口径：correct / wrong */
  result: "correct" | "wrong";
  grade: Grade;
  explanation: string;
  updates: SubmitUpdates;
}

// ============================================================
// 小工具
// ============================================================

/**
 * 解析可选的 `performance`：{ attempts, correct }。
 *
 * 宿主从 practice_events 取最近 20 题（或最近 N 天）算出两个数；
 * 不传就是「没有数据」，难度维持默认。
 */
function parsePerformance(
  input: unknown
): { ok: true; value: RecentPerformance | null } | { ok: false; message: string } {
  if (input === undefined || input === null) {
    return { ok: true, value: null };
  }
  if (typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, message: "performance 必须是对象：{ attempts, correct }" };
  }
  const record = input as Record<string, unknown>;
  const attempts = record.attempts;
  const correct = record.correct;
  if (
    typeof attempts !== "number" ||
    !Number.isInteger(attempts) ||
    attempts < 0 ||
    attempts > 100_000
  ) {
    return { ok: false, message: "performance.attempts 必须是非负整数" };
  }
  if (
    typeof correct !== "number" ||
    !Number.isInteger(correct) ||
    correct < 0 ||
    correct > attempts
  ) {
    return { ok: false, message: "performance.correct 必须是 0 到 attempts 之间的整数" };
  }
  return { ok: true, value: { attempts, correct } };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function clip(input: string, maxChars: number): string {
  const trimmed = input.trim();
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}…` : trimmed;
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function toNonNegativeNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return null;
}

// ============================================================
// POST /api/review/today 的编排
// ============================================================

/**
 * 校验 date / model / points，选题、出题、签名并组装今日题包。
 *
 * 错误码（§1.3）：
 * - date 格式错 / 请求体不是对象 → 400 INVALID_PARAMS
 * - model 配置不合法 → 400 MODEL_CONFIG_INVALID
 * - points 为空 → 422 POINTS_EMPTY；字段不全 → 422 POINTS_INVALID
 */
export function orchestrateToday(
  body: unknown,
  questionSecret: string,
  nowMs: number = Date.now()
): ReviewResult<TodayResponse> {
  const record = asRecord(body);
  if (!record) {
    return fail(400, "INVALID_PARAMS", "请求体必须是 JSON 对象");
  }

  // 1. 日期：缺省用上海时区的今天
  let date = todayInShanghai(nowMs);
  if (record.date !== undefined && record.date !== null && record.date !== "") {
    if (typeof record.date !== "string" || !isDateString(record.date.trim())) {
      return fail(400, "INVALID_PARAMS", "date 必须是 YYYY-MM-DD");
    }
    date = record.date.trim();
  }

  // 2. 模型配置：MVP 不参与出题，但仍照规格校验与接收（换模型不影响选题/判分）
  try {
    normalizeModelConfig(record.model);
  } catch (error) {
    const message =
      error instanceof ModelConfigError ? error.message : "model 配置无效";
    return fail(400, "MODEL_CONFIG_INVALID", message);
  }

  // 3. 最近表现（可选）：宿主从 practice_events 取最近 N 题，只传两个数字
  const performanceResult = parsePerformance(record.performance);
  if (!performanceResult.ok) {
    return fail(400, "INVALID_PARAMS", performanceResult.message);
  }
  const difficulty = adaptDifficulty(performanceResult.value ?? { attempts: 0, correct: 0 }, DEFAULT_QUOTA);

  // 4. 知识点：中文表字段 → 内部结构
  const parsed = parsePoints(record.points);
  if (!parsed.ok) {
    return fail(422, parsed.code, parsed.message, parsed.details);
  }

  // 5. 选题 → 出题 → 签名
  //    MVP 不读 READLOOP_QUESTION_LLM（纯模板）；将来在此按开关注入 questions.ts 的 polisher
  const selection = selectDailyPoints(parsed.points, date, {
    // 难度只影响「今天引入几个新点」；到期/补位规则不变
    newQuota: difficulty.newQuota,
  });
  const questions = buildQuestions(selection, { pool: parsed.points });

  const publicQuestions = questions.map((question) =>
    toPublicQuestion(question, date, questionSecret)
  );

  return {
    ok: true,
    data: {
      date,
      variant: selection.variant,
      total: publicQuestions.length,
      answered: 0,
      questions: publicQuestions,
      session_context: {
        new_count: selection.newCount,
        due_count: selection.dueCount,
        weak_points: selection.weakPoints,
      },
      difficulty,
    },
  };
}

/** 把模板题签成 question_id，并剥掉答案，只留对外字段 */
function toPublicQuestion(
  question: ReturnType<typeof buildQuestions>[number],
  date: string,
  secret: string
): TodayQuestion {
  const point: ReviewPoint = question.point;
  const isChoice = question.type === "choice";

  const questionId = signQuestionId(
    {
      d: date,
      k: point.content,
      p: point.id,
      t: question.type,
      a: question.answer,
      alt:
        question.alt.length > 0
          ? question.alt.slice(0, 3).map((value) => clip(value, MAX_ALT_CHARS))
          : undefined,
      // 选项原文进签名：宿主既可以提交 A–D 字母，也可以提交选项原文（§5）
      o: isChoice ? question.options : undefined,
      m: point.meaning ? clip(point.meaning, MAX_MEANING_CHARS) : undefined,
      e: point.explanation
        ? clip(point.explanation, MAX_EXPLANATION_CHARS)
        : undefined,
      src: point.sourceUrl ? clip(point.sourceUrl, MAX_SOURCE_URL_CHARS) : undefined,
      s: {
        st: point.state,
        iv: point.intervalDays,
        ea: point.ease,
        sk: point.streak,
        lp: point.lapses,
        nd: point.need,
      },
    },
    secret
  );

  return {
    question_id: questionId,
    type: question.type,
    stem: question.stem,
    ...(isChoice ? { options: question.options } : {}),
    context: question.context,
    hint: question.hint,
  };
}

// ============================================================
// POST /api/review/submit 的编排
// ============================================================

/**
 * 从签名载荷还原作答前的状态快照。
 * token 是我们自己签的，理论上可信；仍然对数字做一次兜底，避免异常快照把状态机弄坏。
 */
function snapshotFromPayload(payload: QuestionPayload): KnowledgeState {
  const snapshot = payload.s;
  return {
    state: isPointState(snapshot.st) ? snapshot.st : "new",
    intervalDays: Math.max(0, finiteOr(snapshot.iv, 0)),
    ease: finiteOr(snapshot.ea, 2.5),
    streak: Math.max(0, finiteOr(snapshot.sk, 0)),
    lapses: Math.max(0, finiteOr(snapshot.lp, 0)),
    need: Math.min(8, Math.max(0, finiteOr(snapshot.nd, 3))),
  };
}

/**
 * 选择题判分口径（§5，2026-10-23 由 Lead 确认）：
 * - answer 是单个字母 A–D 且签名里有 `o`（选项原文）→ 映射成对应选项再判分；
 * - 否则把 answer 当选项原文判分。
 */
function resolveChoiceAnswer(
  payload: QuestionPayload,
  answer: string
): { expected: string; letterWithoutOptions: boolean } {
  const letter = /^[A-Da-d]$/.exec(answer.trim());
  const options = payload.o;
  if (letter && options && options.length > 0) {
    const index = letter[0].toUpperCase().charCodeAt(0) - "A".charCodeAt(0);
    if (index >= 0 && index < options.length) {
      return { expected: options[index], letterWithoutOptions: false };
    }
  }
  // 旧 token 可能没有 `o`：此时字母无法映射，按原文判错并明确提示
  return { expected: answer, letterWithoutOptions: Boolean(letter) && !options };
}

export interface ExplanationInput {
  payload: QuestionPayload;
  outcome: JudgeResult;
  grade: Grade;
  usedHint: boolean;
  timedOut: boolean;
  /** 宿主只提交了字母：选择题没有选项可映射，或填空题误传字母 */
  letterWithoutOptions: boolean;
}

/**
 * 讲解文案：只用「正确答案 + 释义 + 解释 + 判分原因」拼装，不调模型。
 * 单独导出便于单测。
 */
export function buildExplanation(input: ExplanationInput): string {
  const { payload, outcome, grade, usedHint, timedOut } = input;
  const parts: string[] = [];
  const meaning = payload.m ? `（${payload.m}）` : "";
  parts.push(`正确答案：${payload.k}${meaning}。`);

  if (!outcome.correct) {
    parts.push("这次没有答对，已排到次日重新练习。");
    if (input.letterWithoutOptions) {
      parts.push(
        payload.t === "choice"
          ? "这道题请提交选项原文，不要提交选项字母。"
          : "这题请填写答案原文，不要提交选项字母。"
      );
    }
  } else if (grade === "hard") {
    if (usedHint) {
      parts.push("这次用了提示，记为 Hard。");
    } else if (outcome.reason === "typo") {
      parts.push("拼写有偏差但按容错判为正确，记为 Hard。");
    } else if (timedOut) {
      parts.push("作答超过 90 秒，记为 Hard。");
    } else {
      parts.push("这次记为 Hard。");
    }
  } else if (grade === "easy") {
    parts.push("填空题答对，记为 Easy。");
  } else {
    parts.push("选择题答对，记为 Good。");
  }

  if (payload.e) parts.push(payload.e);
  return parts.join("");
}

/**
 * 判分 → 档位 → 新状态 → updates。
 *
 * 幂等：结果只由签名载荷（含作答前快照）与本次请求的 answer / used_hint / elapsed_ms
 * 决定，不读当前表状态，所以同一个 question_id 重复提交得到同一组 updates。
 */
export function orchestrateSubmit(
  body: unknown,
  questionSecret: string,
  nowMs: number = Date.now()
): ReviewResult<SubmitResponse> {
  const record = asRecord(body);
  if (!record) {
    return fail(400, "INVALID_PARAMS", "请求体必须是 JSON 对象");
  }

  // date 只是兼容请求体里的字段；真正用于计算的是签名里的出题日期 d
  if (record.date !== undefined && record.date !== null && record.date !== "") {
    if (typeof record.date !== "string" || !isDateString(record.date.trim())) {
      return fail(400, "INVALID_PARAMS", "date 必须是 YYYY-MM-DD");
    }
  }

  const questionId = record.question_id;
  if (typeof questionId !== "string" || questionId.trim() === "") {
    return fail(400, "QUESTION_INVALID", "缺少 question_id");
  }

  if (typeof record.answer !== "string") {
    return fail(400, "INVALID_PARAMS", "answer 必须是字符串（选择题可传 A–D 或选项原文，填空题传输入原文）");
  }

  if (record.used_hint !== undefined && typeof record.used_hint !== "boolean") {
    return fail(400, "INVALID_PARAMS", "used_hint 必须是布尔值");
  }
  const usedHint = record.used_hint === true;

  let elapsedMs = 0;
  if (record.elapsed_ms !== undefined) {
    const parsed = toNonNegativeNumber(record.elapsed_ms);
    if (parsed === null) {
      return fail(400, "INVALID_PARAMS", "elapsed_ms 必须是非负数字");
    }
    elapsedMs = parsed;
  }

  // 1. 验签；失败与过期都按 400 QUESTION_INVALID 处理（§5）
  const decoded = decodeQuestionId(questionId, questionSecret, nowMs);
  if (!decoded.ok) {
    const expired = decoded.reason === "expired";
    return fail(
      400,
      "QUESTION_INVALID",
      expired
        ? "题目已过期（出题日 + 48 小时），请重新获取今日题目"
        : "question_id 无效，请重新获取今日题目"
    );
  }
  const payload = decoded.payload;

  // 2. 确定性判分（不调模型）
  let outcome: JudgeResult;
  let letterWithoutOptions = false;
  if (payload.t === "choice") {
    const resolved = resolveChoiceAnswer(payload, record.answer);
    letterWithoutOptions = resolved.letterWithoutOptions;
    outcome = judgeChoice(payload.a, resolved.expected);
  } else {
    // 填空题只接受用户输入的答案原文；用户若提交了单个字母，判错并明确提示
    letterWithoutOptions = /^[A-Za-z]$/.test(record.answer.trim());
    outcome = judgeCloze(payload.a, record.answer, payload.alt ?? []);
  }

  // 3. 档位：答对但超时也降为 hard（与「用提示」并列）
  let grade = toGrade(payload.t, outcome, usedHint);
  const timedOut = outcome.correct && elapsedMs > ELAPSED_HARD_THRESHOLD_MS;
  if (timedOut && grade !== "hard") grade = "hard";

  // 4. 新状态：快照 + 档位 → 状态机
  const snapshot = snapshotFromPayload(payload);
  const nextState = applyGrade(snapshot, grade);

  // 5. 下次复习：答错（间隔 0）次日必出
  const nextReview = addDays(payload.d, Math.max(nextState.intervalDays, 1));

  const data: SubmitResponse = {
    result: outcome.correct ? "correct" : "wrong",
    grade,
    explanation: buildExplanation({
      payload,
      outcome,
      grade,
      usedHint,
      timedOut,
      letterWithoutOptions,
    }),
    updates: {
      知识点: payload.k,
      归一化内容: payload.p,
      状态: nextState.state,
      间隔天数: nextState.intervalDays,
      // 难度因子必须回写，否则宿主会丢 ease
      难度因子: nextState.ease,
      连对次数: nextState.streak,
      答错次数: nextState.lapses,
      待练次数: nextState.need,
      下次复习: nextReview,
      // 用签名里的出题日期而不是服务器当前时间：重复提交才能得到同一组 updates
      最近暴露: payload.d,
    },
  };

  return { ok: true, data };
}
