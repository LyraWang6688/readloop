/**
 * selection.ts / questions.ts 的自测脚本。
 * 运行：./node_modules/.bin/tsx scripts/selection-check.ts
 *
 * 覆盖：中文表字段归一化、日期三种写法、确定性随机、每日选题口径、
 * 题型交替/强制填空、掩码原句、选项构造、难题提示、题面不含答案。
 * 纯函数测试，不碰网络、不读环境变量。
 */

import {
  DAILY_SIZE,
  assignQuestionTypes,
  fnv1a,
  mulberry32,
  normalizeDateField,
  normalizePointRow,
  parsePoints,
  selectDailyPoints,
  selectionSeed,
  shuffleWithRng,
  type DailySelection,
  type ReviewPoint,
} from "../src/lib/selection";
import {
  buildHint,
  buildQuestions,
  maskSourceSentence,
  type GeneratedQuestion,
} from "../src/lib/questions";

let passed = 0;
let failed = 0;

function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    console.log(
      `  ❌ ${name}\n     期望 ${JSON.stringify(expected)}\n     实际 ${JSON.stringify(actual)}`
    );
  }
}

const DATE = "2026-10-23";

function makePoint(overrides: Partial<ReviewPoint> & { id: string }): ReviewPoint {
  const { id, ...rest } = overrides;
  return {
    id,
    content: id,
    type: "word",
    meaning: "释义",
    state: "new",
    intervalDays: 0,
    ease: 2.5,
    streak: 0,
    lapses: 0,
    need: 3,
    ...rest,
  };
}

function expectPoint(row: unknown, index = 0): ReviewPoint {
  const result = normalizePointRow(row, index);
  if (!result.ok) throw new Error(`fixture 不合法：${result.details}`);
  return result.point;
}

function ids(selection: DailySelection): string[] {
  return selection.selected.map((item) => item.point.id);
}

// ============================================================
// 【1】中文表字段 → 内部结构
// ============================================================
console.log("\n【1】输入归一化（中文表字段 → ReviewPoint）");

const fullPoint = expectPoint({
  知识点: "subsequent",
  归一化内容: "subsequent",
  类型: "word",
  释义: "随后的",
  解释: "形近词 subsequent / subsequence 易混",
  来源原句: "Subsequent studies confirmed the effect.",
  状态: "review",
  间隔天数: 3,
  难度因子: 2.5,
  连对次数: 1,
  答错次数: 0,
  待练次数: 2,
  下次复习: "2026-10-23",
  最近暴露: "2026-10-20",
  来源链接: "https://example.com/article",
});

check("归一化内容 → id", fullPoint.id, "subsequent");
check("知识点 → content", fullPoint.content, "subsequent");
check("类型 → type", fullPoint.type, "word");
check("释义 → meaning", fullPoint.meaning, "随后的");
check("解释 → explanation", fullPoint.explanation, "形近词 subsequent / subsequence 易混");
check("来源原句 → example", fullPoint.example, "Subsequent studies confirmed the effect.");
check("状态 → state", fullPoint.state, "review");
check("间隔天数 → intervalDays", fullPoint.intervalDays, 3);
check("难度因子 → ease", fullPoint.ease, 2.5);
check("连对次数 → streak", fullPoint.streak, 1);
check("答错次数 → lapses", fullPoint.lapses, 0);
check("待练次数 → need", fullPoint.need, 2);
check("下次复习 → nextReview", fullPoint.nextReview, "2026-10-23");
check("最近暴露 → lastSeen", fullPoint.lastSeen, "2026-10-20");
check("来源链接 → sourceUrl", fullPoint.sourceUrl, "https://example.com/article");

const defaults = expectPoint({ 归一化内容: "archive", 状态: "new" });
check("缺省数字用初始值", [
  defaults.intervalDays,
  defaults.ease,
  defaults.streak,
  defaults.lapses,
  defaults.need,
], [0, 2.5, 0, 0, 3]);

const numericStrings = expectPoint({
  归一化内容: "resilient",
  状态: "learning",
  间隔天数: "2",
  难度因子: "2.4",
  待练次数: "5",
});
check("数字字符串被接受", [
  numericStrings.intervalDays,
  numericStrings.ease,
  numericStrings.need,
], [2, 2.4, 5]);

