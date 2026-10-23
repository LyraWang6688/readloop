/**
 * replay.ts 的自测脚本（校准/Brier/log-loss/单位保持率 + 真实日志回放解析）。
 * 运行：./node_modules/.bin/tsx scripts/replay-check.ts
 */
import {
  binKey,
  evaluatePredictions,
  parseRealPracticeRows,
  replayRealLogs,
  unitRetention,
} from "../src/lib/replay";
import { reviewCardAtElapsed, newCard, retrievability } from "../src/lib/fsrs-lite";

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

const near = (actual: number | null, expected: number, tolerance = 1e-6) =>
  actual !== null && Math.abs(actual - expected) <= tolerance;

console.log("\n【1】校准分箱");
check("0.55 → 0.5–0.6", binKey(0.55), "0.5–0.6");
check("0.9 → 0.9–1.0", binKey(0.9), "0.9–1.0");
check("1.0 → 1.0", binKey(1), "1.0");
check("小于 0.5 归到第一箱", binKey(0.2), "0.5–0.6");
check("大于 1 被夹紧", binKey(1.5), "1.0");

console.log("\n【2】Brier / log-loss");
const perfect = evaluatePredictions([
  { predicted: 1, actual: 1 },
  { predicted: 0, actual: 0 },
  { predicted: 1, actual: 1 },
]);
check("完美预测样本数", perfect.count, 3);
check("完美预测 Brier=0", perfect.brier, 0);
check("完美预测 log-loss≈0", near(perfect.logLoss, 1e-6, 1e-5), true);

const coin = evaluatePredictions([
  { predicted: 0.5, actual: 1 },
  { predicted: 0.5, actual: 0 },
]);
check("0.5 预测 + 一错一对 → Brier=0.25", coin.brier, 0.25);
check("0.5 预测 + 一错一对 → log-loss=ln2", near(coin.logLoss, Math.LN2), true);

const allWrong = evaluatePredictions([
  { predicted: 0.9, actual: 0 },
  { predicted: 0.9, actual: 0 },
]);
check("过度自信但全错 → Brier=0.81", near(allWrong.brier, 0.81), true);
check("log-loss 有值", typeof allWrong.logLoss, "number");

const empty = evaluatePredictions([]);
check("空样本 Brier=null", empty.brier, null);
check("空样本 bins 为空", empty.bins, []);

const invalid = evaluatePredictions([
  { predicted: 2, actual: 1 },
  { predicted: Number.NaN, actual: 1 },
]);
check("越界/NaN 被过滤", invalid.count, 0);

const bins = evaluatePredictions([
  { predicted: 0.65, actual: 1 },
  { predicted: 0.65, actual: 0 },
  { predicted: 0.95, actual: 1 },
]).bins;
check("分档数量 5", bins.length, 5);
check("分档样本数合计", bins.reduce((sum, bin) => sum + bin.count, 0), 3);
const bin65 = bins.find((bin) => bin.key === "0.6–0.7");
check("0.6–0.7 箱样本 2", bin65?.count, 2);
check("0.6–0.7 箱实际正确率 0.5", bin65?.actualRate, 0.5);
check("0.6–0.7 箱平均预测 0.65", near(bin65?.avgPredicted ?? null, 0.65), true);

console.log("\n【3】单位时间保持率");
const unit = unitRetention({ reviews: 100, days: 50, longIntervalAttempts: 20, longIntervalCorrect: 16 });
check("次/天 = 2", unit.reviewsPerDay, 2);
check("长间隔保持率 0.8", unit.longRetention, 0.8);
check("每次复习的保持率 0.008", unit.longRetentionPerReview, 0.008);
check("每单位日复习量的保持率 0.4", unit.longRetentionPerDailyLoad, 0.4);
const unitEmpty = unitRetention({ reviews: 0, days: 10, longIntervalAttempts: 0, longIntervalCorrect: 0 });
check("没有长间隔样本 → null", unitEmpty.longRetention, null);

console.log("\n【4】真实日志解析");
const rows = [
  { 答题时间: "2026-10-02", 知识点: "a", 是否正确: "correct", 题型: "cloze", 复习间隔: 7 },
  { 答题时间: "2026-10-01", 知识点: "a", 是否正确: "wrong", 题型: "choice", 复习间隔: 3 },
  { 答题时间: "2026-10-03", 知识点: "b", 是否正确: "对", 复习间隔: 1 }, // 缺题型，仍可用
  { 答题时间: "2026-10-04", 知识点: "c", 是否正确: "correct" }, // 缺复习间隔 → 跳过
  { 知识点: "d", 是否正确: "wrong", 复习间隔: 2 }, // 缺日期，仍可用
  { 答题时间: "2026-10-05", 知识点: "e", 是否正确: "maybe", 复习间隔: 2 }, // 对错无法识别 → 跳过
];
const parsed = parseRealPracticeRows(rows);
check("可用 4 条", parsed.events.length, 4);
check("跳过 2 条", parsed.skipped, 2);
check("按日期排序（无日期最后）", parsed.events.map((event) => event.cardId).join(","), "a,a,b,d");
check("第一条 elapsed=3", parsed.events[0].elapsedDays, 3);
check("cloze 题型解析", parsed.events[1].type, "cloze");

console.log("\n【5】两套规则的真实日志预测");
const sm2 = replayRealLogs(rows, "sm2");
const fsrs = replayRealLogs(rows, "fsrs");
check("SM-2 事件数", sm2.events, 4);
check("SM-2 预测条数 = 事件数", sm2.predictions.length, sm2.events);
check("FSRS 事件数", fsrs.events, 4);
check("首条预测都用 90% 先验", sm2.predictions[0].predicted, 0.9);
check("FSRS 首条预测 0.9", fsrs.predictions[0].predicted, 0.9);
check("所有预测都在 [0,1]", [...sm2.predictions, ...fsrs.predictions].every((item) => item.predicted >= 0 && item.predicted <= 1), true);
const sm2Repeat = replayRealLogs(rows, "sm2");
check("真实日志回放确定性", JSON.stringify(sm2Repeat.predictions), JSON.stringify(sm2.predictions));

console.log("\n【6】FSRS 按真实间隔更新");
const first = reviewCardAtElapsed(newCard(0), 3, 0, 0);
check("首次 Good 后 reps=1", first.reps, 1);
check("首次 Good 后 stability ≈ w[2]", near(first.stability, 3.1262), true);
const afterLapse = reviewCardAtElapsed(first, 1, 10, 0);
check("答错后 lapses+1", afterLapse.lapses, 1);
check("答错后 stability 下降", afterLapse.stability < first.stability, true);
const afterGood = reviewCardAtElapsed(first, 3, 5, 0);
check("答对后 stability 上升", afterGood.stability > first.stability, true);
check("R(5, S=5)≈0.9", near(retrievability(5, 5), 0.9), true);

console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
process.exit(failed === 0 ? 0 : 1);
