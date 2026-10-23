/**
 * GET /api/setup/app/status?session=…[&reveal_secret=1] —— 轮询一键创建的会话状态。
 *
 * 契约见 docs/API_IMPLEMENTATION.md §7：
 *   pending   → verification_url（等用户在飞书点「同意」）
 *   completed → app_id、checks；**默认不返回 app_secret**
 *   expired   → 会话超过有效期
 *   failed    → error（可读原因）
 *
 * 鉴权：requireHost()。
 *
 * 两个细节：
 *   1. `app_secret` 是**显式开启**的（2026-10-23 Lead 拍板）：默认返回 null——主路径
 *      Secret 由插件用配对码自取，宿主上下文里不该出现；只有带 `&reveal_secret=1`
 *      的兜底手动路径才一次性返回（同样不重复暴露、不销毁凭证）
 *   2. 过期仍返回「成功信封」（宿主按 status 字段判断，见 Store 的 SKILL.md），
 *      但 HTTP 状态码用 410 表达「创建会话已过期」（docs/API_IMPLEMENTATION.md §1.3）
 */

import {
  jsonError,
  jsonOk,
  requireHost,
} from "@/lib/http";
import { formatExpiryIso } from "@/lib/token";
import {
  buildStatusView,
  cleanupSetupSessions,
  readSetupSession,
} from "@/lib/feishu/session-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** `reveal_secret` 只认 1 / true（不区分大小写），其余一律按「不返回 Secret」处理 */
function shouldRevealSecret(raw: string | null): boolean {
  const value = (raw ?? "").trim().toLowerCase();
  return value === "1" || value === "true";
}

export async function GET(request: Request) {
  const guard = requireHost(request);
  if (!guard.ok) return guard.response;

  try {
    cleanupSetupSessions();

    const url = new URL(request.url);
    const sessionId = (url.searchParams.get("session") ?? "").trim();
    if (!sessionId) {
      return jsonError(400, "INVALID_PARAMS", "缺少 session 参数");
    }

    const session = readSetupSession(sessionId);
    if (!session) {
      return jsonError(
        404,
        "SETUP_SESSION_NOT_FOUND",
        "创建会话不存在或已失效，请重新发起"
      );
    }

    const view = buildStatusView(session, {
      revealSecret: shouldRevealSecret(url.searchParams.get("reveal_secret")),
    });
    const response = jsonOk(
      {
        status: view.status,
        verification_url: view.verificationUrl,
        expires_at: formatExpiryIso(view.expiresAt),
        checks: view.checks,
        app_id: view.appId,
        app_secret: view.appSecret,
        error: view.error,
      },
      view.status === "expired" ? 410 : 200
    );
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    console.error(
      "[setup] 查询会话状态失败：",
      error instanceof Error ? error.name : "UnknownError"
    );
    return jsonError(500, "INTERNAL_ERROR", "服务异常，请稍后重试");
  }
}