const clamped = expectPoint({
  归一化内容: "bounded",
  状态: "new",
  难度因子: 9,
  待练次数: -3,
});
check("难度因子夹到 [1.3, 2.8]", clamped.ease, 2.8);
check("待练次数不为负", clamped.need, 0);

const unknownType = expectPoint({ 归一化内容: "odd", 状态: "new", 类型: "whatever" });
check("未知类型退成 word", unknownType.type, "word");

const onlyExampleColumn = expectPoint({ 归一化内容: "sentence", 状态: "new", 例句: "A sentence." });
check("只有例句字段时用例句", onlyExampleColumn.example, "A sentence.");

const badState = normalizePointRow({ 归一化内容: "x", 状态: "done" }, 1);
check("状态非法 → 失败", badState.ok, false);
check(
  "状态非法 → 指出第几条",
  badState.ok ? "" : badState.details.includes("第 2 条"),
  true
);

const missingId = normalizePointRow({ 状态: "new" }, 0);
check("缺归一化内容 → 失败", missingId.ok, false);

const badNumber = normalizePointRow(
  { 归一化内容: "x", 状态: "new", 间隔天数: "三天" },
  0
);
check("数字字段非法 → 失败", badNumber.ok, false);

console.log("\n【2】日期归一化（三种写法）");
check("YYYY-MM-DD 原样保留", normalizeDateField("2026-10-25"), "2026-10-25");
check(
  "ISO 8601 → 上海日期",
  normalizeDateField("2026-10-25T10:30:00+08:00"),
  "2026-10-25"
);
check(
  "UTC 晚间 → 上海已跨天",
  normalizeDateField("2026-10-24T20:00:00Z"),
  "2026-10-25"
);
check(
  "毫秒时间戳字符串 → 上海日期",
  normalizeDateField(String(Date.UTC(2026, 9, 24, 16, 0, 0))),
  "2026-10-25"
);
check("数字毫秒时间戳 → 上海日期", normalizeDateField(Date.UTC(2026, 9, 24, 16, 0, 0)), "2026-10-25");
check("空串 → undefined", normalizeDateField("  "), undefined);
check("乱写的日期 → undefined", normalizeDateField("昨天"), undefined);
check("秒级时间戳（不在契约内）→ undefined", normalizeDateField("1761223200"), undefined);

console.log("\n【3】parsePoints 整体校验");
const parsed = parsePoints([
  { 归一化内容: "a", 状态: "new" },
  { 归一化内容: "a", 状态: "review" },
  { 归一化内容: "b", 状态: "new" },
]);
const emptyParsed = parsePoints([]);
check("空/非数组 → POINTS_EMPTY", emptyParsed.ok, false);
check("空数组错误码", emptyParsed.ok ? "" : emptyParsed.code, "POINTS_EMPTY");
check("按归一化内容去重", parsed.ok ? parsed.points.map((point) => point.id) : [], ["a", "b"]);
check(
  "字段不合法 → POINTS_INVALID",
  (() => {
    const result = parsePoints([{ 归一化内容: "ok", 状态: "new" }, { 状态: "new" }]);
    return result.ok ? "" : result.code;
  })(),
  "POINTS_INVALID"
);

// ============================================================
// 【4】确定性随机
// ============================================================
console.log("\n【4】确定性随机（FNV-1a + mulberry32）");
check("FNV-1a 空串", fnv1a(""), 0x811c9dc5);
check("FNV-1a(abc) 标准值", fnv1a("abc"), 0x1a47e90b);
check(
  "种子与 id 顺序无关",
  selectionSeed(DATE, ["b", "a"]),
  selectionSeed(DATE, ["a", "b"])
);
check(
  "不同日期种子不同",
  selectionSeed(DATE, ["a"]) !== selectionSeed("2026-10-24", ["a"]),
  true
);
const rngA = mulberry32(123);
const rngB = mulberry32(123);
check("同一颗种子序列相同", [rngA(), rngA(), rngA()], [rngB(), rngB(), rngB()]);
check("随机值落在 [0,1)", mulberry32(7)() < 1, true);
check(
  "洗牌是排列且确定",
  (() => {
    const source = ["a", "b", "c", "d"];
    const one = shuffleWithRng(source, mulberry32(9));
    const two = shuffleWithRng(source, mulberry32(9));
    return [
      [...one].sort().join(",") === source.join(","),
      JSON.stringify(one) === JSON.stringify(two),
    ];
  })(),
  [true, true]
);

