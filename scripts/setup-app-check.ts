/**
 * session-store.ts 的自测脚本（一键创建应用的会话 / 凭证 / 配对码）。
 * 运行：npx tsx scripts/setup-app-check.ts
 *
 * 覆盖：状态机迁移、TTL 过期、凭证一次性交付、配对码格式/绑定/一次性取走、
 * 每会话 20 次尝试上限、终态清理、凭证脱敏。
 *
 * 全部用假时间戳，不联网、不需要飞书凭证（真实注册链路没法在本地验证）。
 */
import {
  advanceSessionState,
  bindPairCode,
  buildStatusView,
  canTransition,
  cleanupSetupSessions,
  countSetupSessions,
  createSetupSession,
  isSessionPurgeable,
  markSessionCompleted,
  markSessionFailed,
  markSessionPending,
  MAX_PAIR_ATTEMPTS,
  normalizePairCode,
  readSetupSession,
  resetSetupSessionStore,
  SETUP_CREDENTIAL_TTL_MS,
  SETUP_SESSION_RETENTION_MS,
  SETUP_SESSION_TTL_MS,
  takePairCredentials,
  type PairBindResult,
  type PairDeliveryResult,
  type SetupChecks,
  type SetupSessionRecord,
} from "../src/lib/feishu/session-store";
import { redactSecrets } from "../src/lib/feishu/verify";

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

/**
 * 基准“现在”。
 *
 * 不能钉死成某个过去的时间戳：有几个会话接口（markSessionFailed / readSetupSession /
 * bindPairCode 等）在不传 nowMs 时会回落到真实的 Date.now()，钉死时间会让这些会话在
 * 断言执行时已经被真实时钟判为过期（脚本就变成「几点跑决定通不通过」）。
 * 因此用当前时刻做基准，所有断言都用相对偏移。
 */
const NOW = Date.now();

const CHECKS: SetupChecks = {
  token: "ok",
  read: "ok",
  write: "ok",
  publish: "ok",
  details: "三项校验全部通过",
};

const CREDENTIALS = { appId: "cli_test_readloop", appSecret: "test_app_secret_value" };

function deliveryReason(result: PairDeliveryResult): string {
  return result.ok ? "ok" : result.reason;
}

function bindReason(result: PairBindResult): string {
  return result.ok ? "ok" : result.reason;
}

/** 造一条已经 completed、带凭证的会话 */
function seedCompletedSession(
  options: { nowMs?: number; appToken?: string } = {}
): SetupSessionRecord {
  const nowMs = options.nowMs ?? NOW;
  const created = createSetupSession(options.appToken ?? "bascnTestToken0001", nowMs);
  markSessionPending(created.id, "https://accounts.feishu.cn/app-registration?x=1", SETUP_SESSION_TTL_MS, nowMs);
  markSessionCompleted(created.id, CREDENTIALS, CHECKS, nowMs + 1_000);
  const session = readSetupSession(created.id, nowMs + 1_000);
  if (!session) throw new Error("自测造数据失败：会话没创建出来");
  return session;
}

// ============================================================
console.log("\n【1】状态机：合法迁移与终态不可复活");
// ============================================================
check("starting → pending 合法", canTransition("starting", "pending"), true);
check("starting → failed 合法", canTransition("starting", "failed"), true);
check("pending → completed 合法", canTransition("pending", "completed"), true);
check("pending → starting 非法（不能回退）", canTransition("pending", "starting"), false);
check("failed 是终态（不能复活）", canTransition("failed", "completed"), false);
check("expired 是终态（不能复活）", canTransition("expired", "completed"), false);
check("completed → expired 合法（凭证过期）", canTransition("completed", "expired"), true);

// ============================================================
console.log("\n【2】创建会话与 TTL 过期");
// ============================================================
resetSetupSessionStore();
const created = createSetupSession("bascnTestToken0002", NOW);
check("新会话状态是 starting", created.status, "starting");
check("新会话有效期 10 分钟", created.expiresAt - created.createdAt, SETUP_SESSION_TTL_MS);
check("TTL 内读取仍是 starting", readSetupSession(created.id, NOW + 1_000)?.status, "starting");
const expiredView = readSetupSession(created.id, NOW + SETUP_SESSION_TTL_MS);
check("超过 TTL 自动变 expired", expiredView?.status, "expired");
check("过期会话不再暴露凭证", buildStatusView(expiredView!).appSecret, null);

