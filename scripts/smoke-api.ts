/**
 * 接口端到端冒烟：对着一个真实跑起来的服务（`next start`）发 HTTP 请求。
 *
 * 运行：由 scripts/smoke-api.sh 启动服务后调用
 *   LICENSE_SECRET=… QUESTION_ID_SECRET=… SMOKE_BASE_URL=http://127.0.0.1:3107 npx tsx scripts/smoke-api.ts
 *
 * 覆盖：授权码/鉴权（401/402）、today 组题与不泄答案、submit 判分与幂等、
 * setup 接口的鉴权与错误分支、diagnose 鉴权。不依赖飞书、不依赖大模型。
 */

import { addDays, todayInShanghai } from "../src/lib/date";
import {
  decodeQuestionId,
  generateLicenseCode,
  LICENSE_ALPHABET,
  signPayload,
  type QuestionPayload,
} from "../src/lib/token";

const BASE = (process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:3107").replace(/\/+$/, "");
// 运行期由 smoke-api.sh 注入；这里用空串兜底是为了让 tsc 拿到 string 类型
const LICENSE_SECRET = process.env.LICENSE_SECRET ?? "";
const QUESTION_ID_SECRET = process.env.QUESTION_ID_SECRET ?? "";

if (!LICENSE_SECRET || !QUESTION_ID_SECRET) {
  console.error("❌ 需要 LICENSE_SECRET / QUESTION_ID_SECRET 环境变量");
  process.exit(1);
}

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

interface Envelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string; details?: string };
}

async function call<T = unknown>(
  method: "GET" | "POST",
  path: string,
  options: { body?: unknown; token?: string | null } = {}
): Promise<{ status: number; envelope: Envelope<T> }> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.token !== null && options.token !== undefined) {
    headers.Authorization = `Bearer ${options.token}`;
  }
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const envelope = (await response.json()) as Envelope<T>;
  return { status: response.status, envelope };
}

const DATE = todayInShanghai();
const YESTERDAY = addDays(DATE, -1);

const MODEL = {
  provider: "deepseek",
  base_url: "https://api.deepseek.com/v1",
  model: "deepseek-chat",
  api_key: "sk-smoke-test-not-a-real-key",
};

function makePoints() {
  return [
    {
      知识点: "subsequent",
      归一化内容: "subsequent",
      类型: "word",
      释义: "随后的",
      状态: "review",
      间隔天数: 3,
      难度因子: 2.5,
      连对次数: 1,
      答错次数: 0,
      待练次数: 2,
      下次复习: YESTERDAY,
      来源原句: "The subsequent chapters discuss the results in detail.",
      来源链接: "https://example.com/article-1",
    },
    {
      知识点: "caveat",
      归一化内容: "caveat",
      类型: "word",
      释义: "注意事项",
      状态: "relearning",
      间隔天数: 0,
      难度因子: 2.1,
      连对次数: 0,
      答错次数: 4,
      待练次数: 6,
      下次复习: YESTERDAY,
      来源原句: "A caveat is in order before we draw any conclusion.",
    },
    {
      知识点: "in terms of",
      归一化内容: "in terms of",
      类型: "phrase",
      释义: "就……而言",
      状态: "new",
      间隔天数: 0,
      难度因子: 2.5,
      连对次数: 0,
      答错次数: 0,
      待练次数: 3,
    },
    {
      知识点: "merit",
      归一化内容: "merit",
      类型: "word",
      释义: "优点",
      状态: "new",
      间隔天数: 0,
      难度因子: 2.5,
      连对次数: 0,
      答错次数: 0,
      待练次数: 3,
      来源原句: "The merit of this approach is its simplicity.",
    },
    {
      知识点: "archived-point",
      归一化内容: "archived-point",
      类型: "word",
      释义: "已归档",
      状态: "mastered",
      间隔天数: 30,
      难度因子: 2.8,
      连对次数: 5,
      答错次数: 0,
      待练次数: 0,
      下次复习: addDays(DATE, 30),
    },
  ];
}

interface Question {
  question_id: string;
  type: "choice" | "cloze";
  stem: string;
  options?: string[];
  context: string | null;
  hint: string | null;
}

interface TodayData {
  date: string;
  variant: number;
  total: number;
  answered: number;
  questions: Question[];
  session_context: { new_count: number; due_count: number; weak_points: string[] };
}

