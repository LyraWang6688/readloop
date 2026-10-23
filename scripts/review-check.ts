/**
 * review.ts 编排（today / submit）的自测脚本。
 * 运行：./node_modules/.bin/tsx scripts/review-check.ts
 *
 * 覆盖：today 的入参校验与题包结构、真签名 question_id 往返、
 * 判分（对/错/用提示/拼写容错/超时/字母映射）、updates 字段与下次复习日期、
 * 过期与篡改题目拒绝、幂等重放。
 * 全程用假密钥，不碰网络、不读环境变量。
 */

import { addDays, todayInShanghai } from "../src/lib/date";
import {
  ELAPSED_HARD_THRESHOLD_MS,
  orchestrateSubmit,
  orchestrateToday,
} from "../src/lib/review";
import {
  decodeQuestionId,
  signQuestionId,
  type QuestionPayload,
} from "../src/lib/token";

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

const SECRET = "test-question-secret";
/** 上海时间 2026-10-23 11:00 */
const NOW = Date.UTC(2026, 9, 23, 3, 0, 0);
const DATE = "2026-10-23";
const MODEL = {
  provider: "deepseek",
  base_url: "https://api.deepseek.com/v1",
  model: "deepseek-chat",
  api_key: "sk-test-0000",
};

/** 作答前快照：复习中、间隔 3 天、难度因子 2.5 */
const SNAPSHOT_REVIEW = { st: "review", iv: 3, ea: 2.5, sk: 1, lp: 0, nd: 2 };
/** 作答前快照：新点 */
const SNAPSHOT_NEW = { st: "new", iv: 0, ea: 2.5, sk: 0, lp: 0, nd: 3 };

type PayloadInput = Omit<QuestionPayload, "v" | "exp">;

function makePayload(overrides: Partial<PayloadInput> = {}): PayloadInput {
  return {
    d: DATE,
    k: "receive",
    p: "receive",
    t: "cloze",
    a: "receive",
    alt: [],
    m: "收到",
    e: "形近词 receive / recieve 易混",
    src: "https://example.com/article",
    s: { ...SNAPSHOT_NEW },
    ...overrides,
  };
}

function sign(overrides: Partial<PayloadInput> = {}): string {
  return signQuestionId(makePayload(overrides), SECRET);
}

function submit(body: Record<string, unknown>) {
  return orchestrateSubmit({ date: DATE, ...body }, SECRET, NOW);
}

function submitData(body: Record<string, unknown>) {
  const result = submit(body);
  return result.ok ? result.data : null;
}

