/**
 * POST /api/review/submit
 *
 * 提交一题：验签 question_id → 确定性判分 → 算新状态 → 返回 updates
 * （见 docs/API_IMPLEMENTATION.md §五）。服务端无状态、可幂等重放。
 *
 * 鉴权：requireHost()，缺 token / 无效 → 401，年度授权到期 → 402。
 */

import {
  internalError,
  jsonError,
  jsonOk,
  readJsonBody,
  requireHost,
  requireSecret,
  ServerConfigError,
} from "@/lib/http";
import { orchestrateSubmit } from "@/lib/review";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const guard = requireHost(request);
    if (!guard.ok) return guard.response;

    const body = await readJsonBody<unknown>(request);
    if (!body) {
      return jsonError(400, "INVALID_PARAMS", "请求体必须是 JSON 对象");
    }

    let questionSecret: string;
    try {
      questionSecret = requireSecret("QUESTION_ID_SECRET");
    } catch (error) {
      if (error instanceof ServerConfigError) {
        return jsonError(
          503,
          "SERVICE_MISCONFIGURED",
          "服务端未配置题目签名密钥，暂时不可用",
          `缺少环境变量 ${error.variable}`
        );
      }
      throw error;
    }

    const result = orchestrateSubmit(body, questionSecret);
    if (!result.ok) {
      return jsonError(result.status, result.code, result.message, result.details);
    }
    return jsonOk(result.data);
  } catch (error) {
    return internalError(error, "review/submit");
  }
}
