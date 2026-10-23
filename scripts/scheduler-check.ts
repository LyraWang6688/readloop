/**
 * scheduler.ts 的自测脚本。
 * 运行：npx tsx scripts/scheduler-check.ts
 */
import {
  INITIAL_STATE,
  applyGrade,
  isLeech,
  nextReviewAt,
  simulateGood,
  type KnowledgeState,
} from "../src/lib/scheduler";

let passed = 0;
let failed = 0;

function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${name}\n     期望 ${JSON.stringify(expected)}\n     实际 ${JSON.stringify(actual)}`);
  }
}

const NOW = Date.UTC(2026, 9, 23, 0, 0, 0); // 2026-10-23T00:00:00Z
const DAY = 24 * 60 * 60 * 1000;

console.log("\n【1】新点首次答对");
const first = applyGrade(INITIAL_STATE, "good");
check("间隔 = 1 天", first.intervalDays, 1);
check("状态 = review", first.state, "review");
check("连对 = 1", first.streak, 1);
check("债务 3 → 2", first.need, 2);
check("难度因子不变", first.ease, 2.5);

console.log("\n【2】连续答对，间隔滚动");
const curve = [0, 1, 2, 3, 4, 5].map((n) => simulateGood(n).intervalDays);
console.log(`  间隔序列：${curve.join(" → ")} 天`);
check("首次答对后 1 天", curve[1], 1);
check("第二次后 3 天", curve[2], 3);
check("第三次后 8 天", curve[3], 8);

console.log("\n【3】Easy 从新点起步");
const easy = applyGrade(INITIAL_STATE, "easy");
check("间隔 = 4 天", easy.intervalDays, 4);
check("难度因子 2.5 → 2.65", easy.ease, 2.65);

console.log("\n【4】Hard 的间隔系数");
const reviewed: KnowledgeState = { ...INITIAL_STATE, state: "review", intervalDays: 10, streak: 2, need: 2 };
const hard = applyGrade(reviewed, "hard");
check("10 天 × 1.2 = 12 天", hard.intervalDays, 12);
check("难度因子 2.5 → 2.35", hard.ease, 2.35);

console.log("\n【5】复习时答错");
const lapsed = applyGrade(reviewed, "again");
check("状态 = relearning", lapsed.state, "relearning");
check("间隔归 0", lapsed.intervalDays, 0);
check("连对归 0", lapsed.streak, 0);
check("答错次数 = 1", lapsed.lapses, 1);
check("债务 +1", lapsed.need, 3);
check("难度因子 2.5 → 2.3", lapsed.ease, 2.3);
check("下次复习 = 次日", nextReviewAt(lapsed, NOW), NOW + DAY);

console.log("\n【6】难词判定");
const leechState = { ...INITIAL_STATE, lapses: 4 };
check("答错 4 次即难词", isLeech(leechState), true);
check("答错 3 次不算", isLeech({ ...INITIAL_STATE, lapses: 3 }), false);

console.log("\n【7】归档：债务归零 + 连对≥3 + 经历过 ≥7 天间隔");
let three = INITIAL_STATE;
for (let i = 0; i < 3; i += 1) three = applyGrade(three, "good");
check("3 次连对还不归档（还没跨过长间隔）", three.state, "review");
check("此时间隔已排到 8 天", three.intervalDays, 8);
const four = applyGrade(three, "good");
check("跨过 8 天再答对 → mastered", four.state, "mastered");

console.log("\n【8】边界值");
check("难度因子下限 1.3", applyGrade({ ...INITIAL_STATE, ease: 1.3 }, "again").ease, 1.3);
check("难度因子上限 2.8", applyGrade({ ...INITIAL_STATE, ease: 2.8 }, "easy").ease, 2.8);
check("债务上限 8", applyGrade({ ...INITIAL_STATE, need: 8 }, "again").need, 8);
check("债务下限 0", applyGrade({ ...INITIAL_STATE, need: 0 }, "good").need, 0);

console.log("\n【9】纯函数：不修改入参");
const frozen = JSON.stringify(INITIAL_STATE);
applyGrade(INITIAL_STATE, "again");
check("入参未被修改", JSON.stringify(INITIAL_STATE), frozen);

console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
process.exit(failed === 0 ? 0 : 1);