// 今日题包用的知识点：直接按飞书表的「中文表字段」写，走 today 的真实入参校验。
// 5 个到期 + 3 个新点（新点配额 2，剩 1 个补位）
const POINTS: Array<Record<string, unknown>> = [
  {
    知识点: "subsequent",
    归一化内容: "subsequent",
    类型: "word",
    释义: "随后的",
    来源原句: "Subsequent studies confirmed the effect.",
    状态: "review",
    间隔天数: 3,
    难度因子: 2.5,
    连对次数: 1,
    答错次数: 0,
    待练次数: 2,
    下次复习: "2026-10-21",
  },
  {
    知识点: "the percentage of",
    归一化内容: "the percentage of",
    类型: "phrase",
    释义: "……的比例",
    来源原句: "The percentage of students studying abroad is increasing.",
    状态: "review",
    间隔天数: 10,
    难度因子: 2.4,
    连对次数: 2,
    答错次数: 0,
    待练次数: 1,
    下次复习: DATE,
  },
  {
    知识点: "accommodate",
    归一化内容: "accommodate",
    类型: "word",
    释义: "容纳",
    来源原句: "The hall can accommodate 500 people.",
    状态: "review",
    间隔天数: 4,
    难度因子: 2.3,
    连对次数: 1,
    答错次数: 2,
    待练次数: 3,
    下次复习: "2026-10-20",
  },
  {
    知识点: "inevitable",
    归一化内容: "inevitable",
    类型: "word",
    释义: "不可避免的",
    来源原句: "War seemed inevitable.",
    状态: "review",
    间隔天数: 6,
    难度因子: 2.6,
    连对次数: 2,
    答错次数: 1,
    待练次数: 2,
    下次复习: "2026-10-19",
  },
  {
    知识点: "receive",
    归一化内容: "receive",
    类型: "word",
    释义: "收到",
    来源原句: "Please receive the package.",
    状态: "review",
    间隔天数: 2,
    难度因子: 2.5,
    连对次数: 0,
    答错次数: 4,
    待练次数: 4,
    下次复习: "2026-10-22",
  },
  {
    知识点: "maintain",
    归一化内容: "maintain",
    类型: "word",
    释义: "维持",
    来源原句: "It is hard to maintain this pace.",
    状态: "new",
    最近暴露: "2026-10-22",
    下次复习: DATE,
  },
  {
    知识点: "consequence",
    归一化内容: "consequence",
    类型: "word",
    释义: "后果",
    来源原句: "Every action has a consequence.",
    状态: "new",
    最近暴露: "2026-10-21",
    下次复习: DATE,
  },
  {
    知识点: "look forward to",
    归一化内容: "look forward to",
    类型: "phrase",
    释义: "期待",
    来源原句: "I look forward to hearing from you.",
    状态: "new",
    最近暴露: "2026-10-20",
    下次复习: DATE,
  },
];

// ============================================================
// 【1】today：入参校验与题包
// ============================================================
console.log("\n【1】today：题包结构与会话上下文");

const todayBody = { date: DATE, model: MODEL, points: POINTS };
const todayResult = orchestrateToday(todayBody, SECRET, NOW);
check("today 成功", todayResult.ok, true);
if (!todayResult.ok) throw new Error(todayResult.message);
const today = todayResult.data;

check("date = 请求日期", today.date, DATE);
check("total = 8", today.total, 8);
check("answered 恒为 0", today.answered, 0);
check("variant 在 0–4", today.variant >= 0 && today.variant < 5, true);
check("due_count = 5", today.session_context.due_count, 5);
check("new_count = 2", today.session_context.new_count, 2);
check("weak_points 取 lapses desc 前 2", today.session_context.weak_points, [
  "receive",
  "accommodate",
]);

const decoded = today.questions.map((question) =>
  decodeQuestionId(question.question_id, SECRET, NOW)
);
check("question_id 全部可验签", decoded.every((item) => item.ok), true);
check(
  "question_id 里的出题日期正确",
  decoded.every((item) => item.ok && item.payload.d === DATE),
  true
);
check(
  "question_id 长度控制在 1KB 载荷量级",
  today.questions.every((question) => question.question_id.length < 1200),
  true
);

const payloads = decoded.map((item) => (item.ok ? item.payload : null));
check(
  "对外题面不含 answer 字段",
  today.questions.every((question) => !("answer" in question)),
  true
);
check(
  "两类题型各 4 题",
  [
    today.questions.filter((question) => question.type === "choice").length,
    today.questions.filter((question) => question.type === "cloze").length,
  ],
  [4, 4]
);
check(
  "选择题给 4 个选项且与签名一致",
  today.questions
    .map((question, index) => ({ question, payload: payloads[index] }))
    .filter((item) => item.question.type === "choice")
    .every(
      (item) =>
        item.payload?.o?.length === 4 &&
        item.question.options?.length === 4 &&
        JSON.stringify(item.question.options) === JSON.stringify(item.payload.o)
    ),
  true
);
check(
  "填空题不给选项",
  today.questions
    .filter((question) => question.type === "cloze")
    .every((question) => question.options === undefined),
  true
);
check(
  "题面不含正确答案（掩码/释义提示）",
  today.questions.every((question, index) => {
    const payload = payloads[index];
    return Boolean(payload) && !question.stem.toLowerCase().includes(payload!.a.toLowerCase());
  }),
  true
);
check(
  "today 的 context 恒为 null（作答前不返回未掩码原句）",
  today.questions.every((question) => question.context === null),
  true
);
check(
  "题面与 context 都不含答案原文",
  today.questions.every((question, index) => {
    const answer = payloads[index]?.a.toLowerCase() ?? "";
    if (!answer) return false;
    const stemLeaks = question.stem.toLowerCase().includes(answer);
    const contextLeaks =
      question.context !== null && question.context.toLowerCase().includes(answer);
    return !stemLeaks && !contextLeaks;
  }),
  true
);
check(
  "难题（lapses ≥ 4）给提示",
  today.questions.filter((question) => question.hint !== null).length === 1 &&
    today.questions.find((question) => question.hint !== null)?.hint?.includes("首字母") ===
      true,
  true
);

