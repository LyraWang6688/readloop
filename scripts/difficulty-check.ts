/**
 * difficulty.ts 的自测脚本。
 * 运行：./node_modules/.bin/tsx scripts/difficulty-check.ts
 *
 * 覆盖：小样本保护（20 题）、贝叶斯平滑、加难/降难/维持、配额边界、目标区间判定。
 */
import {
  DEFAULT_QUOTA,
  MIN_SAMPLE,
  PRIOR_SUCCESS_RATE,
  PRIOR_WEIGHT,
  adaptDifficulty,
  inTargetBand,
  rawSuccessRate,
  smoothSuccessRate,
} from "../src/lib/difficulty";

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

const near = (actual: number | null, expected: number, tolerance = 0.002) =>
  actual !== null && Math.abs(actual - expected) <= tolerance;

console.log("\n【1】小样本保护：少于 20 题不调整");
check("常数 MIN_SAMPLE = 20", MIN_SAMPLE, 20);
check("0 题", adaptDifficulty({ attempts: 0, correct: 0 }).level, "steady");
check("9 题（原来会加难的样本）", adaptDifficulty({ attempts: 9, correct: 9 }).level, "steady");
check("19 题全对仍不加难", adaptDifficulty({ attempts: 19, correct: 19 }).level, "steady");
check("样本不足时 successRate 仍返回", adaptDifficulty({ attempts: 4, correct: 3 }).successRate, 0.75);
check("样本不足时理由提到样本", adaptDifficulty({ attempts: 3, correct: 3 }).reason.includes("样本不足"), true);

console.log("\n【2】贝叶斯平滑");
check("先验参数 rate", PRIOR_SUCCESS_RATE, 0.78);
check("先验参数 weight", PRIOR_WEIGHT, 10);
check("0 样本返回 null", smoothSuccessRate(0, 0), null);
check("10/10 → 0.89（被先验拉低）", near(smoothSuccessRate(10, 10), 0.89), true);
check("0/20 → 0.26（被先验抬高）", near(smoothSuccessRate(0, 20), 0.26), true);
check("20/20 → 0.9267", near(smoothSuccessRate(20, 20), 0.9267), true);
check("超出 attempts 的 correct 被夹紧", smoothSuccessRate(30, 20), smoothSuccessRate(20, 20));
check("原始正确率不受先验影响", rawSuccessRate(9, 10), 0.9);
check("原始正确率 0 样本为 null", rawSuccessRate(0, 0), null);

console.log("\n【3】正确率过高 → 加难（用平滑值决策）");
const tooEasy = adaptDifficulty({ attempts: 20, correct: 19 });
check("19/20 → harder", tooEasy.level, "harder");
check("原始正确率 0.95", tooEasy.successRate, 0.95);
check("平滑后 0.893", near(tooEasy.smoothedSuccessRate, 0.8933), true);
check("新点 +1", tooEasy.newQuota, DEFAULT_QUOTA.newQuota + 1);
check("难题 +1", tooEasy.leechQuota, DEFAULT_QUOTA.leechQuota + 1);
check("理由带平滑后数值", tooEasy.reason.includes("平滑后"), true);
check("profile 带先验参数", JSON.stringify(tooEasy.prior), JSON.stringify({ rate: 0.78, weight: 10 }));

console.log("\n【4】正确率过低 → 降难");
const tooHard = adaptDifficulty({ attempts: 20, correct: 10 });
check("10/20 → easier", tooHard.level, "easier");
check("平滑后 0.593", near(tooHard.smoothedSuccessRate, 0.5933), true);
check("新点 -1", tooHard.newQuota, DEFAULT_QUOTA.newQuota - 1);
check("难题 -1", tooHard.leechQuota, DEFAULT_QUOTA.leechQuota - 1);

console.log("\n【5】目标区间内 → 维持");
check("16/20 = 80% → steady", adaptDifficulty({ attempts: 20, correct: 16 }).level, "steady");
check("17/20 = 85% → steady（平滑 0.827）", adaptDifficulty({ attempts: 20, correct: 17 }).level, "steady");
check("14/20 = 70% → steady（平滑 0.727）", adaptDifficulty({ attempts: 20, correct: 14 }).level, "steady");
check("15/20 = 75% → steady", adaptDifficulty({ attempts: 20, correct: 15 }).level, "steady");

console.log("\n【6】平滑后的边界");
check("18/20（平滑 0.86）→ harder", adaptDifficulty({ attempts: 20, correct: 18 }).level, "harder");
check("13/20（平滑 0.693）→ easier", adaptDifficulty({ attempts: 20, correct: 13 }).level, "easier");

console.log("\n【7】配额边界");
const maxed = adaptDifficulty({ attempts: 20, correct: 20 }, { newQuota: 3, leechQuota: 3 });
check("新点封顶 3", maxed.newQuota, 3);
check("难题封顶 3", maxed.leechQuota, 3);
const floored = adaptDifficulty({ attempts: 20, correct: 0 }, { newQuota: 1, leechQuota: 1 });
check("新点下限 1", floored.newQuota, 1);
check("难题下限 1", floored.leechQuota, 1);

console.log("\n【8】目标区间判定（原始值）");
check("0.7 在区间内", inTargetBand(0.7), true);
check("0.85 在区间内", inTargetBand(0.85), true);
check("0.9 不在区间", inTargetBand(0.9), false);
check("0.5 不在区间", inTargetBand(0.5), false);

console.log("\n【9】单调性：同样样本量，答对越多越难");
const levels = [10, 13, 14, 16, 18, 20].map(
  (correct) => adaptDifficulty({ attempts: 20, correct }).level
);
check("10 → easier", levels[0], "easier");
check("13 → easier", levels[1], "easier");
check("14 → steady", levels[2], "steady");
check("16 → steady", levels[3], "steady");
check("18 → harder", levels[4], "harder");
check("20 → harder", levels[5], "harder");

console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
process.exit(failed === 0 ? 0 : 1);
