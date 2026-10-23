/**
 * 一键创建飞书应用的会话表：进程内、不落库、带 TTL。
 *
 * 背景（docs/API_IMPLEMENTATION.md §6/§7/§8）：
 *   服务端没有数据库，但「一键创建应用」这条链路要跨请求记住几样东西——
 *   会话状态、一次性凭证、配对码。它们都只在十几分钟内有用，所以放在进程内
 *   Map 里（挂在 globalThis 上，dev 环境 HMR 重载模块时不会丢），交付/过期即删。
 *
 * 这里只做状态与生命周期，不碰网络：
 *   - 状态机：starting → pending → completed / failed / expired
 *   - 凭证一次性交付：`app_secret` 给出去一次（status 首次 poll 或配对取走），
 *     之后要么不再返回、要么整条会话删除
 *   - 配对码：宿主 POST 绑定到会话，插件 GET 取走凭证后会话即销毁
 *   - 每会话最多 20 次配对尝试，防爆破
 *
 * 所有函数都接受 `nowMs`，方便自测脚本用假时间覆盖 TTL / 过期 / 清理逻辑。
 */

import { randomUUID } from "node:crypto";

// ============================================================
// 类型
// ============================================================

export type SetupSessionStatus =
  | "starting"
  | "pending"
  | "completed"
  | "failed"
  | "expired";

/** 三项校验（外加自动发布）的单步结论 */
export type SetupCheckResult = "ok" | "failed";

export interface SetupChecks {
  token: SetupCheckResult;
  read: SetupCheckResult;
  write: SetupCheckResult;
  /** 自动发布版本：不发布会话权限不生效，但发布失败不阻塞凭证交付 */
  publish?: SetupCheckResult;
  /** 三项校验的可读结论，**不得包含任何凭证明文** */
  details: string;
  /** 发布失败的可读原因 */
  publish_details?: string;
}

export interface SetupCredentials {
  appId: string;
  appSecret: string;
}

export interface SetupSessionRecord {
  id: string;
  status: SetupSessionStatus;
  /** 用户多维表格的 app_token（`bascn…`），配对时随凭证一起交给插件 */
  appToken: string;
  /** 飞书 Device Grant 的创建链接（pending 时可给用户） */
  verificationUrl: string | null;
  createdAt: number;
  /** 当前阶段的有效期：starting/pending 是创建窗口，completed 是凭证保留期 */
  expiresAt: number;
  completedAt: number | null;
  /** 进入终态（failed / expired）的时间，用于清理前保留一段可读期 */
  settledAt: number | null;
  /** 凭证：交付前在这里，交付或过期后清空 */
  credentials: SetupCredentials | null;
  /** `app_secret` 是否已通过 status?reveal_secret=1 返回过一次（配对交付不受影响） */
  secretRevealedToHost: boolean;
  checks: SetupChecks | null;
  error: string | null;
  /** 已绑定的 6 位配对码（同一会话重新绑定时替换） */
  pairCode: string | null;
  pairAttempts: number;
}

// ============================================================
// 常量
// ============================================================

/** 创建会话的存活时间：用户点链接、在飞书里点「同意」要留足 10 分钟 */
export const SETUP_SESSION_TTL_MS = 10 * 60 * 1000;

/** 应用创建完成（completed）后凭证在服务端保留 15 分钟，等宿主把配对码交给插件 */
export const SETUP_CREDENTIAL_TTL_MS = 15 * 60 * 1000;

/** 终态记录再留 5 分钟，让宿主轮询时还能看到失败原因 / 过期提示 */
export const SETUP_SESSION_RETENTION_MS = 5 * 60 * 1000;

/** 同一配对码最多尝试 20 次，超出返回 429 */
export const MAX_PAIR_ATTEMPTS = 20;

/** 插件侧生成的配对码：6 位数字（100000–999999） */
export const PAIR_CODE_PATTERN = /^\d{6}$/;

const PAIR_CODE_LENGTH = 6;

/** 挂在 globalThis 上的存储键（dev HMR 安全） */
const STORE_KEY = "__readloop_setup_session_store__";

const EXPIRED_MESSAGE = "创建会话已过期，请重新发起";

// ============================================================
// 纯函数：状态机与生命周期
// ============================================================

/** 合法迁移表。终态不可复活（防止过期的会话被迟到的注册结果改回 completed）。 */
const ALLOWED_TRANSITIONS: Record<SetupSessionStatus, readonly SetupSessionStatus[]> = {
  starting: ["pending", "completed", "failed", "expired"],
  pending: ["completed", "failed", "expired"],
  completed: ["expired"],
  failed: [],
  expired: [],
};