// ============================================================
// 【2】submit：真签名 question_id 的往返
// ============================================================
console.log("\n【2】submit：用今日题包真实提交");

const choiceIndex = payloads.findIndex(
  (payload) => payload?.t === "choice"
);
const choicePayload = choiceIndex >= 0 ? payloads[choiceIndex] : null;
const choiceQuestion = today.questions[choiceIndex];
check("题包里能找到选择题", choicePayload !== null, true);

if (choicePayload && choiceQuestion) {
  const options = choicePayload.o ?? [];
  const correctIndex = options.indexOf(choicePayload.a);
  const letter = String.fromCharCode("A".charCodeAt(0) + correctIndex);

  const byLetter = submit({
    question_id: choiceQuestion.question_id,
    answer: letter,
    used_hint: false,
    elapsed_ms: 5000,
  });
  const byText = submit({
    question_id: choiceQuestion.question_id,
    answer: choicePayload.a,
    used_hint: false,
    elapsed_ms: 5000,
  });

  check("选择题传字母 → correct", byLetter.ok ? byLetter.data.result : null, "correct");
  check("选择题传字母 → good", byLetter.ok ? byLetter.data.grade : null, "good");
  check(
    "字母与选项原文结果完全一致",
    JSON.stringify(byLetter.ok ? byLetter.data : null),
    JSON.stringify(byText.ok ? byText.data : null)
  );

  if (byLetter.ok) {
    const updates = byLetter.data.updates;
    check("updates 含难度因子", typeof updates.难度因子, "number");
    check("updates 最近暴露 = 出题日", updates.最近暴露, DATE);
    check(
      "下次复习 = 出题日 + max(间隔,1)",
      updates.下次复习,
      addDays(DATE, Math.max(updates.间隔天数, 1))
    );
    check(
      "updates 必含 10 个回写字段",
      [
        "知识点",
        "归一化内容",
        "状态",
        "间隔天数",
        "难度因子",
        "连对次数",
        "答错次数",
        "待练次数",
        "下次复习",
        "最近暴露",
      ].every((key) => key in updates),
      true
    );
    check("知识点回写原文", updates.知识点, choicePayload.k);
    check("归一化内容回写", updates.归一化内容, choicePayload.p);
    check(
      "explanation 含正确答案",
      byLetter.data.explanation.includes(`正确答案：${choicePayload.k}`),
      true
    );
  }
}

// ============================================================
// 【3】判分：对 / 错 / 提示 / 容错 / 超时
// ============================================================
console.log("\n【3】判分与档位");

