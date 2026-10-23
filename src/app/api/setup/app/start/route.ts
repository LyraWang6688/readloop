/**
 * POST /api/setup/app/start —— 发起「一键创建用户自己的飞书应用」。
 *
 * 契约见 docs/API_IMPLEMENTATION.md §6：
 *   请求 { app_token }（用户多维表格链接里 /base/ 后面那一段）
 *   返回 { session, verification_url, expires_at }
 *
 * 鉴权：requireHost()（Authorization: Bearer <host_token>）。
 * 创建本身在后台继续（8 秒内拿到链接就返回），宿主随后轮询 /status。
 */

import {
  jsonError,
  jsonOk,
  readJsonBody,
  requireHost,
} from "@/lib/http";
import { formatExpiryIso } from "@/lib/token";
import { startAppRegistration } from "@/lib/feishu/registration";
import {
  cleanupSetupSessions,
  createSetupSession,
} from "@/lib/feishu/session-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 多维表格 app_token 形如 `bascnCMII2ORej2RItqpZZUNMIe`，只接受纯字母数字 */
const APP_TOKEN_PATTERN = /^[A-Za-z0-9]{8,128}$/;

interface StartBody {
  app_token?: unknown;
}

function normalizeAppToken(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const token = raw.trim();
  return APP_TOKEN_PATTERN.test(token) ? token : null;
}

export async function POST(request: Request) {
  const guard = requireHost(request);
  if (!guard.ok) return guard.response;

  try {
    const body = await readJsonBody<StartBody>(request);
    const appToken = normalizeAppToken(body?.app_token);
    if (!appToken) {
      return jsonError(
        400,
        "INVALID_PARAMS",
        "缺少 app_token，或格式不对：请传多维表格链接里 /base/ 后面那一段（形如 bascn…），不要传整条链接"
      );
    }

    // 顺手清掉过期会话，避免进程内 Map 长期增长
    cleanupSetupSessions();

    const session = createSetupSession(appToken);
    const started = await startAppRegistration(session.id);
    if (!started.ok) {
      return jsonError(503, "SETUP_FAILED", started.message);
    }

    const response = jsonOk({
      session: session.id,
      verification_url: started.verificationUrl,
      expires_at: formatExpiryIso(started.expiresAt),
    });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    console.error(
      "[setup] 发起创建失败：",
      error instanceof Error ? error.name : "UnknownError"
    );
    return jsonError(500, "INTERNAL_ERROR", "服务异常，请稍后重试");
  }
}