/** 状态迁移是否合法（同状态视为幂等，直接放行） */
export function canTransition(
  from: SetupSessionStatus,
  to: SetupSessionStatus
): boolean {
  return from === to || ALLOWED_TRANSITIONS[from].includes(to);
}

/** 新建一条会话记录（纯函数，便于自测） */
export function createSessionRecord(input: {
  appToken: string;
  id?: string;
  nowMs?: number;
}): SetupSessionRecord {
  const nowMs = input.nowMs ?? Date.now();
  return {
    id: input.id ?? randomUUID(),
    status: "starting",
    appToken: input.appToken,
    verificationUrl: null,
    createdAt: nowMs,
    expiresAt: nowMs + SETUP_SESSION_TTL_MS,
    completedAt: null,
    settledAt: null,
    credentials: null,
    secretRevealedToHost: false,
    checks: null,
    error: null,
    pairCode: null,
    pairAttempts: 0,
  };
}

/**
 * 把记录推进到当前时间应有的状态（就地修改）。
 *
 * - starting / pending 超过 `expiresAt` → expired
 * - completed 超过凭证保留期 → expired，并清空凭证
 *
 * 返回是否发生了迁移。
 */
export function advanceSessionState(
  session: SetupSessionRecord,
  nowMs: number = Date.now()
): boolean {
  if (session.status === "completed") {
    if (nowMs < session.expiresAt) return false;
    session.status = "expired";
    session.credentials = null;
    session.secretRevealedToHost = true;
    session.settledAt = nowMs;
    session.error = EXPIRED_MESSAGE;
    return true;
  }
  if (session.status === "starting" || session.status === "pending") {
    if (nowMs < session.expiresAt) return false;
    session.status = "expired";
    session.credentials = null;
    session.settledAt = nowMs;
    session.error = EXPIRED_MESSAGE;
    return true;
  }
  return false;
}

/** 终态记录是否可以清理（保留期已过） */
export function isSessionPurgeable(
  session: SetupSessionRecord,
  nowMs: number = Date.now()
): boolean {
  return (
    session.settledAt !== null &&
    nowMs - session.settledAt >= SETUP_SESSION_RETENTION_MS
  );
}

/** 归一化配对码：必须是 6 位数字；非法返回 null */
export function normalizePairCode(raw: unknown): string | null {
  let value: string;
  if (typeof raw === "number" && Number.isInteger(raw)) {
    value = String(raw);
  } else if (typeof raw === "string") {
    value = raw.trim();
  } else {
    return null;
  }
  if (value.length !== PAIR_CODE_LENGTH) return null;
  return PAIR_CODE_PATTERN.test(value) ? value : null;
}

// ============================================================
// 进程内存储（globalThis）
// ============================================================

function getStore(): Map<string, SetupSessionRecord> {
  const globalStore = globalThis as Record<string, unknown>;
  if (!(globalStore[STORE_KEY] instanceof Map)) {
    globalStore[STORE_KEY] = new Map<string, SetupSessionRecord>();
  }
  return globalStore[STORE_KEY] as Map<string, SetupSessionRecord>;
}

function findSessionByPairCode(
  code: string
): SetupSessionRecord | undefined {
  for (const session of getStore().values()) {
    if (session.pairCode === code) return session;
  }
  return undefined;
}

// ============================================================
// 会话读写（路由用）
// ============================================================

/** 新建会话（状态 starting） */
export function createSetupSession(
  appToken: string,
  nowMs: number = Date.now()
): SetupSessionRecord {
  const session = createSessionRecord({ appToken, nowMs });
  getStore().set(session.id, session);
  return session;
}

/** 读取会话并推进过期状态；不存在返回 null */
export function readSetupSession(
  sessionId: string,
  nowMs: number = Date.now()
): SetupSessionRecord | null {
  const session = getStore().get(sessionId) ?? null;
  if (!session) return null;
  advanceSessionState(session, nowMs);
  return session;
}

/** 拿到飞书创建链接：starting → pending */
export function markSessionPending(
  sessionId: string,
  verificationUrl: string,
  ttlMs: number,
  nowMs: number = Date.now()
): SetupSessionRecord | null {
  const session = getStore().get(sessionId) ?? null;
  if (!session) return null;
  advanceSessionState(session, nowMs);
  if (session.status !== "starting") return null;
  session.status = "pending";
  session.verificationUrl = verificationUrl;
  session.expiresAt = nowMs + ttlMs;
  return session;
}