// ============================================================
// 【5】每日选题
// ============================================================
console.log("\n【5】每日选题口径");

const dueSortFixture = [
  makePoint({ id: "a", state: "review", nextReview: "2026-10-18", need: 1 }),
  makePoint({ id: "b", state: "review", nextReview: "2026-10-18", need: 8 }),
  makePoint({ id: "c", state: "relearning", nextReview: "2026-10-23", need: 3 }),
  makePoint({ id: "d", state: "review", nextReview: "2026-10-21", need: 1 }),
];
const dueSort = selectDailyPoints(dueSortFixture, DATE);
check(
  "到期排序：逾期 desc → need desc",
  ids(dueSort),
  ["b", "a", "d", "c"]
);
check("到期点数", dueSort.dueCount, 4);
check("本套题没有新点", dueSort.newCount, 0);

const tenDue = Array.from({ length: 10 }, (_, index) =>
  makePoint({
    id: `due-${index}`,
    state: "review",
    nextReview: "2026-10-22",
    need: index,
  })
);
const capped = selectDailyPoints(tenDue, DATE);
check("到期配额最多 5 题", capped.dueCount, 5);
check("总共最多 8 题", capped.selected.length, DAILY_SIZE);

const newFixture = [
  makePoint({ id: "n-old", state: "new", lastSeen: "2026-10-01" }),
  makePoint({ id: "n-new", state: "new", lastSeen: "2026-10-22" }),
  makePoint({ id: "n-mid", state: "new", lastSeen: "2026-10-10" }),
];
const newSel = selectDailyPoints(newFixture, DATE);
check("新点排序：最近暴露 desc", ids(newSel), ["n-new", "n-mid", "n-old"]);
check("新点配额最多 2 题", newSel.newCount, 2);

const mixedFixture = [
  makePoint({ id: "m-due-1", state: "review", nextReview: "2026-10-20", need: 2 }),
  makePoint({ id: "m-due-2", state: "relearning", nextReview: "2026-10-23", need: 1 }),
  makePoint({ id: "m-new-1", state: "new", lastSeen: "2026-10-22" }),
  makePoint({ id: "m-new-2", state: "new", lastSeen: "2026-10-21" }),
  makePoint({ id: "m-fill-1", state: "learning", need: 7 }),
  makePoint({ id: "m-fill-2", state: "learning", need: 5 }),
  makePoint({ id: "m-fill-3", state: "learning", need: 3 }),
  makePoint({ id: "m-fill-4", state: "learning", need: 1 }),
];
const mixed = selectDailyPoints(mixedFixture, DATE);
check("混合池：到期 2 + 新点 2 + 补位 4", [
  mixed.dueCount,
  mixed.newCount,
  mixed.selected.filter((item) => item.bucket === "fill").length,
], [2, 2, 4]);
check(
  "补位按 need desc",
  mixed.selected
    .filter((item) => item.bucket === "fill")
    .map((item) => item.point.id),
  ["m-fill-1", "m-fill-2", "m-fill-3", "m-fill-4"]
);

const masteredFixture = [
  makePoint({ id: "gone-1", state: "mastered", nextReview: "2026-10-01" }),
  makePoint({ id: "gone-2", state: "mastered" }),
];
const mastered = selectDailyPoints(masteredFixture, DATE);
check("全部归档 → 空题包", [mastered.selected.length, mastered.newCount, mastered.dueCount], [0, 0, 0]);
check("全部归档 → 没有 weak_points", mastered.weakPoints, []);

const empty = selectDailyPoints([], DATE);
check("空库也不报错", [empty.selected.length, empty.order.length], [0, 0]);

const smallFixture = [
  makePoint({ id: "only-1", state: "review", nextReview: "2026-10-22" }),
  makePoint({ id: "only-2", state: "learning", need: 5 }),
  makePoint({ id: "only-3", state: "new" }),
];
const small = selectDailyPoints(smallFixture, DATE);
check("不足 8 题时只出有的题", small.selected.length, 3);

