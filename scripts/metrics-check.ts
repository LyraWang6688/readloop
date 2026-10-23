/**
 * metrics.ts 的自测脚本。
 * 运行：./node_modules/.bin/tsx scripts/metrics-check.ts
 *
 * 覆盖：窗口过滤、脏数据跳过、整体正确率（原始/平滑）、间隔分档保持率、
 * 题型/题源分组、leech 占比、完成率、每题用时、确定性建议、缺失字段提示、
 * 非法入参与上限。
 */
import {
  INTERVAL_BUCKETS,
  MetricsInputError,
  computeMetrics,
  intervalBucketKey,
  parseCorrectFlag,
  parseQuestionType,
} from "../src/lib/metrics";

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

function checkTrue(name: string, actual: unknown) {
  if (actual) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${name}（实际 ${JSON.stringify(actual)}）`);
  }
}

const DATE = "2026-10-23";

/** 造一条 practice_events 行（字段名与飞书表一致） */
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    答题时间: "2026-10-20",
    知识点: "subsequent",
    题型: "choice",
    是否正确: "correct",
    信号强度: "自己译对",
    用时毫秒: 20000,
    题源: "到期",
    复习间隔: 3,
    ...overrides,
  };
}

console.log("\n【1】解析小工具");
check("correct → true", parseCorrectFlag("correct"), true);
check("wrong → false", parseCorrectFlag("wrong"), false);
check("中文「对」", parseCorrectFlag("对"), true);
check("中文「错」", parseCorrectFlag("错"), false);
check("布尔 true", parseCorrectFlag(true), true);
check("未知值 → null", parseCorrectFlag("maybe"), null);
check("题型 CHOICE（大写）", parseQuestionType("CHOICE"), "choice");
check("题型 cloze", parseQuestionType("cloze"), "cloze");
check("题型填空 → null", parseQuestionType("填空"), null);
check("间隔 0 → same_day", intervalBucketKey(0), "same_day");
check("间隔 2 → 1_2", intervalBucketKey(2), "1_2");
check("间隔 3 → 3_6", intervalBucketKey(3), "3_6");
check("间隔 7 → 7_13", intervalBucketKey(7), "7_13");
check("间隔 14 → 14_plus", intervalBucketKey(14), "14_plus");
check("间隔 99 → 14_plus", intervalBucketKey(99), "14_plus");
check("分档共 5 个", INTERVAL_BUCKETS.length, 5);

console.log("\n【2】整体指标 + 窗口过滤");
const practice = [
  row({ 答题时间: "2026-10-23", 是否正确: "correct", 题型: "choice", 题源: "新点", 复习间隔: 0, 用时毫秒: 10000, 信号强度: "自己译对" }), // ok
  row({ 答题时间: "2026-10-22", 是否正确: "correct", 题型: "cloze", 题源: "到期", 复习间隔: 1, 用时毫秒: 20000, 信号强度: "自己译对" }), // ok
  row({ 答题时间: "2026-10-21", 是否正确: "wrong", 题型: "choice", 题源: "到期", 复习间隔: 2, 用时毫秒: 30000, 信号强度: "错" }), // ok
  row({ 答题时间: "2026-10-19", 是否正确: "correct", 题型: "cloze", 题源: "到期", 复习间隔: 3, 用时毫秒: 40000, 信号强度: "提示后对" }), // ok
  row({ 答题时间: "2026-10-17", 是否正确: "wrong", 题型: "choice", 题源: "弱项", 复习间隔: 5, 用时毫秒: 50000, 信号强度: "错" }), // ok
  row({ 答题时间: "2026-10-15", 是否正确: "wrong", 题型: "cloze", 题源: "到期", 复习间隔: 7, 用时毫秒: 60000, 信号强度: "错" }), // ok
  row({ 答题时间: "2026-10-10", 是否正确: "wrong", 题型: "choice", 题源: "到期", 复习间隔: 10, 用时毫秒: 70000, 信号强度: "错" }), // ok
  row({ 答题时间: "2026-10-09", 是否正确: "wrong", 题型: "cloze", 题源: "弱项", 复习间隔: 13, 用时毫秒: 80000, 信号强度: "错" }), // ok
  row({ 答题时间: "2026-10-08", 是否正确: "correct", 题型: "choice", 题源: "到期", 复习间隔: 14, 用时毫秒: 90000, 信号强度: "自己译对" }), // ok
  row({ 答题时间: "2026-10-05", 是否正确: "correct", 题型: "cloze", 题源: "到期", 复习间隔: 21, 用时毫秒: 100000, 信号强度: "提示后对" }), // ok
  row({ 答题时间: "2026-01-01", 是否正确: "correct" }), // 窗口外，不统计
  { 答题时间: "not-a-date", 是否正确: "correct" }, // 脏数据，跳过
];
const points = [
  { 归一化内容: "a", 状态: "review", 答错次数: 0 },
  { 归一化内容: "b", 状态: "learning", 答错次数: 1 },
  { 归一化内容: "c", 状态: "review", 答错次数: 4 },
  { 归一化内容: "d", 状态: "relearning", 答错次数: 5 },
  { 归一化内容: "e", 状态: "mastered", 答错次数: 9 }, // 归档点不计入
];

const result = computeMetrics({ date: DATE, windowDays: 28, practice, points });
check("窗口 start", result.window.start, "2026-09-26");
check("窗口 end", result.window.end, DATE);
check("窗口天数", result.window.days, 28);
check("窗口内记录数 10", result.window.practiceRows, 10);
check("脏数据 1 条", result.window.skippedRows, 1);
check("整体 attempts", result.overall.attempts, 10);
check("整体 correct", result.overall.correct, 5);
check("原始正确率 0.5", result.overall.successRate, 0.5);
checkTrue("平滑后 ≈0.64", Math.abs((result.overall.smoothedSuccessRate ?? 0) - 0.64) < 0.001);
check("平均用时 55000ms", result.overall.avgElapsedMs, 55000);
check("提示使用率 0.2（10 条信号里 2 条提示）", result.overall.hintUsedRate, 0.2);
check("提示样本数", result.overall.hintSample, 10);
check("样本不足（10 < 20）", result.sample.enough, false);
check("样本门槛 20", result.sample.minSample, 20);
check("是否在目标区间（原始 0.5）", result.target.inBand, false);
check("目标区间下限", result.target.min, 0.7);
check("目标区间上限", result.target.max, 0.85);
checkTrue("决策率取平滑值", Math.abs((result.target.decisionRate ?? 0) - 0.64) < 0.001);

console.log("\n【3】间隔分档保持率");
const byInterval = result.byInterval;
check("有分档结果", Array.isArray(byInterval), true);
check("分档数为 5", byInterval?.length, 5);
const bucket = (key: string) => byInterval?.find((item) => item.key === key);
check("当天 attempts 1", bucket("same_day")?.attempts, 1);
check("当天正确率 1", bucket("same_day")?.successRate, 1);
check("1–2 天 attempts 2", bucket("1_2")?.attempts, 2);
check("1–2 天正确率 0.5", bucket("1_2")?.successRate, 0.5);
check("3–6 天 attempts 2", bucket("3_6")?.attempts, 2);
check("7–13 天 attempts 3", bucket("7_13")?.attempts, 3);
check("7–13 天正确率 0", bucket("7_13")?.successRate, 0);
check("14 天以上 attempts 2", bucket("14_plus")?.attempts, 2);
check("14 天以上正确率 1", bucket("14_plus")?.successRate, 1);
check("缺失字段为空", result.missing, []);

console.log("\n【4】题型 / 题源分组");
const choice = result.byType.find((item) => item.type === "choice");
const cloze = result.byType.find((item) => item.type === "cloze");
check("choice attempts 5", choice?.attempts, 5);
check("choice correct 2", choice?.correct, 2);
check("choice 正确率 0.4", choice?.successRate, 0.4);
check("cloze attempts 5", cloze?.attempts, 5);
check("cloze correct 3", cloze?.correct, 3);
const dueSource = result.bySource.find((item) => item.source === "到期");
check("题源「到期」attempts 7", dueSource?.attempts, 7);
check("题源「到期」correct 4", dueSource?.correct, 4);
check("题源按 attempts 倒序", result.bySource[0].attempts >= result.bySource[result.bySource.length - 1].attempts, true);

console.log("\n【5】leech / 完成率 / 建议");
check("活跃知识点 4（排除 mastered）", result.leech.activePoints, 4);
check("难词 2（lapses ≥ 4）", result.leech.leechPoints, 2);
check("难词占比 0.5", result.leech.leechRatio, 0.5);
check("有练习的天数 10", result.adherence.activeDays, 10);
check("完成率 10/28", result.adherence.rate, 10 / 28);
checkTrue("样本不足建议存在", result.recommendations.some((item) => item.code === "SAMPLE_TOO_SMALL"));
checkTrue("长间隔偏弱建议存在", result.recommendations.some((item) => item.code === "LONG_INTERVAL_WEAK"));
checkTrue("建议最多 3 条", result.recommendations.length <= 3);

console.log("\n【6】确定性");
const again = computeMetrics({ date: DATE, windowDays: 28, practice, points });
check("同样输入 → 同样结果", JSON.stringify(again), JSON.stringify(result));

console.log("\n【7】没有「复习间隔」字段时");
const noInterval = Array.from({ length: 20 }, (_, index) =>
  row({
    答题时间: `2026-10-${String(1 + (index % 20)).padStart(2, "0")}`,
    是否正确: index < 16 ? "correct" : "wrong",
    复习间隔: undefined,
  })
);
const noIntervalResult = computeMetrics({ date: DATE, windowDays: 28, practice: noInterval });
check("byInterval 为 null", noIntervalResult.byInterval, null);
check("missing 包含复习间隔", noIntervalResult.missing, ["复习间隔"]);
checkTrue("给出补字段建议", noIntervalResult.recommendations.some((item) => item.code === "MISSING_INTERVAL"));
check("样本足够（20）", noIntervalResult.sample.enough, true);
check("16/20 → 目标区间内", noIntervalResult.target.inBand, true);

console.log("\n【8】空数据 / 边界");
const empty = computeMetrics({ date: DATE, practice: [] });
check("空 practice 不报错", empty.overall.attempts, 0);
check("空 practice 正确率 null", empty.overall.successRate, null);
check("空 practice 完成率 0", empty.adherence.rate, 0);
checkTrue("空 practice 提示样本不足", empty.recommendations.some((item) => item.code === "SAMPLE_TOO_SMALL"));
const oneDay = computeMetrics({ date: DATE, windowDays: 1, practice: [row({ 答题时间: DATE })] });
check("windowDays=1 窗口 start=end", oneDay.window.start, DATE);
check("windowDays=1 完成率 1", oneDay.adherence.rate, 1);

console.log("\n【9】非法入参");
function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch (error) {
    return error instanceof MetricsInputError;
  }
}
check("请求体不是对象", throws(() => computeMetrics("x")), true);
check("practice 不是数组", throws(() => computeMetrics({ practice: {} })), true);
check("points 不是数组", throws(() => computeMetrics({ practice: [], points: "x" })), true);
check("windowDays=0", throws(() => computeMetrics({ practice: [], windowDays: 0 })), true);
check("windowDays=91", throws(() => computeMetrics({ practice: [], windowDays: 91 })), true);
check("dates（毫秒时间戳字符串也接受）", parseCorrectFlag("correct"), true);

console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
process.exit(failed === 0 ? 0 : 1);