/**
 * 注册完成 + 三项校验跑完：状态置 completed 并保存凭证。
 *
 * 会话如果已经过期 / 失败就丢弃凭证（不复活会话）——此时用户重新点一次链接即可，
 * 新建出来的应用仍在用户组织里，可以删掉或复用。
 */
export function markSessionCompleted(
  sessionId: string,
  credentials: SetupCredentials,
  checks: SetupChecks,
  nowMs: number = Date.now()
): SetupSessionRecord | null {
  const session = getStore().get(sessionId) ?? null;
  if (!session) return null;
  advanceSessionState(session, nowMs);
  if (session.status !== "starting" && session.status !== "pending") {
    console.warn(
      `[setup] 会话 ${session.id} 已是 ${session.status}，丢弃新创建的应用凭证（app_id=${credentials.appId}）`
    );
    return null;
  }
  session.status = "completed";
  session.credentials = credentials;
  session.checks = checks;
  session.completedAt = nowMs;
  session.expiresAt = nowMs + SETUP_CREDENTIAL_TTL_MS;
  session.error = null;
  session.pairCode = null;
  session.pairAttempts = 0;
  return session;
}

/** 注册失败（可读原因） */
export function markSessionFailed(
  sessionId: string,
  error: string,
  nowMs: number = Date.now()
): SetupSessionRecord | null {
  const session = getStore().get(sessionId) ?? null;
  if (!session) return null;
  advanceSessionState(session, nowMs);
  if (session.status === "failed" || session.status === "expired") return session;
  session.status = "failed";
  session.error = error;
  session.settledAt = nowMs;
  session.credentials = null;
  return session;
}

/** 删除会话（凭证交付后立即调用） */
export function deleteSetupSession(sessionId: string): void {
  getStore().delete(sessionId);
}

/**
 * 清理：先推进过期状态，再删掉超过保留期的终态记录。
 * 返回删除的条数。每个路由入口调用一次即可。
 */
export function cleanupSetupSessions(nowMs: number = Date.now()): number {
  const store = getStore();
  let removed = 0;
  for (const [id, session] of store) {
    advanceSessionState(session, nowMs);
    if (isSessionPurgeable(session, nowMs)) {
      store.delete(id);
      removed += 1;
    }
  }
  return removed;
}

/** 自测脚本用：清空进程内会话表 */
export function resetSetupSessionStore(): void {
  getStore().clear();
}

/** 自测脚本用：当前会话条数 */
export function countSetupSessions(): number {
  return getStore().size;
}

// ============================================================
// status 视图（app_secret 默认不返回，需显式开启）
// ============================================================

export interface SetupStatusView {
  status: SetupSessionStatus;
  verificationUrl: string | null;
  expiresAt: number;
  checks: SetupChecks | null;
  appId: string | null;
  appSecret: string | null;
  error: string | null;
}

export interface StatusViewOptions {
  /**
   * 是否在这一次响应里带上 `app_secret`。
   * 主路径（插件用配对码自取凭证）保持 false；只有兜底的手动路径才传 true。
   */
  revealSecret?: boolean;
  nowMs?: number;
}

/**
 * 构造状态接口的返回视图。
 *
 * 决策（2026-10-23 Lead 拍板）：**默认不返回 `app_secret`**——主路径下 Secret
 * 由插件用配对码自取，宿主上下文里不该出现；只有显式 `reveal_secret=1` 的兜底
 * 手动路径才一次性返回。两种方式都**不销毁**凭证：销毁时机是「配对取走」或
 * 「完成后 15 分钟过期」，否则宿主先 poll、插件后配对的主流程会拿不到凭证（§8）。
 */
export function buildStatusView(
  session: SetupSessionRecord,
  options: StatusViewOptions = {}
): SetupStatusView {
  const nowMs = options.nowMs ?? Date.now();
  const revealSecret = options.revealSecret === true;
  advanceSessionState(session, nowMs);

  let appId: string | null = null;
  let appSecret: string | null = null;
  if (session.status === "completed" && session.credentials !== null) {
    appId = session.credentials.appId;
    if (revealSecret && !session.secretRevealedToHost) {
      appSecret = session.credentials.appSecret;
      session.secretRevealedToHost = true;
    }
  }

  return {
    status: session.status,
    verificationUrl: session.verificationUrl,
    expiresAt: session.expiresAt,
    checks: session.checks,
    appId,
    appSecret,
    error: session.error,
  };
}