const weakFixture = [
  makePoint({ id: "weak-x", state: "review", nextReview: DATE, lapses: 3, need: 1 }),
  makePoint({ id: "weak-y", state: "review", nextReview: DATE, lapses: 2, need: 8 }),
  makePoint({ id: "weak-z", state: "review", nextReview: DATE, lapses: 2, need: 1 }),
];
const weak = selectDailyPoints(weakFixture, DATE);
check("weak_points 取 lapses desc → need desc 前 2", weak.weakPoints, ["weak-x", "weak-y"]);

const deterministicA = selectDailyPoints(mixedFixture, DATE);
const deterministicB = selectDailyPoints(mixedFixture, DATE);
check("同样输入 → 同一套题", JSON.stringify(deterministicA), JSON.stringify(deterministicB));
check("variant = seed % 5", deterministicA.variant, deterministicA.seed % 5);
check("variant 在 0–4", deterministicA.variant >= 0 && deterministicA.variant < 5, true);
check(
  "order 是 selected 的排列",
  [...deterministicA.order].sort((a, b) => a - b),
  deterministicA.selected.map((_, index) => index)
);

const frozen = JSON.stringify(mixedFixture);
selectDailyPoints(mixedFixture, DATE);
check("选题不修改入参", JSON.stringify(mixedFixture), frozen);

// ============================================================
// 【6】题型分配
// ============================================================
console.log("\n【6】题型分配（严格交替 + 强制填空）");
check(
  "起点 choice → 交替",
  assignQuestionTypes([true, true, true, true], () => 0.1),
  ["choice", "cloze", "choice", "cloze"]
);
check(
  "起点 cloze → 交替",
  assignQuestionTypes([true, true, true, true], () => 0.9),
  ["cloze", "choice", "cloze", "choice"]
);
check(
  "没有干扰项的点强制 cloze",
  assignQuestionTypes([false], () => 0.1),
  ["cloze"]
);
check(
  "混排时只有不足选项的那题被降级",
  assignQuestionTypes([true, false], () => 0.1),
  ["choice", "cloze"]
);

// ============================================================
// 【7】题面构造
// ============================================================
console.log("\n【7】题面构造（掩码 / 选项 / 提示）");

const maskSource = makePoint({
  id: "subsequent",
  content: "subsequent",
  example: "Subsequent studies confirmed the effect.",
});
check(
  "掩码原句（忽略大小写）",
  maskSourceSentence(maskSource),
  "____ studies confirmed the effect."
);

const maskAbsent = makePoint({
  id: "receive",
  content: "receive",
  example: "Please accept the package.",
});
check("目标词不在句中 → 无法掩码", maskSourceSentence(maskAbsent), null);

const maskSubstring = makePoint({
  id: "form",
  content: "form",
  example: "The information is useful.",
});
check("不能从单词内部挖词（form / information）", maskSourceSentence(maskSubstring), null);

check(
  "lapses < 4 无提示",
  buildHint(makePoint({ id: "easy", content: "receive", lapses: 3 })),
  null
);
check(
  "lapses ≥ 4 给首字母 + 字母数",
  buildHint(makePoint({ id: "leech", content: "receive", lapses: 4 }))?.includes(
    "首字母 R，共 7 个字母"
  ),
  true
);

const questionPool: ReviewPoint[] = [
  makePoint({
    id: "subsequent",
    content: "subsequent",
    meaning: "随后的",
    example: "Subsequent studies confirmed the effect.",
    state: "review",
    nextReview: DATE,
    lapses: 4,
  }),
  makePoint({
    id: "accommodate",
    content: "accommodate",
    meaning: "容纳",
    example: "The hall can accommodate 500 people.",
    state: "review",
    nextReview: DATE,
  }),
  makePoint({
    id: "inevitable",
    content: "inevitable",
    meaning: "不可避免的",
    example: "War seemed inevitable.",
    state: "review",
    nextReview: DATE,
  }),
  makePoint({
    id: "the percentage of",
    content: "the percentage of",
    type: "phrase",
    meaning: "……的比例",
    example: "The percentage of students studying abroad is increasing.",
    state: "review",
    nextReview: DATE,
  }),
  makePoint({
    id: "look forward to",
    content: "look forward to",
    type: "phrase",
    meaning: "期待",
    example: "I look forward to hearing from you.",
    state: "review",
    nextReview: DATE,
  }),
  makePoint({
    id: "maintain",
    content: "maintain",
    meaning: "维持",
    example: "It is hard to maintain this pace.",
    state: "review",
    nextReview: DATE,
  }),
  makePoint({
    id: "consequence",
    content: "consequence",
    meaning: "后果",
    example: "Every action has a consequence.",
    state: "review",
    nextReview: DATE,
  }),
  makePoint({
    id: "resilient",
    content: "resilient",
    meaning: "有韧性的",
    example: "She stayed resilient after the setback.",
    state: "review",
    nextReview: DATE,
  }),
];

