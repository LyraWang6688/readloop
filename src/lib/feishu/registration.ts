/**
 * 一键创建用户自己的飞书应用（飞书开放平台的 Device Grant 注册流程）。
 *
 * 背景（docs/ARCHITECTURE.md §4.3、docs/API_IMPLEMENTATION.md §6/§7）：
 *   插件在用户浏览器里，拿不到宿主（AI 工具）的飞书能力，所以必须有一条自己的
 *   写入通道——一个**归属用户自己**的自建应用。让用户进开发者后台手动建应用有
 *   7 步、约 10 分钟，还容易漏「发布版本」，所以这里用 SDK 的 `registerApp()`
 *   帮用户在他自己的组织里建应用：我们只发起，用户点链接 + 在飞书点「同意」。
 *
 * 流程：
 *   ① `startAppRegistration()` 调飞书公开注册端点，拿到 `verification_url`
 *      （8 秒内拿不到就判失败，不能让宿主无限等）
 *   ② 用户点链接同意后，SDK 轮询回来 `{client_id, client_secret}`
 *   ③ 立刻跑三项校验（`verify.ts`），把结果写进会话的 `checks`
 *   ④ 用新应用自己的凭证发布版本——**不发布会话权限不生效**，这是手动流程里
 *      最容易漏的一步；发布失败不阻塞凭证交付，只记录在 `checks.publish`
 *   ⑤ 会话置 `completed`，等宿主轮询告知用户，再由插件用配对码把凭证取走
 *
 * 安全：
 *   - 这里**不需要我们自己的应用凭证**（飞书公开注册端点不需要）
 *   - 任何日志、错误信息、`checks.details` 都不得出现 `app_secret`
 *   - 会话过期后迟到的注册结果直接丢弃，不复活会话
 */

import * as lark from "@larksuiteoapi/node-sdk";
import {
  markSessionCompleted,
  markSessionFailed,
  markSessionPending,
  readSetupSession,
  SETUP_SESSION_TTL_MS,
  type SetupChecks,
} from "./session-store";
import {
  redactSecrets,
  runSetupChecks,
  type SetupCheckReport,
} from "./verify";

// ============================================================
// 常量
// ============================================================

/** 8 秒内拿不到创建链接就判失败（与参考实现 teaming-bot 一致） */
export const QR_READY_TIMEOUT_MS = 8_000;

/** 注册来源标识，会进创建链接的 `source` 参数，便于飞书侧排查 */
const REGISTRATION_SOURCE = "readloop";

/** 用户在飞书确认页看到的默认应用信息；`{user}` 会替换成扫码人的名字 */
const APP_PRESET = {
  name: "ReadLoop 插件写入-{user}",
  desc: "ReadLoop Chrome 插件写表用，权限仅多维表格读写。",
} as const;

/**
 * 申请的权限：只申请多维表格读写 + 单选字段补选项，够插件写表用。
 * `preset: false` 表示不要平台默认模板，只保留这里显式声明的增量权限。
 */
const APP_ADDONS = {
  preset: false,
  scopes: {
    tenant: ["bitable:app", "base:field:update"],
  },
} as const;

/**
 * SDK 自己的日志全部吞掉：它可能把请求/响应打进控制台，
 * 而我们的硬约束是「日志里不得出现 app_secret」。
 */
const SILENT_LOGGER = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** SDK 的返回类型没有直接导出，用 ReturnType 取，避免写死一份重复声明 */
type RegisterAppResult = Awaited<ReturnType<typeof lark.registerApp>>;

// ============================================================
// 错误文案（可读、不含 Secret）
// ============================================================

interface FeishuErrorShape {
  code?: unknown;
  description?: unknown;
  message?: unknown;
  response?: {
    status?: unknown;
    data?: {
      code?: unknown;
      msg?: unknown;
    };
  };
}

/** 把 SDK / axios / 飞书返回的错误收敛成一句人话（不含凭证） */
function rawFeishuError(error: unknown): string {
  if (error && typeof error === "object") {
    const sdkError = error as FeishuErrorShape;
    const code = typeof sdkError.code === "string" ? sdkError.code : "";

    // SDK 的 Device Grant 错误是普通对象：{ code, description }
    if (code === "access_denied") {
      return "你（或管理员）取消了应用创建，可以重新发起";
    }
    if (code === "expired_token") {
      return "创建链接已过期，请重新发起";
    }
    if (code === "abort") {
      return "创建流程已中止，请重新发起";
    }

    const data = sdkError.response?.data;
    if (data && typeof data.code === "number" && data.code === 99991672) {
      return "发起方应用缺少自动创建权限，请联系维护者排查（飞书错误码 99991672）";
    }

    const description =
      typeof sdkError.description === "string" ? sdkError.description : "";
    const dataMessage = data && typeof data.msg === "string" ? data.msg : "";
    const sdkMessage =
      typeof sdkError.message === "string" ? sdkError.message : "";
    const reason = description || dataMessage || sdkMessage;
    if (reason) return reason;
  }

  if (typeof error === "string" && error.trim()) return error.trim();
  return "未知原因";
}