const choiceCorrect = submitData({
  question_id: sign({
    t: "choice",
    k: "subsequent",
    p: "subsequent",
    a: "subsequent",
    o: ["study", "subsequent", "studied", "subsequently"],
    s: { ...SNAPSHOT_REVIEW },
  }),
  answer: "subsequent",
  used_hint: false,
  elapsed_ms: 5000,
});
check("选择题答对 → correct", choiceCorrect?.result, "correct");
check("选择题答对 → good", choiceCorrect?.grade, "good");
check("选择题答对 → 状态 review", choiceCorrect?.updates.状态, "review");
check("间隔 3 天 × ease 2.5 → 8 天", choiceCorrect?.updates.间隔天数, 8);
check("难度因子保持 2.5", choiceCorrect?.updates.难度因子, 2.5);
check("连对次数 +1", choiceCorrect?.updates.连对次数, 2);
check("待练次数 -1", choiceCorrect?.updates.待练次数, 1);
check("下次复习 = 10-31", choiceCorrect?.updates.下次复习, "2026-10-31");
check("答错次数不变", choiceCorrect?.updates.答错次数, 0);

const choiceLetter = submitData({
  question_id: sign({
    t: "choice",
    k: "subsequent",
    p: "subsequent",
    a: "subsequent",
    o: ["study", "subsequent", "studied", "subsequently"],
    s: { ...SNAPSHOT_REVIEW },
  }),
  answer: "B",
  used_hint: false,
  elapsed_ms: 5000,
});
check("字母 B 映射到选项原文并判对", choiceLetter?.result, "correct");
check("字母 B 的 updates 与原文一致", JSON.stringify(choiceLetter?.updates), JSON.stringify(choiceCorrect?.updates));

const choiceWrong = submitData({
  question_id: sign({
    t: "choice",
    k: "subsequent",
    p: "subsequent",
    a: "subsequent",
    o: ["study", "subsequent", "studied", "subsequently"],
    s: { ...SNAPSHOT_REVIEW },
  }),
  answer: "A",
  used_hint: false,
  elapsed_ms: 5000,
});
check("选择题答错 → wrong", choiceWrong?.result, "wrong");
check("选择题答错 → again", choiceWrong?.grade, "again");
check("复习中答错 → relearning", choiceWrong?.updates.状态, "relearning");
check("答错间隔归 0", choiceWrong?.updates.间隔天数, 0);
check("难度因子 -0.2", choiceWrong?.updates.难度因子, 2.3);
check("答错次数 +1", choiceWrong?.updates.答错次数, 1);
check("连对次数归 0", choiceWrong?.updates.连对次数, 0);
check("待练次数 +1", choiceWrong?.updates.待练次数, 3);
check("答错次日必出", choiceWrong?.updates.下次复习, "2026-10-24");

const letterWithoutOptions = submit({
  question_id: sign({
    t: "choice",
    k: "subsequent",
    p: "subsequent",
    a: "subsequent",
    s: { ...SNAPSHOT_REVIEW },
  }),
  answer: "B",
  used_hint: false,
  elapsed_ms: 3000,
});
check("无选项时传字母 → 判错", letterWithoutOptions.ok ? letterWithoutOptions.data.result : null, "wrong");
check(
  "无选项时传字母 → explanation 提示提交原文",
  letterWithoutOptions.ok
    ? letterWithoutOptions.data.explanation.includes("请提交选项原文")
    : false,
  true
);

const clozeLetter = submit({
  question_id: sign({ t: "cloze", s: { ...SNAPSHOT_NEW } }),
  answer: "B",
  used_hint: false,
  elapsed_ms: 3000,
});
check("填空题误传字母 → 判错", clozeLetter.ok ? clozeLetter.data.result : null, "wrong");
check(
  "填空题误传字母 → explanation 提醒写原文",
  clozeLetter.ok ? clozeLetter.data.explanation.includes("请填写答案原文") : false,
  true
);

const clozeCorrect = submitData({
  question_id: sign({ t: "cloze", s: { ...SNAPSHOT_NEW } }),
  answer: "receive",
  used_hint: false,
  elapsed_ms: 6000,
});
check("填空题答对 → easy（生成式）", clozeCorrect?.grade, "easy");
check("新点首次答对 → 间隔 4 天", clozeCorrect?.updates.间隔天数, 4);
check("难度因子 +0.15", clozeCorrect?.updates.难度因子, 2.65);
check("状态 → review", clozeCorrect?.updates.状态, "review");
check("下次复习 = 10-27", clozeCorrect?.updates.下次复习, "2026-10-27");

