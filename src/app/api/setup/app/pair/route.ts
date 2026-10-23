/**
 * 配对：把一键创建出来的应用凭证交给 Chrome 插件。
 *
 * 为什么不用 host_token：插件在用户浏览器里，没有宿主凭证，也不能让用户手抄 Secret。
 * 所以用一次性的 6 位配对码（docs/API_IMPLEMENTATION.md §8）：
 *
 *   插件「一键配置」：本地生成 6 位码（100000–999999）→ 显示给用户 → 每 3 秒轮询 GET
 *   用户：把 6 位码告诉宿主
 *   宿主：POST { session, code }      ← 只做绑定，拿不到 Secret
 *   插件：下一次 GET 轮询命中 → 拿到 { app_id, app_secret, app_token, host_token }，服务端随即销毁
 *
 * POST：requireHost()；GET：**无需鉴权**（插件没有 host_token）。
 * GET 只允许同一配对码 20 次尝试，超出 429（内存计数，防爆破）。
 */

import {
  bearerToken,
  jsonError,
  jsonOk,
  readJsonBody,
  requireHost,
} from "@/lib/http";
import {
  bindPairCode,
  normalizePairCode,
  takePairCredentials,
} from "@/lib/feishu/session-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PairBindBody {
  session?: unknown;
  code?: unknown;
}

/** POST /api/setup/app/pair —— 宿主把插件给的配对码绑到会话上（不取 Secret） */
export async function POST(request: Request) {
  const guard = requireHost(request);
  if (!guard.ok) return guard.response;

  try {
    const body = await readJsonBody<PairBindBody>(request);
    const sessionId =
      typeof body?.session === "string" ? body.session.trim() : "";
    if (!sessionId) {
      return jsonError(400, "INVALID_PARAMS", "缺少 session（创建应用时返回的那个）");
    }

    const code = normalizePairCode(body?.code);
    if (!code) {
      return jsonError(
        400,
        "INVALID_PARAMS",
        "配对码必须是 6 位数字（插件「一键配置」里显示的那个码）"
      );
    }

    // 宿主调这个接口时带的就是自己的 host_token；顺手交给插件，省掉手填
    const hostToken = bearerToken(request);
    const result = bindPairCode(sessionId, code, Date.now(), hostToken);
    if (!result.ok) {
      switch (result.reason) {
        case "session_not_found":
          return jsonError(404, "SETUP_SESSION_NOT_FOUND", result.message);
        case "session_expired":
          return jsonError(410, "SETUP_SESSION_EXPIRED", result.message);
        default:
          // code_invalid / code_taken / session_not_completed 都是参数或状态不合法
          return jsonError(400, "INVALID_PARAMS", result.message);
      }
    }

    console.info("[setup] 配对码已绑定到创建会话", {
      session: result.session.id,
      appId: result.session.credentials?.appId ?? null,
    });
    return jsonOk({ paired: true });
  } catch (error) {
    console.error(
      "[setup] 配对码绑定失败：",
      error instanceof Error ? error.name : "UnknownError"
    );
    return jsonError(500, "INTERNAL_ERROR", "服务异常，请稍后重试");
  }
}

/** GET /api/setup/app/pair?code=… —— 插件取走一次性凭证（无需鉴权） */
export async function GET(request: Request) {
  try {
    const code = new URL(request.url).searchParams.get("code") ?? "";
    const delivery = takePairCredentials(code);

    if (!delivery.ok) {
      // 同一配对码尝试次数超限：429（防爆破；插件应让用户重新生成配对码）
      if (delivery.reason === "too_many_attempts") {
        return jsonError(429, "RATE_LIMITED", delivery.message);
      }
      // 未绑定 / 码错 / 已过期 / 已取走：对外统一 404，不泄露具体是哪一步
      return jsonError(404, "SETUP_PAIR_CODE_INVALID", delivery.message);
    }

    console.info("[setup] 凭证已通过配对码交付给插件", {
      appId: delivery.appId,
    });

    const response = jsonOk({
      app_id: delivery.appId,
      app_secret: delivery.appSecret,
      app_token: delivery.appToken,
      host_token: delivery.hostToken,
    });
    // 凭证响应绝不能被缓存
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    console.error(
      "[setup] 配对取凭证失败：",
      error instanceof Error ? error.name : "UnknownError"
    );
    return jsonError(500, "INTERNAL_ERROR", "服务异常，请稍后重试");
  }
}