interface SubmitData {
  result: "correct" | "wrong";
  grade: string;
  explanation: string;
  updates: Record<string, string | number>;
}

async function main() {
  // ============================================================
  console.log("\n【0】健康检查 / 首页");
  // ============================================================
  const health = await fetch(`${BASE}/api/health`);
  const healthBody = (await health.json()) as { status?: string; service?: string };
  check("GET /api/health → 200", health.status, 200);
  check("health status = ok", healthBody.status, "ok");
  check("health service = readloop", healthBody.service, "readloop");
  check("GET / → 页面可访问（非 404）", (await fetch(`${BASE}/`)).status, 200);
  check("GET /privacy → 200", (await fetch(`${BASE}/privacy`)).status, 200);

  // ============================================================
  console.log("\n【1】授权码 → host_token");
  // ============================================================
  const goodLicense = generateLicenseCode(LICENSE_SECRET);
  const activated = await call<{ hostToken: string; expiresAt: string }>(
    "POST",
    "/api/license/activate",
    { body: { license: ` ${goodLicense.toLowerCase().slice(0, 7)}-${goodLicense.slice(7)} ` } }
  );
  check("激活成功（带空格/连字符也能归一化）", activated.status, 200);
  checkTrue("返回 hostToken", typeof activated.envelope.data?.hostToken === "string");
  checkTrue(
    "expiresAt 是 +08:00 的 ISO 串",
    /\+08:00$/.test(activated.envelope.data?.expiresAt ?? "")
  );
  const hostToken = activated.envelope.data?.hostToken ?? "";

  const wrongLast = goodLicense.slice(0, 7) +
    LICENSE_ALPHABET[(LICENSE_ALPHABET.indexOf(goodLicense[7]) + 1) % LICENSE_ALPHABET.length];
  const badLicense = await call("POST", "/api/license/activate", { body: { license: wrongLast } });
  check("校验位不对 → 401", badLicense.status, 401);
  check("错误码 LICENSE_INVALID", badLicense.envelope.error?.code, "LICENSE_INVALID");

  const malformed = await call("POST", "/api/license/activate", { body: { license: "abc" } });
  check("格式不对 → 400", malformed.status, 400);

  // ============================================================
  console.log("\n【2】鉴权：401 / 402 / 缺 token");
  // ============================================================
  const noToken = await call("POST", "/api/review/today", { body: { date: DATE, model: MODEL, points: makePoints() } });
  check("today 无 token → 401", noToken.status, 401);

  const garbage = await call("POST", "/api/review/today", { body: {}, token: "not-a-token" });
  check("today 坏 token → 401", garbage.status, 401);

  const expiredToken = signPayload(
    { v: 1, lic: goodLicense, iat: Date.now() - 400 * 24 * 3600 * 1000, exp: Date.now() - 1000 },
    LICENSE_SECRET
  );
  const expired = await call("POST", "/api/review/today", { body: {}, token: expiredToken });
  check("today 过期 token → 402", expired.status, 402);
  check("错误码 LICENSE_EXPIRED", expired.envelope.error?.code, "LICENSE_EXPIRED");

  const diagnoseNoToken = await call("POST", "/api/diagnose", {
    body: { originalParagraph: "hello world", userTranslation: "你好世界", model: MODEL },
  });
  check("diagnose 无 token → 401", diagnoseNoToken.status, 401);

  // ============================================================
  console.log("\n【3】today：确定性组题 + 不泄答案");
  // ============================================================
  const today = await call<TodayData>("POST", "/api/review/today", {
    body: { date: DATE, model: MODEL, points: makePoints() },
    token: hostToken,
  });
  check("status 200", today.status, 200);
  const data = today.envelope.data as TodayData;
  checkTrue("questions 非空", Array.isArray(data.questions) && data.questions.length > 0);
  check("total 与题目数一致", data.total, data.questions.length);
  checkTrue("variant 在 0–4", data.variant >= 0 && data.variant <= 4);
  check("answered 恒为 0", data.answered, 0);
  checkTrue("所有题的 context 都是 null（作答前不泄题）", data.questions.every((q) => q.context === null));
  checkTrue(
    "选择题带 4 个选项",
    data.questions.filter((q) => q.type === "choice").every((q) => (q.options ?? []).length === 4)
  );
  checkTrue(
    "每道题都有签名的 question_id",
    data.questions.every((q) => typeof q.question_id === "string" && q.question_id.length > 20)
  );
  checkTrue("session_context 字段齐全",
    typeof data.session_context.new_count === "number" &&
    typeof data.session_context.due_count === "number" &&
    Array.isArray(data.session_context.weak_points));
  checkTrue("已归档的点不出题", !data.questions.some((q) => q.question_id.includes("archived-point")));
  checkTrue(
    "leech 题带提示",
    data.questions.some((q) => q.hint !== null)
  );

  // 确定性：同样输入 + 同一天，再取一次应得到同一批知识点与题型
  const again = await call<TodayData>("POST", "/api/review/today", {
    body: { date: DATE, model: MODEL, points: makePoints() },
    token: hostToken,
  });
  checkTrue(
    "同一天重复取题 → 同一批知识点/题型",
    JSON.stringify(
      (again.envelope.data as TodayData).questions.map((q) => {
        const p = decodeQuestionId(q.question_id, QUESTION_ID_SECRET) as { ok: true; payload: QuestionPayload };
        return `${p.payload.p}:${p.payload.t}`;
      })
    ) ===
      JSON.stringify(
        data.questions.map((q) => {
          const p = decodeQuestionId(q.question_id, QUESTION_ID_SECRET) as { ok: true; payload: QuestionPayload };
          return `${p.payload.p}:${p.payload.t}`;
        })
      )
  );
  check("重复取题 variant 相同", (again.envelope.data as TodayData).variant, data.variant);

  // 参数错误
  const emptyPoints = await call("POST", "/api/review/today", {
    body: { date: DATE, model: MODEL, points: [] },
    token: hostToken,
  });
  check("空 points → 422", emptyPoints.status, 422);

  const badModel = await call("POST", "/api/review/today", {
    body: { date: DATE, model: { ...MODEL, base_url: "http://api.deepseek.com/v1" }, points: makePoints() },
    token: hostToken,
  });
  check("model 非 https → 400", badModel.status, 400);
  check("错误码 MODEL_CONFIG_INVALID", badModel.envelope.error?.code, "MODEL_CONFIG_INVALID");

  const harder = await call<TodayData & { difficulty: { level: string; newQuota: number; smoothedSuccessRate: number | null } }>(
    "POST",
    "/api/review/today",
    {
      body: { date: DATE, model: MODEL, performance: { attempts: 20, correct: 19 }, points: makePoints() },
      token: hostToken,
    }
  );
  check("最近 19/20 → today 200", harder.status, 200);
  check("difficulty.level = harder", harder.envelope.data?.difficulty.level, "harder");
  check("difficulty.newQuota = 3", harder.envelope.data?.difficulty.newQuota, 3);
  checkTrue(
    "difficulty.smoothedSuccessRate 有值",
    typeof harder.envelope.data?.difficulty.smoothedSuccessRate === "number"
  );

  const easier = await call<TodayData & { difficulty: { level: string; newQuota: number } }>(
    "POST",
    "/api/review/today",
    {
      body: { date: DATE, model: MODEL, performance: { attempts: 20, correct: 10 }, points: makePoints() },
      token: hostToken,
    }
  );
  check("最近 10/20 → difficulty.level = easier", easier.envelope.data?.difficulty.level, "easier");
  check("difficulty.newQuota = 1", easier.envelope.data?.difficulty.newQuota, 1);

  const badPerformance = await call("POST", "/api/review/today", {
    body: { date: DATE, model: MODEL, performance: { attempts: 5, correct: 6 }, points: makePoints() },
    token: hostToken,
  });
  check("performance 非法 → 400", badPerformance.status, 400);

  // ============================================================
  console.log("\n【4】submit：判分、updates、幂等");
  // ============================================================
  const decodedQuestions = data.questions.map((q) => {
    const decoded = decodeQuestionId(q.question_id, QUESTION_ID_SECRET);
    if (!decoded.ok) throw new Error("服务端签出的 question_id 解不开");
    return { question: q, payload: decoded.payload };
  });

  const correctChoice = decodedQuestions.find(
    (item) => item.payload.t === "choice" && item.payload.o?.includes(item.payload.a)
  );
  if (correctChoice) {
    const index = correctChoice.payload.o?.indexOf(correctChoice.payload.a) ?? -1;
    const letter = String.fromCharCode(65 + index);
    const submitted = await call<SubmitData>("POST", "/api/review/submit", {
      body: { date: DATE, question_id: correctChoice.question.question_id, answer: letter, used_hint: false, elapsed_ms: 5000 },
      token: hostToken,
    });
    check("选择题答对（传字母）→ 200", submitted.status, 200);
    const submitData = submitted.envelope.data as SubmitData;
    check("result = correct", submitData.result, "correct");
    check("选择题答对记 good", submitData.grade, "good");
    check("updates 含 10 个字段", Object.keys(submitData.updates).length, 10);
    checkTrue("updates 含 难度因子", typeof submitData.updates["难度因子"] === "number");
    checkTrue("updates 含 最近暴露", typeof submitData.updates["最近暴露"] === "string");
    checkTrue(
      "下次复习 = 出题日 + max(间隔,1)",
      submitData.updates["下次复习"] ===
        addDays(DATE, Math.max(Number(submitData.updates["间隔天数"]), 1))
    );

    // 幂等：同一题再提交一次，返回同一组 updates
    const replay = await call<SubmitData>("POST", "/api/review/submit", {
      body: { date: DATE, question_id: correctChoice.question.question_id, answer: letter, used_hint: false, elapsed_ms: 5000 },
      token: hostToken,
    });
    check("重复提交返回同一组 updates", JSON.stringify((replay.envelope.data as SubmitData).updates), JSON.stringify(submitData.updates));

    // 用提示 → 降为 hard
    const hinted = await call<SubmitData>("POST", "/api/review/submit", {
      body: { date: DATE, question_id: correctChoice.question.question_id, answer: letter, used_hint: true, elapsed_ms: 5000 },
      token: hostToken,
    });
    check("用了提示也答对 → hard", (hinted.envelope.data as SubmitData).grade, "hard");
  } else {
    check("存在可用的选择题", false, true);
  }

  const correctCloze = decodedQuestions.find((item) => item.payload.t === "cloze");
  if (correctCloze) {
    const submitted = await call<SubmitData>("POST", "/api/review/submit", {
      body: { date: DATE, question_id: correctCloze.question.question_id, answer: correctCloze.payload.a, used_hint: false, elapsed_ms: 5000 },
      token: hostToken,
    });
    const submitData = submitted.envelope.data as SubmitData;
    check("填空题答对 → correct", submitData.result, "correct");
    check("填空题答对记 easy", submitData.grade, "easy");

    const wrong = await call<SubmitData>("POST", "/api/review/submit", {
      body: { date: DATE, question_id: correctCloze.question.question_id, answer: "zzzzzzzz", used_hint: false, elapsed_ms: 3000 },
      token: hostToken,
    });
    const wrongData = wrong.envelope.data as SubmitData;
    check("填空题答错 → wrong", wrongData.result, "wrong");
    check("答错记 again", wrongData.grade, "again");
    check("答错次日必出", wrongData.updates["下次复习"], addDays(DATE, 1));
    check("答错后间隔归零", wrongData.updates["间隔天数"], 0);
  } else {
    check("存在填空题", false, true);
  }

  // 篡改 / 过期 / 垃圾 question_id
  const tampered = await call("POST", "/api/review/submit", {
    body: { date: DATE, question_id: `${data.questions[0].question_id.slice(0, -2)}AA`, answer: "x" },
    token: hostToken,
  });
  check("篡改 question_id → 400", tampered.status, 400);

  const expiredQuestion = signPayload(
    {
      v: 1,
      d: DATE,
      k: "subsequent",
      p: "subsequent",
      t: "cloze",
      a: "subsequent",
      s: { st: "review", iv: 3, ea: 2.5, sk: 1, lp: 0, nd: 2 },
      exp: Date.now() - 1000,
    },
    QUESTION_ID_SECRET
  );
  const expiredSubmit = await call("POST", "/api/review/submit", {
    body: { date: DATE, question_id: expiredQuestion, answer: "subsequent" },
    token: hostToken,
  });
  check("过期 question_id → 400", expiredSubmit.status, 400);
  check("错误码 QUESTION_INVALID", expiredSubmit.envelope.error?.code, "QUESTION_INVALID");

  // ============================================================
  console.log("\n【5】setup 接口的鉴权与错误分支（不触发真实飞书调用）");
  // ============================================================
  const statusNotFound = await call("GET", "/api/setup/app/status?session=no-such-session", { token: hostToken });
  check("未知 session → 404", statusNotFound.status, 404);

  const pairNoAuth = await call("POST", "/api/setup/app/pair", { body: { session: "x", code: "123456" } });
  check("pair POST 无 token → 401", pairNoAuth.status, 401);

  const pairBadCode = await call("GET", "/api/setup/app/pair?code=999999");
  check("pair GET 未绑定的码 → 404", pairBadCode.status, 404);

  const startBadToken = await call("POST", "/api/setup/app/start", {
    body: { app_token: "https://my.feishu.cn/base/bascnXXXX" },
    token: hostToken,
  });
  check("start 传整条链接 → 400（服务端不解析 URL）", startBadToken.status, 400);

  // ============================================================
  console.log("\n【6】metrics：学习效果指标");
  // ============================================================
  const metricsNoAuth = await call("POST", "/api/review/metrics", {
    body: { practice: [] },
  });
  check("metrics 无 token → 401", metricsNoAuth.status, 401);

  const emptyMetrics = await call<{
    overall: { attempts: number; successRate: number | null };
    sample: { enough: boolean };
    recommendations: Array<{ code: string }>;
  }>("POST", "/api/review/metrics", { body: { practice: [] }, token: hostToken });
  check("空 practice → 200", emptyMetrics.status, 200);
  check("空 practice → attempts 0", emptyMetrics.envelope.data?.overall.attempts, 0);
  check("空 practice → 正确率 null", emptyMetrics.envelope.data?.overall.successRate, null);
  check("空 practice → 样本不足", emptyMetrics.envelope.data?.sample.enough, false);
  checkTrue(
    "空 practice → 给出 SAMPLE_TOO_SMALL 建议",
    (emptyMetrics.envelope.data?.recommendations ?? []).some((item) => item.code === "SAMPLE_TOO_SMALL")
  );

  const metricsFixture = [
    { 答题时间: "2026-10-23", 题型: "choice", 是否正确: "correct", 信号强度: "自己译对", 用时毫秒: 10000, 题源: "新点", 复习间隔: 0 },
    { 答题时间: "2026-10-20", 题型: "cloze", 是否正确: "wrong", 信号强度: "错", 用时毫秒: 60000, 题源: "到期", 复习间隔: 3 },
    { 答题时间: "2026-10-15", 题型: "choice", 是否正确: "correct", 信号强度: "提示后对", 用时毫秒: 30000, 题源: "到期", 复习间隔: 7 },
  ];
  const metrics = await call<{
    window: { end: string; days: number };
    overall: { attempts: number; correct: number; successRate: number | null; avgElapsedMs: number | null };
    byInterval: Array<{ key: string; attempts: number }> | null;
    leech: { leechRatio: number | null };
    adherence: { activeDays: number };
  }>("POST", "/api/review/metrics", {
    body: {
      date: DATE,
      windowDays: 28,
      practice: metricsFixture,
      points: [
        { 归一化内容: "a", 状态: "review", 答错次数: 0 },
        { 归一化内容: "b", 状态: "review", 答错次数: 4 },
      ],
    },
    token: hostToken,
  });
  check("完整 metrics → 200", metrics.status, 200);
  check("metrics attempts 3", metrics.envelope.data?.overall.attempts, 3);
  check("metrics correct 2", metrics.envelope.data?.overall.correct, 2);
  check("metrics 间隔分档 5 档", metrics.envelope.data?.byInterval?.length, 5);
  checkTrue("metrics 有 leech 占比", typeof metrics.envelope.data?.leech.leechRatio === "number");
  check("metrics 有练习天数", metrics.envelope.data?.adherence.activeDays, 3);

  const badWindow = await call("POST", "/api/review/metrics", {
    body: { windowDays: 0, practice: [] },
    token: hostToken,
  });
  check("windowDays=0 → 400", badWindow.status, 400);

  const badPractice = await call("POST", "/api/review/metrics", {
    body: { practice: "nope" },
    token: hostToken,
  });
  check("practice 不是数组 → 400", badPractice.status, 400);

  console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("❌ 冒烟脚本异常：", error instanceof Error ? error.message : error);
  process.exit(1);
});