// ============================================================
console.log("\n【3】completed：默认不发 Secret，reveal_secret=1 才一次性返回");
// ============================================================
resetSetupSessionStore();
const completed = seedCompletedSession();

// 默认（主路径）：宿主只用来判断进度，不应看到 Secret
const defaultView = buildStatusView(completed, { nowMs: NOW + 2_000 });
check("默认 poll 不返回 app_secret", defaultView.appSecret, null);
check("默认 poll 返回 app_id", defaultView.appId, CREDENTIALS.appId);
check("默认 poll 状态是 completed", defaultView.status, "completed");
check("默认 poll 带 checks", defaultView.checks?.details, CHECKS.details);
check(
  "默认 poll 多次都不会冒出 app_secret",
  buildStatusView(completed, { nowMs: NOW + 2_000 }).appSecret,
  null
);

// 兜底手动路径：带 reveal_secret=1 才给，且只给一次
const revealView = buildStatusView(completed, {
  revealSecret: true,
  nowMs: NOW + 2_000,
});
check("reveal_secret=1 才返回 app_secret", revealView.appSecret, CREDENTIALS.appSecret);
check("reveal 时仍返回 app_id", revealView.appId, CREDENTIALS.appId);
check(
  "reveal_secret 也只能拿到一次",
  buildStatusView(completed, { revealSecret: true, nowMs: NOW + 2_000 }).appSecret,
  null
);
check(
  "reveal 之后默认 poll 仍是 null",
  buildStatusView(completed, { nowMs: NOW + 2_000 }).appSecret,
  null
);

// 凭证保留期：15 分钟内有效，到点变 expired 并清空
const nearDeadline = seedCompletedSession({ nowMs: NOW });
check(
  "凭证保留期内不失效",
  advanceSessionState(nearDeadline, NOW + 1_000 + SETUP_CREDENTIAL_TTL_MS - 1),
  false
);
check(
  "凭证保留期到点变 expired",
  advanceSessionState(nearDeadline, NOW + 1_000 + SETUP_CREDENTIAL_TTL_MS),
  true
);
check("凭证到点后被清空", nearDeadline.credentials, null);

// ============================================================
console.log("\n【4】注册失败 / 过期会话不复活");
// ============================================================
resetSetupSessionStore();
const failing = createSetupSession("bascnTestToken0003", NOW);
check("注册失败写入可读原因", markSessionFailed(failing.id, "你取消了应用创建")?.status, "failed");
check("失败会话保留原因", readSetupSession(failing.id)?.error, "你取消了应用创建");
const resurrected = markSessionCompleted(failing.id, CREDENTIALS, CHECKS, NOW + 1_000);
check("失败会话不接受迟到的凭证", resurrected, null);

resetSetupSessionStore();
const stale = createSetupSession("bascnTestToken0004", NOW);
const staleExpired = readSetupSession(stale.id, NOW + SETUP_SESSION_TTL_MS);
check("过期会话状态", staleExpired?.status, "expired");
check(
  "过期会话不接受迟到的凭证",
  markSessionCompleted(stale.id, CREDENTIALS, CHECKS, NOW + SETUP_SESSION_TTL_MS + 1),
  null
);

// ============================================================
console.log("\n【5】配对码格式与绑定");
// ============================================================
check("6 位数字合法", normalizePairCode("123456"), "123456");
check("数字类型也接受", normalizePairCode(654321), "654321");
check("5 位拒绝", normalizePairCode("12345"), null);
check("含字母拒绝", normalizePairCode("abc123"), null);
check("空值拒绝", normalizePairCode(""), null);
check("非字符串非数字拒绝", normalizePairCode({ code: "123456" }), null);

resetSetupSessionStore();
const pending = createSetupSession("bascnTestToken0005", NOW);
markSessionPending(pending.id, "https://accounts.feishu.cn/app-registration?x=2", SETUP_SESSION_TTL_MS, NOW);
check("pending 会话不能绑定配对码", bindReason(bindPairCode(pending.id, "111111")), "session_not_completed");
check("不存在的会话 → session_not_found", bindReason(bindPairCode("no-such-session", "111111")), "session_not_found");
check("过期会话 → session_expired", bindReason(
  bindPairCode(pending.id, "111111", NOW + SETUP_SESSION_TTL_MS)
), "session_expired");