const clozeTypo = submitData({
  question_id: sign({ t: "cloze", s: { ...SNAPSHOT_NEW } }),
  answer: "recieve",
  used_hint: false,
  elapsed_ms: 6000,
});
check("拼写容错通过 → correct", clozeTypo?.result, "correct");
check("拼写容错 → hard", clozeTypo?.grade, "hard");
check("hard 间隔 1 天", clozeTypo?.updates.间隔天数, 1);
check("hard 难度因子 -0.15", clozeTypo?.updates.难度因子, 2.35);

const shortWordTypo = submitData({
  question_id: sign({ t: "cloze", k: "form", p: "form", a: "form", s: { ...SNAPSHOT_NEW } }),
  answer: "from",
  used_hint: false,
  elapsed_ms: 4000,
});
check("4 字母短词不容错（form/from）", shortWordTypo?.result, "wrong");

const hintHard = submitData({
  question_id: sign({
    t: "choice",
    k: "subsequent",
    p: "subsequent",
    a: "subsequent",
    o: ["study", "subsequent", "studied", "subsequently"],
    s: { ...SNAPSHOT_REVIEW },
  }),
  answer: "subsequent",
  used_hint: true,
  elapsed_ms: 5000,
});
check("用提示答对 → hard", hintHard?.grade, "hard");
check("hard 间隔 3×1.2 → 4 天", hintHard?.updates.间隔天数, 4);
check("hard 难度因子 -0.15", hintHard?.updates.难度因子, 2.35);
check("hard 下次复习 = 10-27", hintHard?.updates.下次复习, "2026-10-27");

const timeoutHard = submitData({
  question_id: sign({
    t: "choice",
    k: "subsequent",
    p: "subsequent",
    a: "subsequent",
    o: ["study", "subsequent", "studied", "subsequently"],
    s: { ...SNAPSHOT_REVIEW },
  }),
  answer: "subsequent",
  used_hint: false,
  elapsed_ms: ELAPSED_HARD_THRESHOLD_MS + 1,
});
check("超时答对 → hard", timeoutHard?.grade, "hard");
check("恰好 90 秒不算超时", submitData({
  question_id: sign({
    t: "choice",
    k: "subsequent",
    p: "subsequent",
    a: "subsequent",
    o: ["study", "subsequent", "studied", "subsequently"],
    s: { ...SNAPSHOT_REVIEW },
  }),
  answer: "subsequent",
  used_hint: false,
  elapsed_ms: ELAPSED_HARD_THRESHOLD_MS,
})?.grade, "good");
check("elapsed_ms 传数字字符串也接受", submitData({
  question_id: sign({
    t: "choice",
    k: "subsequent",
    p: "subsequent",
    a: "subsequent",
    o: ["study", "subsequent", "studied", "subsequently"],
    s: { ...SNAPSHOT_REVIEW },
  }),
  answer: "subsequent",
  used_hint: false,
  elapsed_ms: String(ELAPSED_HARD_THRESHOLD_MS + 1),
})?.grade, "hard");

// ============================================================
// 【4】幂等与非法输入
// ============================================================
console.log("\n【4】幂等与非法输入");

const idempotentQuestionId = sign({
  t: "cloze",
  s: { ...SNAPSHOT_NEW },
});
const firstSubmit = submitData({
  question_id: idempotentQuestionId,
  answer: "receive",
  used_hint: false,
  elapsed_ms: 5000,
});
const secondSubmit = submitData({
  question_id: idempotentQuestionId,
  answer: "receive",
  used_hint: false,
  elapsed_ms: 5000,
});
check("重复提交返回同一组 updates", JSON.stringify(secondSubmit), JSON.stringify(firstSubmit));

