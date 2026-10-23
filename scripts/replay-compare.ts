/**
 * 离线回放：SM-2 vs FSRS-4.5。
 *
 * 两种模式：
 *   1) 合成模式（默认）：同一批合成学习者分别用两套规则排复习，
 *      比较保持率、复习次数、Brier/log-loss、单位时间保持率；
 *   2) 真实日志模式：`--practice practice_events.json`，把用户历史记录按两套规则
 *      重新预测一次，比较**谁的概率预测更准**（历史间隔不可改，不能比「谁排得更好」）。
 *
 * 运行：
 *   ./node_modules/.bin/tsx scripts/replay-compare.ts
 *   ./node_modules/.bin/tsx scripts/replay-compare.ts --days 84 --cards 80 --seed 7
 *   ./node_modules/.bin/tsx scripts/replay-compare.ts --practice /path/to/practice.json
 *
 * 纯离线、无网络、确定性（同 seed 同结果）。
 */

import { readFileSync } from "node:fs";
import { applyGrade, INITIAL_STATE, type Grade, type KnowledgeState } from "../src/lib/scheduler";
import {
  FSRS_TARGET_RETENTION,
  intervalForRetention,
  newCard,
  retrievability as fsrsRetrievability,
  reviewCard,
  type FsrsCard,
  type FsrsGrade,
} from "../src/lib/fsrs-lite";
import { computeMetrics, type MetricsResult } from "../src/lib/metrics";
import {
  evaluatePredictions,
  replayRealLogs,
  unitRetention,
  type PredictionSample,
} from "../src/lib/replay";
import { addDays } from "../src/lib/date";
import { fnv1a, mulberry32 } from "../src/lib/selection";

// ============================================================
// 参数
// ============================================================