const questionSelection = selectDailyPoints(questionPool, DATE);
const questions = buildQuestions(questionSelection, { pool: questionPool });
check("题数与选题一致", questions.length, questionSelection.selected.length);
check(
  "题型严格交替",
  questions.every((question, index) => index === 0 || question.type !== questions[index - 1].type),
  true
);
check(
  "两类题型各占一半",
  [
    questions.filter((question) => question.type === "choice").length,
    questions.filter((question) => question.type === "cloze").length,
  ],
  [4, 4]
);
check(
  "选择题 4 个不重复选项且含正确答案",
  questions
    .filter((question) => question.type === "choice")
    .every(
      (question) =>
        question.options.length === 4 &&
        new Set(question.options).size === 4 &&
        question.options.includes(question.answer)
    ),
  true
);
check(
  "填空题不给选项",
  questions
    .filter((question) => question.type === "cloze")
    .every((question) => question.options.length === 0),
  true
);
check(
  "题面不含正确答案",
  questions.every(
    (question) => !question.stem.toLowerCase().includes(question.answer.toLowerCase())
  ),
  true
);
check(
  "context 恒为 null（作答前不返回未掩码原句）",
  questions.every((question) => question.context === null),
  true
);
check(
  "题面与 context 都不含答案原文",
  questions.every(
    (question) =>
      !question.stem.toLowerCase().includes(question.answer.toLowerCase()) &&
      (question.context === null ||
        !question.context.toLowerCase().includes(question.answer.toLowerCase()))
  ),
  true
);
check(
  "难题给提示、普通题不给",
  questions
    .filter((question) => question.point.id === "subsequent")
    .every((question) => question.hint?.includes("首字母") === true) &&
    questions
      .filter((question) => question.point.id !== "subsequent")
      .every((question) => question.hint === null),
  true
);
check(
  "同样输入 → 同样题目",
  JSON.stringify(buildQuestions(questionSelection, { pool: questionPool })),
  JSON.stringify(questions)
);
check(
  "选择题正确答案位置不固定",
  new Set(
    questions
      .filter((question) => question.type === "choice")
      .map((question) => question.options.indexOf(question.answer))
  ).size >= 2,
  true
);
check(
  "内部结构保留 answer（交给 review.ts 签名）",
  questions.every((question) => question.answer === question.point.content),
  true
);

console.log("\n【8】无原句 / 无干扰项时的题面");
const fallbackPoint = makePoint({ id: "fallback", content: "fallback", meaning: "随后的" });
const fallbackSelection: DailySelection = {
  date: DATE,
  seed: 1,
  variant: 1,
  selected: [{ point: fallbackPoint, bucket: "due" }],
  order: [0],
  newCount: 0,
  dueCount: 1,
  weakPoints: [],
};

const clozeFallback: GeneratedQuestion = buildQuestions(fallbackSelection, {
  pool: questionPool,
  rng: () => 0.9,
})[0];
check(
  "无原句的填空题用释义提示",
  clozeFallback.stem,
  "中文：随后的\n请写出对应的英文："
);
check("无原句时 context 也是 null", clozeFallback.context, null);

const choiceFallback: GeneratedQuestion = buildQuestions(fallbackSelection, {
  pool: questionPool,
  rng: () => 0.1,
})[0];
check(
  "无原句的选择题用释义提示",
  choiceFallback.stem,
  "选出与「随后的」对应的英文："
);
check("选择题内部带 4 个选项", choiceFallback.options.length, 4);

const noDistractor = buildQuestions(fallbackSelection, { pool: [fallbackPoint], rng: () => 0.1 })[0];
check("干扰项不足 3 个 → 强制填空", noDistractor.type, "cloze");

console.log(`\n结果：${passed} 通过，${failed} 失败`);
if (failed > 0) {
  console.log("❌ 有断言失败");
  process.exit(1);
}
console.log(`✅ ${passed} 项断言通过`);