const expired = orchestrateSubmit(
  { date: DATE, question_id: sign({ d: "2025-01-01" }), answer: "receive" },
  SECRET,
  NOW
);
check("过期题目 → 400", expired.ok ? 0 : expired.status, 400);
check("过期题目 → QUESTION_INVALID", expired.ok ? "" : expired.code, "QUESTION_INVALID");
check(
  "过期题目错误信息可读",
  expired.ok ? "" : expired.message.includes("已过期"),
  true
);

const tampered = orchestrateSubmit(
  { date: DATE, question_id: `${idempotentQuestionId}x`, answer: "receive" },
  SECRET,
  NOW
);
check("篡改签名 → QUESTION_INVALID", tampered.ok ? "" : tampered.code, "QUESTION_INVALID");

const missingQuestionId = submit({ answer: "receive" });
check(
  "缺 question_id → QUESTION_INVALID",
  missingQuestionId.ok ? "" : missingQuestionId.code,
  "QUESTION_INVALID"
);

check("answer 不是字符串 → 400", submit({ question_id: idempotentQuestionId, answer: 42 }).ok, false);
check(
  "used_hint 不是布尔 → 400",
  (() => {
    const result = submit({
      question_id: idempotentQuestionId,
      answer: "receive",
      used_hint: "yes",
    });
    return result.ok ? "" : result.code;
  })(),
  "INVALID_PARAMS"
);
check(
  "elapsed_ms 为负 → 400",
  (() => {
    const result = submit({
      question_id: idempotentQuestionId,
      answer: "receive",
      elapsed_ms: -1,
    });
    return result.ok ? "" : result.code;
  })(),
  "INVALID_PARAMS"
);
check(
  "submit 的 date 非法 → 400",
  (() => {
    const result = orchestrateSubmit(
      { date: "2026-13-01", question_id: idempotentQuestionId, answer: "receive" },
      SECRET,
      NOW
    );
    return result.ok ? "" : result.code;
  })(),
  "INVALID_PARAMS"
);

// ============================================================
// 【5】today 的边界与错误码
// ============================================================
console.log("\n【5】today 边界与错误码");

const defaultDate = orchestrateToday({ model: MODEL, points: POINTS }, SECRET, NOW);
check("缺省 date 用上海今天", defaultDate.ok ? defaultDate.data.date : "", todayInShanghai(NOW));

const badModel = orchestrateToday(
  {
    date: DATE,
    model: { base_url: "http://api.deepseek.com/v1", model: "deepseek-chat", api_key: "sk-x" },
    points: POINTS,
  },
  SECRET,
  NOW
);
check("model 不是 https → MODEL_CONFIG_INVALID", badModel.ok ? "" : badModel.code, "MODEL_CONFIG_INVALID");
check("model 错误 → 400", badModel.ok ? 0 : badModel.status, 400);

const emptyPoints = orchestrateToday({ date: DATE, model: MODEL, points: [] }, SECRET, NOW);
check("points 为空 → POINTS_EMPTY", emptyPoints.ok ? "" : emptyPoints.code, "POINTS_EMPTY");
check("points 为空 → 422", emptyPoints.ok ? 0 : emptyPoints.status, 422);

const invalidPoints = orchestrateToday(
  {
    date: DATE,
    model: MODEL,
    points: [{ 归一化内容: "ok", 状态: "new" }, { 归一化内容: "bad", 状态: "done" }],
  },
  SECRET,
  NOW
);
check("points 字段非法 → POINTS_INVALID", invalidPoints.ok ? "" : invalidPoints.code, "POINTS_INVALID");
check(
  "错误 details 指出第几条",
  invalidPoints.ok ? false : invalidPoints.details?.includes("第 2 条") === true,
  true
);