/** 对外可读的创建失败原因（先脱敏再截断） */
export function describeFeishuError(
  error: unknown,
  secrets: readonly string[] = []
): string {
  return redactSecrets(`飞书应用创建失败：${rawFeishuError(error)}`, secrets);
}

// ============================================================
// ④ 发布版本（失败不阻塞凭证交付）
// ============================================================

interface PublishResult {
  ok: boolean;
  message?: string;
}

async function publishApplicationVersion(
  appId: string,
  appSecret: string
): Promise<PublishResult> {
  try {
    const client = new lark.Client({
      appId,
      appSecret,
      appType: lark.AppType.SelfBuild,
      domain: lark.Domain.Feishu,
      loggerLevel: lark.LoggerLevel.error,
      logger: SILENT_LOGGER,
      source: REGISTRATION_SOURCE,
    });

    const response = await client.application.v7.applicationPublish.create({
      path: { app_id: appId },
      data: {
        remark: "ReadLoop 插件写入应用（自动创建）",
        changelog: "自动创建并发布：开通多维表格读写权限，供 Chrome 插件写表使用。",
      },
    });

    if (typeof response.code === "number" && response.code !== 0) {
      return {
        ok: false,
        message: redactSecrets(
          `自动发布失败（飞书错误码 ${response.code}）：${response.msg ?? "未知原因"}`,
          [appSecret]
        ),
      };
    }

    console.info("[setup] 已自动发布应用版本", {
      appId,
      versionId: response.data?.version_id ?? null,
    });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: redactSecrets(`自动发布失败：${rawFeishuError(error)}`, [appSecret]),
    };
  }
}

// ============================================================
// ③ 三项校验（异常也要收敛成 checks，不能让创建失败）
// ============================================================

async function runSetupChecksSafely(input: {
  appId: string;
  appSecret: string;
  appToken: string;
}): Promise<SetupCheckReport> {
  try {
    return await runSetupChecks(input);
  } catch (error) {
    return {
      token: "failed",
      read: "failed",
      write: "failed",
      details: redactSecrets(
        `三项校验执行异常：${rawFeishuError(error)}`,
        [input.appSecret]
      ),
    };
  }
}

// ============================================================
// 注册成功后的收尾
// ============================================================

/**
 * 注册完成 → 三项校验 → 发布版本 → 会话置 completed。
 *
 * 注意顺序：**先跑完校验再置 completed**，这样宿主看到 `completed` 时
 * `checks` 一定已经就绪（docs/API_IMPLEMENTATION.md §7 对 completed 的定义）。
 */
async function finishRegistration(
  sessionId: string,
  result: RegisterAppResult
): Promise<void> {
  const appId = result?.client_id;
  const appSecret = result?.client_secret;
  if (!appId || !appSecret) {
    markSessionFailed(sessionId, "飞书返回的应用凭证不完整，请重新发起");
    return;
  }

  const session = readSetupSession(sessionId);
  if (!session || session.status === "expired" || session.status === "failed") {
    // 会话已过期：不在服务端留下凭证，用户重新发起即可（新应用仍在用户组织里）
    console.warn("[setup] 创建会话已失效，丢弃新创建的应用凭证", { appId });
    return;
  }

  const report = await runSetupChecksSafely({
    appId,
    appSecret,
    appToken: session.appToken,
  });
  const publish = await publishApplicationVersion(appId, appSecret);

  const checks: SetupChecks = {
    token: report.token,
    read: report.read,
    write: report.write,
    publish: publish.ok ? "ok" : "failed",
    details: report.details,
  };
  if (!publish.ok && publish.message) {
    checks.publish_details = publish.message;
  }

  const completed = markSessionCompleted(
    sessionId,
    { appId, appSecret },
    checks
  );
  if (!completed) {
    console.warn("[setup] 创建会话在收尾前已失效，丢弃新创建的应用凭证", {
      appId,
    });
    return;
  }

  console.info("[setup] 应用创建完成，等待插件配对取凭证", {
    appId,
    token: report.token,
    read: report.read,
    write: report.write,
    publish: checks.publish,
  });
}