function argValue(flag: string, fallback: number): number {
  const index = process.argv.indexOf(flag);
  if (index === -1) return fallback;
  const parsed = Number(process.argv[index + 1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function argString(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

const DAYS = Math.min(90, Math.trunc(argValue("--days", 84)));
const CARDS = Math.trunc(argValue("--cards", 80));
const NEW_PER_DAY = Math.trunc(argValue("--new-per-day", 3));
const DAILY_CAP = Math.trunc(argValue("--daily-cap", 20));
const SEED = Math.trunc(argValue("--seed", 42));
const START_DATE = "2026-01-01";
const PRACTICE_PATH = argString("--practice");

// ============================================================
// 合成学习者
// ============================================================

type TruthModel = "exponential" | "fsrs";

interface TruthCard {
  stability: number;
}

function normal(rng: () => number): number {
  const u = Math.max(rng(), Number.EPSILON);
  const v = Math.max(rng(), Number.EPSILON);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function makeTruthCards(seed: number): TruthCard[] {
  const rng = mulberry32(fnv1a(`truth:${seed}`));
  return Array.from({ length: CARDS }, () => ({
    stability: Math.exp(Math.log(2.5) + 0.7 * normal(rng)),
  }));
}

function recallProbability(model: TruthModel, elapsed: number, stability: number): number {
  if (elapsed <= 0) return 1;
  if (model === "fsrs") return fsrsRetrievability(elapsed, stability);
  return Math.pow(0.9, elapsed / stability);
}

function updateTruthStability(model: TruthModel, stability: number, correct: boolean): number {
  if (!correct) return Math.max(0.5, stability * 0.55);
  return Math.min(365, stability * (model === "fsrs" ? 1.8 : 1.7));
}

// ============================================================
// 合成调度
// ============================================================

type SchedulerName = "sm2" | "fsrs";

interface SimCard {
  id: string;
  type: "choice" | "cloze";
  introducedDay: number;
  truth: TruthCard;
  sm2: { state: KnowledgeState; dueDay: number; lastReviewDay: number | null };
  fsrs: FsrsCard;
}

interface PracticeRow {
  答题时间: string;
  知识点: string;
  题型: string;
  是否正确: string;
  信号强度: string;
  用时毫秒: number;
  题源: string;
  复习间隔: number;
}

interface RunResult {
  scheduler: SchedulerName;
  label: string;
  model: TruthModel;
  reviews: number;
  days: number;
  reviewsPerDay: number;
  metrics: MetricsResult;
  predictions: PredictionSample[];
}

function dayToDate(day: number): string {
  return addDays(START_DATE, day);
}

function initCards(truths: TruthCard[]): SimCard[] {
  return truths.map((truth, index) => ({
    id: `p${String(index + 1).padStart(3, "0")}`,
    type: index % 2 === 0 ? "choice" : "cloze",
    introducedDay: Number.MAX_SAFE_INTEGER,
    truth,
    sm2: { state: { ...INITIAL_STATE }, dueDay: 0, lastReviewDay: null },
    fsrs: newCard(0),
  }));
}

function gradeFor(card: SimCard, correct: boolean): { analysis: Grade; fsrs: FsrsGrade } {
  if (!correct) return { analysis: "again", fsrs: 1 };
  if (card.type === "cloze") return { analysis: "easy", fsrs: 4 };
  return { analysis: "good", fsrs: 3 };
}

function simulate(
  scheduler: SchedulerName,
  model: TruthModel,
  truths: TruthCard[],
  seed: number,
  fsrsRetention: number = FSRS_TARGET_RETENTION
): RunResult {
  const rng = mulberry32(fnv1a(`sim:${model}:${scheduler}:${fsrsRetention}:${seed}`));
  const cards = initCards(truths);
  const practice: PracticeRow[] = [];
  const predictions: PredictionSample[] = [];
  let introduced = 0;
  let reviews = 0;

  for (let day = 0; day < DAYS; day += 1) {
    let introducedToday = 0;
    while (introduced < cards.length && introducedToday < NEW_PER_DAY) {
      const card = cards[introduced];
      card.introducedDay = day;
      if (scheduler === "sm2") card.sm2.dueDay = day;
      else card.fsrs = { ...newCard(day) };
      introduced += 1;
      introducedToday += 1;
    }

    const due = cards
      .filter((card) => {
        if (card.introducedDay > day) return false;
        const dueDay = scheduler === "sm2" ? card.sm2.dueDay : card.fsrs.dueDay;
        return dueDay <= day;
      })
      .sort((a, b) => {
        const dueA = scheduler === "sm2" ? a.sm2.dueDay : a.fsrs.dueDay;
        const dueB = scheduler === "sm2" ? b.sm2.dueDay : b.fsrs.dueDay;
        if (dueA !== dueB) return dueA - dueB;
        return a.id < b.id ? -1 : 1;
      })
      .slice(0, DAILY_CAP);

    for (const card of due) {
      const lastReviewDay =
        scheduler === "sm2" ? card.sm2.lastReviewDay : card.fsrs.lastReviewDay;
      const elapsed = lastReviewDay === null ? 0 : Math.max(0, day - lastReviewDay);
      const probability = recallProbability(model, elapsed, card.truth.stability);
      const correct = elapsed === 0 ? true : rng() < probability;
      const grade = gradeFor(card, correct);

      // 预测：作答前「还能回忆的概率」（两套规则各自的口径）
      const predicted =
        scheduler === "sm2"
          ? card.sm2.state.intervalDays > 0
            ? Math.pow(0.9, elapsed / card.sm2.state.intervalDays)
            : 1 // 合成场景首次复习一定答对（见 correct 的计算）
          : card.fsrs.reps === 0
            ? 1
            : fsrsRetrievability(elapsed, card.fsrs.stability);

      card.truth.stability = updateTruthStability(model, card.truth.stability, correct);

      if (scheduler === "sm2") {
        const next = applyGrade(card.sm2.state, grade.analysis);
        card.sm2 = { state: next, dueDay: day + Math.max(1, next.intervalDays), lastReviewDay: day };
      } else {
        card.fsrs = reviewCard(card.fsrs, grade.fsrs, day, fsrsRetention);
      }

      reviews += 1;
      predictions.push({ predicted, actual: correct ? 1 : 0 });
      practice.push({
        答题时间: dayToDate(day),
        知识点: card.id,
        题型: card.type,
        是否正确: correct ? "correct" : "wrong",
        信号强度: correct ? "自己译对" : "错",
        用时毫秒: 15_000 + Math.floor(rng() * 30_000),
        题源: elapsed === 0 ? "新点" : "到期",
        复习间隔: elapsed,
      });
    }
  }

  const endDate = dayToDate(DAYS - 1);
  const points = cards.map((card) => ({
    归一化内容: card.id,
    状态: "review",
    答错次数: scheduler === "sm2" ? card.sm2.state.lapses : card.fsrs.lapses,
  }));

  return {
    scheduler,
    label: scheduler === "sm2" ? "SM-2" : `FSRS@${(fsrsRetention * 100).toFixed(0)}%`,
    model,
    reviews,
    days: DAYS,
    reviewsPerDay: reviews / DAYS,
    predictions,
    metrics: computeMetrics({ date: endDate, windowDays: DAYS, practice, points }),
  };
}

// ============================================================
// 输出辅助
// ============================================================

function pct(value: number | null, digits = 1): string {
  return value === null ? "—" : `${(value * 100).toFixed(digits)}%`;
}

function bucket(result: RunResult, key: string) {
  return result.metrics.byInterval?.find((item) => item.key === key) ?? null;
}

function longInterval(result: RunResult): { attempts: number; correct: number; rate: number | null } {
  const buckets = (result.metrics.byInterval ?? []).filter(
    (item) => item.key === "7_13" || item.key === "14_plus"
  );
  const attempts = buckets.reduce((sum, item) => sum + item.attempts, 0);
  const correct = buckets.reduce((sum, item) => sum + item.correct, 0);
  return { attempts, correct, rate: attempts ? correct / attempts : null };
}

function calibrationTable(label: string, scores: ReturnType<typeof evaluatePredictions>): void {
  console.log(`\n${label} 校准（预测概率分箱）`);
  console.log("预测区间 | 样本 | 平均预测 | 实际正确率 | 偏差");
  console.log("---|---|---|---|---");
  for (const bin of scores.bins) {
    if (bin.count === 0) continue;
    const bias = (bin.actualRate ?? 0) - (bin.avgPredicted ?? 0);
    console.log(
      `${bin.key} | ${bin.count} | ${pct(bin.avgPredicted)} | ${pct(bin.actualRate)} | ${
        bias >= 0 ? "+" : ""
      }${(bias * 100).toFixed(1)}pp`
    );
  }
  console.log(
    `Brier=${scores.brier === null ? "—" : scores.brier.toFixed(4)}  ` +
      `log-loss=${scores.logLoss === null ? "—" : scores.logLoss.toFixed(4)}  n=${scores.count}`
  );
}

// ============================================================
// 真实日志模式：只比较预测质量
// ============================================================

function runRealMode(path: string): number {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const practice = Array.isArray(raw) ? raw : (raw as { practice?: unknown })?.practice;
  if (!Array.isArray(practice)) {
    console.error("❌ 文件里没有 practice 数组（支持 {practice:[...]} 或直接数组）");
    return 2;
  }

  console.log("=".repeat(78));
  console.log(`真实日志回放：${path}（${practice.length} 行）`);
  console.log("说明：历史间隔不可改，这里比较的是「预测概率准不准」，不是「谁排得更好」。");
  console.log("=".repeat(78));

  let failures = 0;
  const scores = (["sm2", "fsrs"] as const).map((scheduler) => {
    const replay = replayRealLogs(practice, scheduler);
    const evaluation = evaluatePredictions(replay.predictions);
    console.log(
      `\n${scheduler === "sm2" ? "SM-2" : "FSRS-4.5"}：可用 ${replay.events} 条，跳过 ${replay.skipped} 条`
    );
    calibrationTable(scheduler === "sm2" ? "SM-2" : "FSRS-4.5", evaluation);
    if (replay.events === 0) failures += 1;
    return evaluation;
  });

  if (scores[0].brier !== null && scores[1].brier !== null) {
    const delta = scores[1].brier - scores[0].brier;
    console.log(
      `\nBrier 对比：SM-2 ${scores[0].brier.toFixed(4)} vs FSRS ${scores[1].brier.toFixed(4)}` +
        `（越小越好；FSRS ${delta >= 0 ? "+" : ""}${delta.toFixed(4)}）`
    );
  }
  console.log(
    "\n提示：真实数据里 SM-2 的预测是「按上次间隔反推 90% 保持率」，FSRS 用自己的稳定性模型；" +
      "FSRS 的 Brier 明显更低才说明它的记忆模型更贴近这个用户。"
  );
  return failures === 0 ? 0 : 1;
}

// ============================================================
// 主流程
// ============================================================

if (PRACTICE_PATH) {
  process.exit(runRealMode(PRACTICE_PATH));
}

const RETENTION_GRID = [0.9, 0.95];
const results: RunResult[] = [];
for (const model of ["exponential", "fsrs"] as const) {
  results.push(simulate("sm2", model, makeTruthCards(SEED), SEED));
  for (const retention of RETENTION_GRID) {
    results.push(simulate("fsrs", model, makeTruthCards(SEED), SEED, retention));
  }
}

console.log("=".repeat(112));
console.log("离线回放：SM-2 vs FSRS-4.5（合成学习者）");
console.log(
  `参数：${DAYS} 天 · ${CARDS} 张卡 · 每天新卡 ${NEW_PER_DAY} · 每日上限 ${DAILY_CAP} · seed ${SEED}`
);
console.log("=".repeat(112));

for (const model of ["exponential", "fsrs"] as const) {
  console.log(`\n【真实遗忘模型：${model === "exponential" ? "指数 0.9^(t/S)" : "FSRS 幂律"}】`);
  console.log(
    "调度器 | 复习 | 次/天 | 正确率(平滑) | 7–13天 | 14+天 | Brier | logLoss | 长间隔保持‰/次 | 长间隔保持/日复习量"
  );
  console.log("---|---|---|---|---|---|---|---|---|---");
  for (const result of results.filter((item) => item.model === model)) {
    const evaluation = evaluatePredictions(result.predictions);
    const long = longInterval(result);
    const unit = unitRetention({
      reviews: result.reviews,
      days: result.days,
      longIntervalAttempts: long.attempts,
      longIntervalCorrect: long.correct,
    });
    console.log(
      [
        result.label,
        String(result.reviews),
        result.reviewsPerDay.toFixed(2),
        `${pct(result.metrics.overall.successRate)} (${pct(result.metrics.overall.smoothedSuccessRate)})`,
        pct(bucket(result, "7_13")?.successRate ?? null),
        pct(bucket(result, "14_plus")?.successRate ?? null),
        evaluation.brier === null ? "—" : evaluation.brier.toFixed(4),
        evaluation.logLoss === null ? "—" : evaluation.logLoss.toFixed(4),
        unit.longRetentionPerReview === null
          ? "—"
          : `${(unit.longRetentionPerReview * 1000).toFixed(2)}‰`,
        unit.longRetentionPerDailyLoad === null
          ? "—"
          : unit.longRetentionPerDailyLoad.toFixed(3),
      ].join(" | ")
    );
  }
}

// ---- 自检 ----
let failures = 0;
const assert = (name: string, ok: boolean) => {
  if (!ok) {
    failures += 1;
    console.error(`❌ ${name}`);
  }
};

const repeat = simulate("fsrs", "fsrs", makeTruthCards(SEED), SEED, 0.9);
const base = results.find((item) => item.model === "fsrs" && item.label === "FSRS@90%")!;
assert("同 seed 回放结果一致", JSON.stringify(repeat.predictions) === JSON.stringify(base.predictions));
assert("两种调度器都有复习发生", results.every((item) => item.reviews > 0));
assert("每次复习都有一条预测", results.every((item) => item.predictions.length === item.reviews));
assert(
  "Brier 分数在 [0,1] 内",
  results.every((item) => {
    const score = evaluatePredictions(item.predictions).brier;
    return score !== null && score >= 0 && score <= 1;
  })
);
assert("FSRS 公式：R(0)=1", Math.abs(fsrsRetrievability(0, 5) - 1) < 1e-9);
assert("FSRS 公式：R(t=S)≈0.9", Math.abs(fsrsRetrievability(5, 5) - 0.9) < 1e-9);
assert("FSRS 公式：目标 0.9 时间隔≈stability", Math.abs(intervalForRetention(10, 0.9) - 10) <= 1);
assert(
  "完美预测 Brier=0",
  evaluatePredictions([
    { predicted: 1, actual: 1 },
    { predicted: 0, actual: 0 },
  ]).brier === 0
);

console.log("\n" + "=".repeat(112));
console.log("注意：合成学习者只用于相对比较；是否切换调度器必须用真实复习日志再跑一遍（--practice）。");
console.log(failures === 0 ? "✅ 回放自检通过" : `❌ ${failures} 项自检失败`);
process.exit(failures === 0 ? 0 : 1);