const badDate = orchestrateToday({ date: "2026-02-30", model: MODEL, points: POINTS }, SECRET, NOW);
check("非法 date → INVALID_PARAMS", badDate.ok ? "" : badDate.code, "INVALID_PARAMS");

const masteredOnly = orchestrateToday(
  { date: DATE, model: MODEL, points: [{ 归一化内容: "old", 状态: "mastered" }] },
  SECRET,
  NOW
);
check(
  "全部归档 → 空题包 + 零上下文",
  masteredOnly.ok
    ? [
        masteredOnly.data.total,
        masteredOnly.data.session_context.new_count,
        masteredOnly.data.session_context.due_count,
        masteredOnly.data.session_context.weak_points.length,
      ]
    : null,
  [0, 0, 0, 0]
);

const notObject = orchestrateToday("nope", SECRET, NOW);
check("请求体不是对象 → INVALID_PARAMS", notObject.ok ? "" : notObject.code, "INVALID_PARAMS");

// ============================================================
// 汇总
// ============================================================
// ============================================================
// 【6】今日难度：performance → adaptDifficulty → 新点配额
// ============================================================
console.log("\n【6】今日难度（performance → difficulty）");

const noPerformance = orchestrateToday({ date: DATE, model: MODEL, points: POINTS }, SECRET, NOW);
check("不传 performance → steady", noPerformance.ok ? noPerformance.data.difficulty.level : "", "steady");
check("不传 performance → 默认新点配额 2", noPerformance.ok ? noPerformance.data.difficulty.newQuota : 0, 2);
check(
  "不传 performance → 理由说明样本不足",
  noPerformance.ok ? noPerformance.data.difficulty.reason.includes("样本不足") : false,
  true
);

const harderToday = orchestrateToday(
  { date: DATE, model: MODEL, points: POINTS, performance: { attempts: 20, correct: 19 } },
  SECRET,
  NOW
);
check("最近 19/20 → harder", harderToday.ok ? harderToday.data.difficulty.level : "", "harder");
check("harder → 新点配额 3", harderToday.ok ? harderToday.data.difficulty.newQuota : 0, 3);
check(
  "harder → 平滑正确率随响应返回",
  harderToday.ok ? Math.abs((harderToday.data.difficulty.smoothedSuccessRate ?? 0) - 0.8933) < 0.002 : false,
  true
);

const easierToday = orchestrateToday(
  { date: DATE, model: MODEL, points: POINTS, performance: { attempts: 20, correct: 10 } },
  SECRET,
  NOW
);
check("最近 10/20 → easier", easierToday.ok ? easierToday.data.difficulty.level : "", "easier");
check("easier → 新点配额 1", easierToday.ok ? easierToday.data.difficulty.newQuota : 0, 1);

const deterministicHarder = orchestrateToday(
  { date: DATE, model: MODEL, points: POINTS, performance: { attempts: 20, correct: 19 } },
  SECRET,
  NOW
);
check(
  "同样输入 + performance → 同样的题包",
  JSON.stringify(deterministicHarder.ok ? deterministicHarder.data.questions : null),
  JSON.stringify(harderToday.ok ? harderToday.data.questions : null)
);

const badPerformanceCases: Array<[string, unknown]> = [
  ["performance 不是对象", "x"],
  ["attempts 为负", { attempts: -1, correct: 0 }],
  ["correct > attempts", { attempts: 5, correct: 6 }],
  ["attempts 非整数", { attempts: 3.5, correct: 2 }],
];
for (const [name, performance] of badPerformanceCases) {
  const result = orchestrateToday({ date: DATE, model: MODEL, points: POINTS, performance }, SECRET, NOW);
  check(`${name} → INVALID_PARAMS`, result.ok ? "" : result.code, "INVALID_PARAMS");
  check(`${name} → 400`, result.ok ? 0 : result.status, 400);
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
if (failed > 0) {
  console.log("❌ 有断言失败");
  process.exit(1);
}
console.log(`✅ ${passed} 项断言通过`);
