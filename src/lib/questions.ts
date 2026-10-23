/**
 * 题面构造：确定性模板、纯函数、零网络、不调用大模型。
 *
 * 规则来源：docs/API_IMPLEMENTATION.md §4.3
 *
 * MVP 决策：题面由「掩码来源原句 / 释义提示」两种模板生成，LLM 润色默认关闭
 * （`READLOOP_QUESTION_LLM=1` 时才启用，见 docs/DECISIONS.md）。理由：
 * 出题只在每天早上批量发生一次，确定性模板失败面最小；判分与选题完全不依赖措辞。
 *
 * 关于可替换点：本文件不读环境变量、不联网，只暴露 `polisher` 钩子；
 * 是否启用 LLM 润色由编排层（review.ts / 路由）决定，MVP 不注入。
 *
 * 返回的 `answer` / `alt` 是内部字段，交给 review.ts 签名进 `question_id`，
 * **绝不放进对外响应**（对外只给 stem / options / context / hint）。
 */

import { LEECH_THRESHOLD } from "./scheduler";
import {
  assignQuestionTypes,
  mulberry32,
  shuffleWithRng,
  type DailySelection,
  type ReviewPoint,
} from "./selection";
import { normalizeAnswer, type QuestionType } from "./grading";

/** LLM 润色开关名（默认关闭）；本文件只声明约定，不读取环境变量 */
export const QUESTION_LLM_ENV = "READLOOP_QUESTION_LLM";

/** 掩码来源原句时使用的占位符 */
export const CLOZE_BLANK = "____";

export interface GeneratedQuestion {
  /** 来源知识点：review.ts 用它拼状态快照，不出现在对外响应里 */
  point: ReviewPoint;
  type: QuestionType;
  stem: string;
  /** 选择题的 4 个选项；填空题为空数组 */
  options: string[];
  /**
   * 来源原句语境。作答前恒为 `null`：未掩码原句会直接泄露答案，
   * 字段保留给「作答后展示原句」的宿主行为（规格口径）。
   */
  context: string | null;
  /** 难题提示（lapses ≥ 4 时给首字母 + 字母数），否则 null */
  hint: string | null;
  /** 正确答案（原文形式）——只在签名载荷里出现 */
  answer: string;
  /** 其它可接受答案（例如归一化前的写法） */
  alt: string[];
}

/**
 * LLM 润色钩子：接一个「输入模板题、返回润色题」的函数即可。
 * 返回 null 表示润色失败，自动回退模板题。
 */
export type QuestionPolisher = (question: GeneratedQuestion) => GeneratedQuestion | null;

export interface BuildQuestionsOptions {
  /** 干扰项候选池；默认只用本套题里的点（通常应传全量知识点） */
  pool?: readonly ReviewPoint[];
  /** 指定随机源；默认用选题种子派生，保证同样输入出同样题 */
  rng?: () => number;
  /** LLM 润色钩子，默认不注入 = 纯模板 */
  polisher?: QuestionPolisher;
}

// ============================================================
// 题面工具
// ============================================================

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 目标词在句子里的匹配模式：忽略大小写、允许词间任意空白。
 * 单词/短语两端有字母数字时加 `\b` 边界——避免把 `form` 从 `information`
 * 里挖出来造成 `in____ation` 这种破句（定位失败时退到释义提示）。
 */
function targetPattern(answer: string): RegExp {
  const parts = answer.trim().split(/\s+/).map(escapeRegExp);
  const body = parts.join("\\s+");
  const startsWord = /^[A-Za-z0-9]/.test(answer);
  const endsWord = /[A-Za-z0-9]$/.test(answer);
  return new RegExp(`${startsWord ? "\\b" : ""}${body}${endsWord ? "\\b" : ""}`, "gi");
}

function containsAnswer(sentence: string, answer: string): boolean {
  if (!answer.trim()) return false;
  return targetPattern(answer).test(sentence);
}

/**
 * 用 `____` 掩码来源原句里的目标词；找不到（或没有原句）返回 null。
 * 找到时替换所有出现，保证题面不漏答案。
 */
export function maskSourceSentence(point: ReviewPoint): string | null {
  const sentence = point.example?.trim();
  const answer = point.content.trim();
  if (!sentence || !answer) return null;
  if (!containsAnswer(sentence, answer)) return null;
  return sentence.replace(targetPattern(answer), CLOZE_BLANK);
}

/** 难题提示：首字母 + 字母数（不含空格与标点） */
export function buildHint(point: ReviewPoint): string | null {
  if (point.lapses < LEECH_THRESHOLD) return null;
  const letters = point.content.replace(/[^A-Za-z]/g, "");
  if (!letters) return null;
  const first = letters[0].toUpperCase();
  return `提示：首字母 ${first}，共 ${letters.length} 个字母（不含空格与标点）`;
}