// ============================================================
// 启动注册（start 路由调用）
// ============================================================

interface QrReady {
  kind: "ready";
  url: string;
  expireIn: number;
}

interface RegistrationFailure {
  kind: "failure";
  message: string;
}

export type StartAppRegistrationResult =
  | { ok: true; verificationUrl: string; expiresAt: number }
  | { ok: false; message: string };

/**
 * 启动一次应用注册，等拿到创建链接就返回（注册本身在后台继续轮询）。
 *
 * 调用前必须已经建好会话（状态 starting）；这里只负责：
 *   - 拿到链接 → 置 pending
 *   - 8 秒没链接 / 提前失败 → 置 failed 并返回可读原因
 *   - 注册完成 → `finishRegistration()` 收尾
 *
 * 后台 Promise 不 await：Next.js 单实例常驻进程里它会继续跑完
 * （部署方式是 Docker 单实例，见 docs/DEPLOYMENT.md）。
 */
export async function startAppRegistration(
  sessionId: string
): Promise<StartAppRegistrationResult> {
  const abortController = new AbortController();
  /** 拿到链接超时 / 会话失效后置 true：忽略迟到的注册结果 */
  let discardResult = false;

  // Promise 的 resolve 先声明再在 executor 里赋值（definite assignment 断言：
  // executor 是同步执行的，拿到的 Promise.race 之前一定已经赋值）
  let resolveQrReady!: (info: QrReady) => void;
  let qrReadyResolved = false;
  const qrReady = new Promise<QrReady>((resolve) => {
    resolveQrReady = resolve;
  });

  let resolveEarlyFailure!: (failure: RegistrationFailure) => void;
  const earlyFailure = new Promise<RegistrationFailure>((resolve) => {
    resolveEarlyFailure = resolve;
  });

  const registration = (async () => {
    try {
      const result = await lark.registerApp({
        createOnly: true,
        source: REGISTRATION_SOURCE,
        signal: abortController.signal,
        appPreset: { ...APP_PRESET },
        addons: {
          preset: APP_ADDONS.preset,
          scopes: { tenant: [...APP_ADDONS.scopes.tenant] },
        },
        onQRCodeReady: (info) => {
          if (qrReadyResolved) return;
          qrReadyResolved = true;
          resolveQrReady({ kind: "ready", url: info.url, expireIn: info.expireIn });
        },
        onStatusChange: (info) => {
          // 只记状态，不带 device_code / 凭证
          console.info("[setup] 飞书注册轮询状态", info.status);
        },
      });

      if (discardResult) return;
      await finishRegistration(sessionId, result);
    } catch (error) {
      if (discardResult) return;
      const message = describeFeishuError(error);
      markSessionFailed(sessionId, message);
      console.error("[setup] 飞书应用创建失败", message);
      resolveEarlyFailure({ kind: "failure", message });
    }
  })();
  // 后台跑：start 路由只等「链接就绪 / 提前失败 / 超时」三选一
  void registration;

  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), QR_READY_TIMEOUT_MS);
  });

  const ready = await Promise.race<QrReady | RegistrationFailure | null>([
    qrReady,
    earlyFailure,
    timeout,
  ]);
  if (timer !== null) clearTimeout(timer);

  // 8 秒内没有链接：会话置 failed，并中止 SDK 的轮询
  if (ready === null) {
    discardResult = true;
    abortController.abort();
    const message = `飞书在 ${QR_READY_TIMEOUT_MS / 1000} 秒内没有返回创建链接，请稍后重试`;
    markSessionFailed(sessionId, message);
    console.error("[setup] 获取飞书应用创建链接超时");
    return { ok: false, message };
  }

  if (ready.kind === "failure") {
    return { ok: false, message: ready.message };
  }

  const sessionTtlSeconds = SETUP_SESSION_TTL_MS / 1000;
  const expireInSeconds =
    Number.isFinite(ready.expireIn) && ready.expireIn > 0
      ? Math.min(ready.expireIn, sessionTtlSeconds)
      : sessionTtlSeconds;

  const pending = markSessionPending(
    sessionId,
    ready.url,
    expireInSeconds * 1000
  );
  if (!pending) {
    // 会话在拿到链接前就失效了（正常不会发生）：中止注册，不留后台任务
    discardResult = true;
    abortController.abort();
    const message = "创建会话已失效，请重新发起";
    console.error("[setup] 拿到创建链接时会话已失效");
    return { ok: false, message };
  }

  return {
    ok: true,
    verificationUrl: ready.url,
    expiresAt: pending.expiresAt,
  };
}
