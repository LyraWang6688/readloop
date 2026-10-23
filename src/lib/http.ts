/**
 * HTTP 层公共件：响应信封、鉴权、请求体解析。
 *
 * 信封沿用项目既有格式（`src/types/index.ts` 的 ApiResponse）：
 *   成功 { success: true, data }
 *   失败 { success: false, error: { code, message, details? } }
 *
 * 鉴权（见 docs/API_IMPLEMENTATION.md §2）：
 *   除 /api/license/activate 与插件配对取凭证外，所有接口都要求
 *   `Authorization: Bearer <host_token>`；到期返回 402，凭证不对返回 401。
 */

import { NextResponse } from "next/server";
import type { ApiResponse } from "@/types";
import { decodePayload, type HostTokenPayload } from "./token";

export type ApiErrorCode =
  | "INVALID_PARAMS"
  | "MODEL_CONFIG_INVALID"
  | "LICENSE_INVALID"
  | "HOST_TOKEN_INVALID"
  | "LICENSE_EXPIRED"
  | "QUESTION_INVALID"
  | "POINTS_EMPTY"
  | "POINTS_INVALID"
  | "SETUP_SESSION_NOT_FOUND"
  | "SETUP_SESSION_EXPIRED"
  | "SETUP_PAIR_CODE_INVALID"
  | "SETUP_FAILED"
  | "RATE_LIMITED"
  | "SERVICE_MISCONFIGURED"
  | "SERVICE_UNAVAILABLE"
  | "INTERNAL_ERROR";

export function jsonOk<T>(data: T, status: number = 200): NextResponse {
  const body: ApiResponse<T> = { success: true, data };
  return NextResponse.json(body, { status });
}

export function jsonError(
  status: number,
  code: ApiErrorCode,
  message: string,
  details?: string
): NextResponse {
  const body: ApiResponse<never> = {
    success: false,
    error: { code, message, ...(details ? { details } : {}) },
  };
  return NextResponse.json(body, { status });
}

/** 服务端缺少必需的环境变量：这是部署问题，不要伪装成用户错误 */
export class ServerConfigError extends Error {
  constructor(public readonly variable: string) {
    super(`缺少服务端环境变量：${variable}`);
  }
}

/** 读取必需的服务端密钥 */
export function requireSecret(name: string): string {
  const value = process.env[name];
  if (!value || value === "change-me") {
    throw new ServerConfigError(name);
  }
  return value;
}

/** 从请求头取 Bearer token */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

export interface HostAuth {
  license: string;
  /** host_token 到期时间（UTC 毫秒） */
  expiresAt: number;
}

export type HostGuard =
  | { ok: true; auth: HostAuth }
  | { ok: false; response: NextResponse };

/**
 * 校验宿主身份。任一路由处理函数的第一件事。
 *
 * - 缺 token / 签名不对 / 格式不对 → 401
 * - 到期 → 402（Skill 据此提示续费，数据不动）
 * - 服务端没配 LICENSE_SECRET → 503（部署问题）
 */
export function requireHost(
  request: Request,
  nowMs: number = Date.now()
): HostGuard {
  const token = bearerToken(request);
  if (!token) {
    return {
      ok: false,
      response: jsonError(401, "HOST_TOKEN_INVALID", "缺少 host_token，请先完成激活"),
    };
  }

  let secret: string;
  try {
    secret = requireSecret("LICENSE_SECRET");
  } catch (error) {
    if (error instanceof ServerConfigError) {
      return {
        ok: false,
        response: jsonError(
          503,
          "SERVICE_MISCONFIGURED",
          "服务端未配置授权密钥，暂时不可用",
          `缺少环境变量 ${error.variable}`
        ),
      };
    }
    throw error;
  }

  const decoded = decodePayload<HostTokenPayload>(token, secret, nowMs);
  if (!decoded.ok) {
    if (decoded.reason === "expired") {
      return {
        ok: false,
        response: jsonError(
          402,
          "LICENSE_EXPIRED",
          "年度授权已到期，续费后重新激活即可继续（数据不受影响）"
        ),
      };
    }
    return {
      ok: false,
      response: jsonError(401, "HOST_TOKEN_INVALID", "host_token 无效，请重新激活"),
    };
  }

  const payload = decoded.payload;
  if (
    payload.v !== 1 ||
    typeof payload.lic !== "string" ||
    typeof payload.exp !== "number"
  ) {
    return {
      ok: false,
      response: jsonError(401, "HOST_TOKEN_INVALID", "host_token 无效，请重新激活"),
    };
  }

  return { ok: true, auth: { license: payload.lic, expiresAt: payload.exp } };
}

/** 解析 JSON 请求体；空体或坏 JSON 返回 null 由调用方给 400 */
export async function readJsonBody<T = unknown>(
  request: Request
): Promise<T | null> {
  try {
    const body = (await request.json()) as T;
    if (!body || typeof body !== "object") return null;
    return body;
  } catch {
    return null;
  }
}

/** 把异常收敛成 5xx，避免把内部错误细节直接抛给客户端 */
export function internalError(error: unknown, context: string): NextResponse {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[${context}] ${message}`);
  return jsonError(500, "INTERNAL_ERROR", "服务异常，请稍后重试");
}