// ============================================================
// 配对码：宿主绑定、插件取凭证
// ============================================================

export type PairBindFailureReason =
  | "session_not_found"
  | "session_expired"
  | "session_not_completed"
  | "code_invalid"
  | "code_taken";

export type PairBindResult =
  | { ok: true; session: SetupSessionRecord }
  | { ok: false; reason: PairBindFailureReason; message: string };

/** 宿主 POST /api/setup/app/pair：把插件给的 6 位码绑到已完成的会话上（不取 Secret） */
export function bindPairCode(
  sessionId: string,
  rawCode: unknown,
  nowMs: number = Date.now()
): PairBindResult {
  cleanupSetupSessions(nowMs);

  const session = getStore().get(sessionId) ?? null;
  if (!session) {
    return {
      ok: false,
      reason: "session_not_found",
      message: "创建会话不存在或已被取走，请重新发起",
    };
  }
  advanceSessionState(session, nowMs);
  if (session.status === "expired") {
    return { ok: false, reason: "session_expired", message: EXPIRED_MESSAGE };
  }
  if (session.status !== "completed") {
    return {
      ok: false,
      reason: "session_not_completed",
      message:
        session.status === "failed"
          ? `应用创建失败：${session.error ?? "请重新发起"}`
          : "应用还在创建中，等状态变成 completed 再配对",
    };
  }

  const code = normalizePairCode(rawCode);
  if (!code) {
    return {
      ok: false,
      reason: "code_invalid",
      message: "配对码必须是 6 位数字（插件「一键配置」里显示的那个码）",
    };
  }

  const occupied = findSessionByPairCode(code);
  if (occupied && occupied.id !== session.id) {
    return {
      ok: false,
      reason: "code_taken",
      message: "这个配对码已被其它创建会话占用，请让插件重新生成一个",
    };
  }

  session.pairCode = code;
  session.pairAttempts = 0;
  return { ok: true, session };
}

export type PairDeliveryFailureReason =
  | "invalid_code"
  | "expired"
  | "not_ready"
  | "too_many_attempts";

export type PairDeliveryResult =
  | { ok: true; appId: string; appSecret: string; appToken: string }
  | { ok: false; reason: PairDeliveryFailureReason; message: string };

/**
 * 插件 GET /api/setup/app/pair?code=…：一次性取走凭证。
 *
 * 取走即删除整条会话（docs/API_IMPLEMENTATION.md §8），之后的轮询都会 404。
 * 每增加一次尝试就记一次数；同一会话超过 20 次返回 429（需要宿主重新绑定新码）。
 *
 * 注意计数口径：只统计**解析到会话之后**的尝试。绑定前插件每 3 秒轮询一次
 * （最长 5 分钟 ≈ 100 次），那是正常的「还没绑定」，不能算爆破；绑定后一次就该
 * 命中交付，所以能撞到上限的都是异常请求（比如会话过期后还在被反复猜）。
 */
export function takePairCredentials(
  rawCode: unknown,
  nowMs: number = Date.now()
): PairDeliveryResult {
  cleanupSetupSessions(nowMs);

  const code = normalizePairCode(rawCode);
  if (!code) {
    return {
      ok: false,
      reason: "invalid_code",
      message: "配对码不存在或已失效，请让插件重新生成",
    };
  }

  const session = findSessionByPairCode(code);
  if (!session) {
    return {
      ok: false,
      reason: "invalid_code",
      message: "配对码不存在或已失效，请让插件重新生成",
    };
  }

  advanceSessionState(session, nowMs);
  session.pairAttempts += 1;
  if (session.pairAttempts > MAX_PAIR_ATTEMPTS) {
    return {
      ok: false,
      reason: "too_many_attempts",
      message: `配对码尝试次数过多（上限 ${MAX_PAIR_ATTEMPTS} 次），请让插件重新生成配对码`,
    };
  }

  if (session.status === "expired") {
    return { ok: false, reason: "expired", message: EXPIRED_MESSAGE };
  }
  if (session.status !== "completed" || session.credentials === null) {
    return {
      ok: false,
      reason: "not_ready",
      message: "应用还没有创建完成，请稍后再试",
    };
  }

  const delivery: PairDeliveryResult = {
    ok: true,
    appId: session.credentials.appId,
    appSecret: session.credentials.appSecret,
    appToken: session.appToken,
  };
  // 凭证一次性交付：取走即销毁会话（含 Secret）
  deleteSetupSession(session.id);
  return delivery;
}
