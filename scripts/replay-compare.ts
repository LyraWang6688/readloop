/**
 * 离线回放：同一批「合成学习者」分别用 SM-2（当前规则）与 FSRS-4.5（候选规则）排复习，
 * 用 scripts/metrics 同一套口径比较保持率、复习次数、leech 比例等。
 *
 * 运行：
 *   ./node_modules/.bin/tsx scripts/replay-compare.ts
 *   ./node_modules/.bin/tsx scripts/replay-compare.ts --days 84 --cards 80 --seed 7
 *
 * 重要：合成学习者只是**相对比较**用的模型，不是真实用户。结论必须再用真实复习日志复核
 * （做法见 docs/EVALUATION.md）。两种真实感模型各跑一遍，避免「只对某种遗忘曲线成立」。
 *
 * 纯离线、无网络、无依赖、确定性（同 seed 同结果）。
 */

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

const DAYS = Math.min(90, Math.trunc(argValue("--days", 84)));
const CARDS = Math.trunc(argValue("--cards", 80));
const NEW_PER_DAY = Math.trunc(argValue("--new-per-day", 3));
const DAILY_CAP = Math.trunc(argValue("--daily-cap", 20));
const SEED = Math.trunc(argValue("--seed", 42));
const FSRS_RETENTION = argValue("--fsrs-retention", 0.9);
const START_DATE = "2026-01-01";


// ============================================================
// 合成学习者
// ============================================================

/** 真实记忆模型：指数遗忘 或 FSRS 幂律遗忘（用来检验结论是否依赖模型假设） */
type TruthModel = "exponential" | "fsrs";

interface TruthCard {
  /** 真实稳定性（≈回忆概率降到 90% 所需天数） */
  stability: number;
}