/**
 * 其它可接受答案。
 * `归一化内容` 是去重用的规范化写法，若与知识点原文不同（例如少了句末标点），
 * 用户按任一种写法输入都算对；不猜复数（规则文档没有要求，猜错会误判）。
 */
export function buildAlternatives(point: ReviewPoint): string[] {
  const answer = point.content.trim();
  const normalizedId = point.id.trim();
  if (!normalizedId) return [];
  if (normalizeAnswer(normalizedId) === normalizeAnswer(answer)) return [];
  return [normalizedId];
}

/**
 * 干扰项候选：排除自己、排除与正确答案同形的点、按内容去重。
 * 优先同 `类型` 的其它知识点，不足再跨类型补齐（§4.3）。
 */
function collectDistractors(
  point: ReviewPoint,
  pool: readonly ReviewPoint[],
  typeFilter: (candidate: ReviewPoint) => boolean
): ReviewPoint[] {
  const answer = normalizeAnswer(point.content);
  const seen = new Set<string>([answer]);
  const result: ReviewPoint[] = [];
  for (const candidate of pool) {
    if (candidate.id === point.id) continue;
    if (!typeFilter(candidate)) continue;
    const key = normalizeAnswer(candidate.content);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

// ============================================================
// 单题构造
// ============================================================

function buildChoice(
  point: ReviewPoint,
  pool: readonly ReviewPoint[],
  rng: () => number
): GeneratedQuestion | null {
  const sameType = shuffleWithRng(
    collectDistractors(point, pool, (candidate) => candidate.type === point.type),
    rng
  );
  const crossType = shuffleWithRng(
    collectDistractors(point, pool, (candidate) => candidate.type !== point.type),
    rng
  );

  const picked: string[] = [];
  for (const candidate of [...sameType, ...crossType]) {
    if (picked.length >= 3) break;
    const content = candidate.content.trim();
    if (!content) continue;
    const key = normalizeAnswer(content);
    if (picked.some((value) => normalizeAnswer(value) === key)) continue;
    picked.push(content);
  }

  // 不足 3 个可用选项 → 这题只能出成填空题（§4.3）
  if (picked.length < 3) return null;

  const answer = point.content.trim();
  const options = shuffleWithRng([answer, ...picked], rng);
  const masked = maskSourceSentence(point);
  const meaning = point.meaning.trim();

  const stem =
    masked ?? (meaning ? `选出与「${meaning}」对应的英文：` : "选出正确的英文表达：");

  return {
    point,
    type: "choice",
    stem,
    options,
    // context 作答前一律不给：未掩码原句会直接把答案送到用户眼前（语境已由掩码后的 stem 承担）
    context: null,
    hint: buildHint(point),
    answer,
    alt: buildAlternatives(point),
  };
}

function buildCloze(point: ReviewPoint): GeneratedQuestion {
  const masked = maskSourceSentence(point);
  const meaning = point.meaning.trim();

  const stem =
    masked ??
    (meaning
      ? `中文：${meaning}\n请写出对应的英文：`
      : "请写出这个知识点的英文表达：");

  return {
    point,
    type: "cloze",
    stem,
    options: [],
    // context 作答前一律不给；字段保留给「作答后展示原句」的宿主行为（规格口径）
    context: null,
    hint: buildHint(point),
    answer: point.content.trim(),
    alt: buildAlternatives(point),
  };
}

// ============================================================
// 批量出题
// ============================================================

/**
 * 按选题结果批量出题。
 *
 * - 出题顺序 = `selection.order`（选题阶段已用种子打散）
 * - 题型严格交替，起点由同一颗种子决定；不足 3 个干扰项时强制 cloze
 * - 题面不含答案；答案与备选写法随题目结构返回，由调用方签进 question_id
 */
export function buildQuestions(
  selection: DailySelection,
  options: BuildQuestionsOptions = {}
): GeneratedQuestion[] {
  const pool = options.pool ?? selection.selected.map((item) => item.point);
  const rng = options.rng ?? mulberry32(selection.seed);

  const orderedPoints = selection.order
    .map((index) => selection.selected[index]?.point)
    .filter((point): point is ReviewPoint => Boolean(point));

  // 先按池子探测每题「能不能出选择题」，再统一分配题型，保证交替规则
  const canChoice = orderedPoints.map(
    (point) => collectDistractors(point, pool, () => true).length >= 3
  );
  const types = assignQuestionTypes(canChoice, rng);

  return orderedPoints.map((point, index) => {
    const template =
      types[index] === "choice" ? (buildChoice(point, pool, rng) ?? buildCloze(point)) : buildCloze(point);

    // MVP 不注入 polisher；这里保留钩子，接入 LLM 润色时失败自动回退模板
    if (options.polisher) {
      const polished = options.polisher(template);
      if (polished) return polished;
    }
    return template;
  });
}
