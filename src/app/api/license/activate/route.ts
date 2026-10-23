/**
 * POST /api/license/activate
 *
 * 用购买时拿到的 8 位授权码换 host_token（见 docs/API_IMPLEMENTATION.md §三）。
 * 这是唯一不需要 host_token 的业务接口。
 *
 * 处理顺序：
 * 1. 请求体与授权码格式 → 400 INVALID_PARAMS
 * 2. 服务端密钥缺失 → 503 SERVICE_MISCONFIGURED（部署问题，不是用户的错）
 * 3. 校验位不对 → 401 LICENSE_INVALID
 * 4. 通过 → 签发年度 host_token，返回 { hostToken, expiresAt }
 *
 * 不记录完整 host_token / 授权码，日志只留授权码前 3 位。
 */

import {
  internalError,
  jsonError,
  jsonOk,
  readJsonBody,
  requireSecret,
  ServerConfigError,
} from "@/lib/http";
import {
  formatExpiryIso,
  isValidLicenseCode,
  normalizeLicenseCode,
  signHostToken,
} from "@/lib/token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await readJsonBody<Record<string, unknown>>(request);
    if (!body) {
      return jsonError(400, "INVALID_PARAMS", "请求体必须是 JSON 对象");
    }

    const rawLicense = body.license;
    if (typeof rawLicense !== "string" || rawLicense.trim() === "") {
      return jsonError(400, "INVALID_PARAMS", "缺少授权码 license");
    }

    const license = normalizeLicenseCode(rawLicense);
    if (!license) {
      return jsonError(
        400,
        "INVALID_PARAMS",
        "授权码格式不对：应为 8 位字母数字（已去掉易混的 0/O/1/I，可带空格或连字符）"
      );
    }

    let secret: string;
    try {
      secret = requireSecret("LICENSE_SECRET");
    } catch (error) {
      if (error instanceof ServerConfigError) {
        return jsonError(
          503,
          "SERVICE_MISCONFIGURED",
          "服务端未配置授权密钥，暂时不可用",
          `缺少环境变量 ${error.variable}`
        );
      }
      throw error;
    }

    if (!isValidLicenseCode(license, secret)) {
      return jsonError(401, "LICENSE_INVALID", "授权码无效，请核对购买时收到的码");
    }

    const { hostToken, expiresAt } = signHostToken(license, Date.now(), secret);
    const expiresAtIso = formatExpiryIso(expiresAt);

    // 只记授权码前缀与到期时间：不落库、不打印完整 token
    console.info("license activated", {
      licensePrefix: license.slice(0, 3),
      expiresAt: expiresAtIso,
    });

    return jsonOk({ hostToken, expiresAt: expiresAtIso });
  } catch (error) {
    return internalError(error, "license/activate");
  }
}