/** 标准正态（Box–Muller），用传入的确定性 rng */
function normal(rng: () => number): number {
  const u = Math.max(rng(), Number.EPSILON);
  const v = Math.max(rng(), Number.EPSILON);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** 每张卡的真实初始稳定性：中位数 2.5 天，跨度 ~e^0.7 */
function makeTruthCards(seed: number): TruthCard[] {
  const rng = mulberry32(fnv1a(`truth:${seed}`));
  return Array.from({ length: CARDS }, () => ({
    stability: Math.exp(Math.log(2.5) + 0.7 * normal(rng)),
  }));
}

function recallProbability(model: TruthModel, elapsed: number, stability: number): number {
  if (elapsed <= 0) return 1;
  if (model === "fsrs") return fsrsRetrievability(elapsed, stability);
  // 指数遗忘：0.9^(t/S)，S 就是「保持率 90% 的天数」
  return Math.pow(0.9, elapsed / stability);
}

/** 真实记忆在一次作答后的变化（两个模型用同一套增长规则，保证可比） */
function updateTruthStability(model: TruthModel, stability: number, correct: boolean): number {
  if (!correct) return Math.max(0.5, stability * 0.55);
  const growth = model === "fsrs" ? 1.8 : 1.7;
  return Math.min(365, stability * growth);
}

// ============================================================
// 两套调度器
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
  targetRetention: number | null;
  model: TruthModel;
  reviews: number;
  days: number;
  reviewsPerDay: number;
  practice: PracticeRow[];
  metrics: MetricsResult;
  lapses: number;
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
  const rng = mulberry32(fnv1a(`sim:${model}:${scheduler}:${seed}`));
  const cards = initCards(truths);
  const practice: PracticeRow[] = [];
  let introduced = 0;
  let reviews = 0;
  let lapses = 0;

  for (let day = 0; day < DAYS; day += 1) {
    // 每天引入少量新点（模拟每日新点配额）
    let introducedToday = 0;
    while (introduced < cards.length && introducedToday < NEW_PER_DAY) {
      const card = cards[introduced];
      card.introducedDay = day;
      if (scheduler === "sm2") card.sm2.dueDay = day;
      else card.fsrs = { ...newCard(day) };
      introduced += 1;
      introducedToday += 1;
    }

    // 今天到期：按到期先后，受每日上限约束
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

      // 真实记忆更新
      card.truth.stability = updateTruthStability(model, card.truth.stability, correct);

      // 调度器更新
      if (scheduler === "sm2") {
        const next = applyGrade(card.sm2.state, grade.analysis);
        card.sm2 = {
          state: next,
          dueDay: day + Math.max(1, next.intervalDays),
          lastReviewDay: day,
        };
        if (!correct) lapses += 1;
      } else {
        const next = reviewCard(card.fsrs, grade.fsrs, day, fsrsRetention);
        card.fsrs = next;
        if (!correct) lapses += 1;
      }

      reviews += 1;
      practice.push({
        答题时间: dayToDate(day),
        知识点: card.id,
        题型: card.type,
        是否正确: correct ? "correct" : "wrong",
        信号强度: correct ? "自己译对" : "错",
        // 合成一个稳定的用时（15–45 秒），只用于指标展示，不参与调度
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

  const metrics = computeMetrics({
    date: endDate,
    windowDays: DAYS,
    practice,
    points,
  });

  return {
    scheduler,
    label: scheduler === "sm2" ? "SM-2" : `FSRS@${(fsrsRetention * 100).toFixed(0)}%`,
    targetRetention: scheduler === "sm2" ? null : fsrsRetention,
    model,
    reviews,
    days: DAYS,
    reviewsPerDay: reviews / DAYS,
    practice,
    metrics,
    lapses,
  };
}

// ============================================================
// 输出
// ============================================================

function pct(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function bucketRate(result: RunResult, key: string): string {
  const bucket = result.metrics.byInterval?.find((item) => item.key === key);
  if (!bucket || bucket.attempts === 0) return "—";
  return `${pct(bucket.successRate)} (${bucket.correct}/${bucket.attempts})`;
}

const RETENTION_GRID = Array.from(new Set([0.9, 0.95, FSRS_RETENTION])).sort();
const results: RunResult[] = [];
for (const model of ["exponential", "fsrs"] as const) {
  // 每个场景都用一套全新的「真实记忆卡」：稳定性会在模拟中被修改，不能复用对象
  results.push(simulate("sm2", model, makeTruthCards(SEED), SEED));
  for (const retention of RETENTION_GRID) {
    results.push(simulate("fsrs", model, makeTruthCards(SEED), SEED, retention));
  }
}

console.log("=".repeat(78));
console.log(`离线回放：SM-2 vs FSRS-4.5`);
console.log(
  `参数：${DAYS} 天 · ${CARDS} 张卡 · 每天新卡 ${NEW_PER_DAY} · 每日上限 ${DAILY_CAP} · seed ${SEED}`
);
console.log("=".repeat(78));

for (const model of ["exponential", "fsrs"] as const) {
  console.log(`\n【真实遗忘模型：${model === "exponential" ? "指数 0.9^(t/S)" : "FSRS 幂律"}】`);
  const rows = results.filter((item) => item.model === model);
  console.log(
    "调度器 | 复习次数 | 次/天 | 整体正确率(平滑) | 当天 | 1–2天 | 3–6天 | 7–13天 | 14+天 | leech 占比"
  );
  console.log("---|---|---|---|---|---|---|---|---|---");
  for (const result of rows) {
    console.log(
      [
        result.label,
        String(result.reviews),
        result.reviewsPerDay.toFixed(2),
        `${pct(result.metrics.overall.successRate)} (${pct(result.metrics.overall.smoothedSuccessRate)})`,
        bucketRate(result, "same_day"),
        bucketRate(result, "1_2"),
        bucketRate(result, "3_6"),
        bucketRate(result, "7_13"),
        bucketRate(result, "14_plus"),
        pct(result.metrics.leech.leechRatio),
      ].join(" | ")
    );
  }

  const sm2 = rows.find((item) => item.scheduler === "sm2")!;
  const longRate = (result: RunResult): number | null => {
    const buckets = (result.metrics.byInterval ?? []).filter(
      (b) => b.key === "7_13" || b.key === "14_plus"
    );
    const attempts = buckets.reduce((sum, b) => sum + b.attempts, 0);
    const correct = buckets.reduce((sum, b) => sum + b.correct, 0);
    return attempts ? correct / attempts : null;
  };
  const sm2Long = longRate(sm2);

  for (const fsrs of rows.filter((item) => item.scheduler === "fsrs")) {
    const deltaSuccess =
      (fsrs.metrics.overall.successRate ?? 0) - (sm2.metrics.overall.successRate ?? 0);
    const deltaReviews = fsrs.reviews - sm2.reviews;
    console.log(
      `\n${fsrs.label} 相对 SM-2：正确率 ${deltaSuccess >= 0 ? "+" : ""}${(deltaSuccess * 100).toFixed(1)}pp，` +
        `复习次数 ${deltaReviews >= 0 ? "+" : ""}${deltaReviews} 次（${(
          (deltaReviews / Math.max(1, sm2.reviews)) *
          100
        ).toFixed(1)}%）`
    );
    console.log(
      `长间隔（7 天以上）保持率：SM-2 ${pct(sm2Long)} vs ${fsrs.label} ${pct(longRate(fsrs))}`
    );
  }
}

// ---- 自检：确定性 + FSRS 公式基本性质 ----
let failures = 0;
const assert = (name: string, ok: boolean) => {
  if (!ok) {
    failures += 1;
    console.error(`❌ ${name}`);
  }
};

const repeat = simulate("fsrs", "fsrs", makeTruthCards(SEED), SEED);
const base = results.find((item) => item.model === "fsrs" && item.scheduler === "fsrs")!;
assert("同 seed 回放结果一致", JSON.stringify(repeat.practice) === JSON.stringify(base.practice));
assert("两种调度器都有复习发生", results.every((item) => item.reviews > 0));
assert("FSRS 公式：R(0)=1", Math.abs(fsrsRetrievability(0, 5) - 1) < 1e-9);
assert(
  "FSRS 公式：R(t=S)≈0.9",
  Math.abs(fsrsRetrievability(5, 5) - 0.9) < 1e-9
);
assert(
  "FSRS 公式：目标 0.9 时间隔≈stability",
  Math.abs(intervalForRetention(10, 0.9) - 10) <= 1
);

console.log("\n" + "=".repeat(78));
console.log("注意：合成学习者只用于相对比较；是否切换调度器必须用真实复习日志再跑一遍。");
console.log(failures === 0 ? "✅ 回放自检通过" : `❌ ${failures} 项自检失败`);
process.exit(failures === 0 ? 0 : 1);
