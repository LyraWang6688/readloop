/**
 * difficulty.ts 的自测脚本。
 * 运行：npx tsx scripts/difficulty-check.ts
 */
import {
  DEFAULT_QUOTA,
  adaptDifficulty,
  inTargetBand,
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

console.log("\n【1】样本不足时不调整");
check("0 题", adaptDifficulty({ attempts: 0, correct: 0 }).level, "steady");
check("9 题（正确率再高也不加难）", adaptDifficulty({ attempts: 9, correct: 9 }).level, "steady");
check("样本不足时 successRate 仍返回", adaptDifficulty({ attempts: 4, correct: 3 }).successRate, 0.75);

console.log("\n【2】正确率过高 → 加难");
const tooEasy = adaptDifficulty({ attempts: 20, correct: 19 });
check("19/20 → harder", tooEasy.level, "harder");
check("新点 +1", tooEasy.newQuota, DEFAULT_QUOTA.newQuota + 1);
check("难题 +1", tooEasy.leechQuota, DEFAULT_QUOTA.leechQuota + 1);

console.log("\n【3】正确率过低 → 降难");
const tooHard = adaptDifficulty({ attempts: 20, correct: 10 });
check("10/20 → easier", tooHard.level, "easier");
check("新点 -1", tooHard.newQuota, DEFAULT_QUOTA.newQuota - 1);
check("难题 -1", tooHard.leechQuota, DEFAULT_QUOTA.leechQuota - 1);

console.log("\n【4】目标区间内 → 维持");
check("16/20 = 80% → steady", adaptDifficulty({ attempts: 20, correct: 16 }).level, "steady");
check("17/20 = 85% → steady（含边界）", adaptDifficulty({ attempts: 20, correct: 17 }).level, "steady");
check("14/20 = 70% → steady（含边界）", adaptDifficulty({ attempts: 20, correct: 14 }).level, "steady");

console.log("\n【5】配额边界");
const maxed = adaptDifficulty({ attempts: 20, correct: 20 }, { newQuota: 3, leechQuota: 3 });
check("新点封顶 3", maxed.newQuota, 3);
const floored = adaptDifficulty({ attempts: 20, correct: 0 }, { newQuota: 1, leechQuota: 1 });
check("新点下限 1", floored.newQuota, 1);
check("难题下限 1", floored.leechQuota, 1);

console.log("\n【6】目标区间判定");
check("0.7 在区间内", inTargetBand(0.7), true);
check("0.85 在区间内", inTargetBand(0.85), true);
check("0.9 不在区间", inTargetBand(0.9), false);
check("0.5 不在区间", inTargetBand(0.5), false);

console.log("\n【7】理由可读");
console.log(`  高: ${tooEasy.reason}`);
console.log(`  低: ${tooHard.reason}`);
check("理由非空", tooEasy.reason.length > 0 && tooHard.reason.length > 0, true);

console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
process.exit(failed === 0 ? 0 : 1);