resetSetupSessionStore();
const ready = seedCompletedSession({ appToken: "bascnAppTokenForPair" });
check("completed 会话可以绑定", bindReason(bindPairCode(ready.id, "246810")), "ok");
check("非法配对码不能绑定", bindReason(bindPairCode(ready.id, "12ab56")), "code_invalid");

const other = seedCompletedSession();
check("配对码已被其它会话占用", bindReason(bindPairCode(other.id, "246810")), "code_taken");

// ============================================================
console.log("\n【6】插件取凭证：一次性、含 app_token");
// ============================================================
check("未绑定的码取不到", deliveryReason(takePairCredentials("999999", NOW + 2_000)), "invalid_code");
const delivered = takePairCredentials("246810", NOW + 2_000);
check("绑定后取到凭证", delivered.ok, true);
check("返回 app_id", delivered.ok ? delivered.appId : null, CREDENTIALS.appId);
check("返回 app_secret", delivered.ok ? delivered.appSecret : null, CREDENTIALS.appSecret);
check("返回 app_token", delivered.ok ? delivered.appToken : null, "bascnAppTokenForPair");
check("取走后会话被删除", countSetupSessions(), 1);
check("同一码不能第二次取走", deliveryReason(takePairCredentials("246810", NOW + 3_000)), "invalid_code");

// 宿主重新绑定新码时，旧码立即失效
resetSetupSessionStore();
const rebind = seedCompletedSession();
bindPairCode(rebind.id, "135790");
bindPairCode(rebind.id, "135791");
check("旧码被新绑定替换", deliveryReason(takePairCredentials("135790", NOW + 2_000)), "invalid_code");
check("新码可以取走", deliveryReason(takePairCredentials("135791", NOW + 2_000)), "ok");

// ============================================================
console.log("\n【7】尝试上限：同一会话最多 20 次");
// ============================================================
resetSetupSessionStore();
const limited = seedCompletedSession();
bindPairCode(limited.id, "852963");
const expiredMoment = NOW + 1_000 + SETUP_CREDENTIAL_TTL_MS;
const attempts: string[] = [];
for (let i = 0; i < MAX_PAIR_ATTEMPTS; i += 1) {
  attempts.push(deliveryReason(takePairCredentials("852963", expiredMoment)));
}
check("前 20 次返回过期（不是上限）", attempts.every((reason) => reason === "expired"), true);
const overflow = takePairCredentials("852963", expiredMoment);
check("第 21 次触发尝试上限", deliveryReason(overflow), "too_many_attempts");
check(
  "上限内的尝试次数是 20",
  limited.pairAttempts,
  MAX_PAIR_ATTEMPTS + 1
);

// ============================================================
console.log("\n【8】清理：终态过期记录 + 进行中会话不受影响");
// ============================================================
resetSetupSessionStore();
const live = createSetupSession("bascnTestToken0006", NOW);
check("进行中的会话不会被清理", cleanupSetupSessions(NOW + 1_000), 0);
check("进行中的会话仍可读", readSetupSession(live.id, NOW + 1_000)?.status, "starting");

resetSetupSessionStore();
const doomed = createSetupSession("bascnTestToken0007", NOW);
readSetupSession(doomed.id, NOW + SETUP_SESSION_TTL_MS); // 先置 expired（settledAt = 过期时刻）
check("保留期未过不清理", cleanupSetupSessions(NOW + SETUP_SESSION_TTL_MS + SETUP_SESSION_RETENTION_MS - 1), 0);
check(
  "保留期过后清理掉终态记录",
  cleanupSetupSessions(NOW + SETUP_SESSION_TTL_MS + SETUP_SESSION_RETENTION_MS),
  1
);
check("清理后会话不存在", readSetupSession(doomed.id, NOW + SETUP_SESSION_TTL_MS + SETUP_SESSION_RETENTION_MS), null);
check("终态记录才可清理", isSessionPurgeable(live, NOW + 1_000), false);

// ============================================================
console.log("\n【9】脱敏：details / 日志里不得出现 Secret");
// ============================================================
const secret = "test_app_secret_value";
const redacted = redactSecrets(`换取 token 失败，app_secret=${secret}`, [secret]);
check("Secret 被替换成 ***", redacted.includes(secret), false);
check("非敏感文本原样保留", redactSecrets("读表失败：没有权限", [secret]), "读表失败：没有权限");

// ============================================================
console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
if (failed === 0) {
  console.log(`✅ ${passed} 项断言通过\n`);
  process.exit(0);
}
console.error(`❌ ${failed} 项断言失败\n`);
process.exit(1);
