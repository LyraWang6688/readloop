/**
 * ReadLoop 服务端接口封装（插件侧唯一出网入口）。
 *
 * 约定（见 docs/API_IMPLEMENTATION.md §1）：
 * - 响应信封：{ success: true, data } / { success: false, error: { code, message, details } }
 * - 除配对 GET 外，所有请求带 Authorization: Bearer <host_token>
 * - 401 = 授权无效，402 = 年度授权到期（提示用户续费，不要动数据）
 *
 * 所有失败都抛 ApiError，message/hint 是给用户看的中文；调用方直接展示 describeApiError(error)。
 */

import { getSettings, normalizeApiBaseUrl } from "./storage.js";

const DIAGNOSE_TIMEOUT_MS = 120_000;
const PAIR_TIMEOUT_MS = 15_000;

export class ApiError extends Error {
  constructor(message, { status = 0, code = "", detail = "", hint = "" } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.hint = hint;
  }
}

/** 把 ApiError 拼成一段可直接展示给用户的中文 */
export function describeApiError(error) {
  if (error instanceof ApiError) {
    return error.hint ? `${error.message}\n${error.hint}` : error.message;
  }
  return error?.message || "发生未知错误，请稍后重试。";
}

/**
 * 翻译诊断：POST {baseUrl}/api/diagnose
 * 模型配置（BYOK）随请求体上传，服务端不保存。
 */
export async function diagnoseSelection({ articleId, paragraphId, selectedText, userTranslation }) {
  const settings = await getSettings();
  const model = settings.model;

  if (!model.baseUrl || !model.model || !model.apiKey) {
    throw new ApiError("还没有配置模型（BYOK），无法请求 AI 诊断", {
      hint: "到「设置 → 模型」填写 base_url / 模型名 / API Key，默认推荐 DeepSeek（https://api.deepseek.com/v1 + deepseek-chat）。",
    });
  }

  const data = await requestJson("/api/diagnose", {
    method: "POST",
    auth: true,
    timeoutMs: DIAGNOSE_TIMEOUT_MS,
    body: {
      articleId,
      paragraphId,
      originalParagraph: selectedText,
      userTranslation,
      model: {
        provider: model.provider || undefined,
        base_url: model.baseUrl,
        model: model.model,
        api_key: model.apiKey,
      },
    },
  });

  return normalizeDiagnosis(data);
}

/**
 * 配对第二步（宿主侧调用，插件只做兜底导出）：POST /api/setup/app/pair
 * body { session, code }，需要 host_token。
 */
export async function bindPairing({ session, code }) {
  return requestJson("/api/setup/app/pair", {
    method: "POST",
    auth: true,
    timeoutMs: PAIR_TIMEOUT_MS,
    body: { session, code },
  });
}

/**
 * 配对第一步（插件侧轮询）：GET /api/setup/app/pair?code=CODE（无需鉴权）
 * - 还没被宿主绑定 / 凭证已被取走 → 返回 null（调用方继续轮询或提示）
 * - 命中 → 返回 { appId, appSecret, appToken }，服务端只给一次
 * - 429 / 其它错误 → 抛 ApiError
 */
export async function getPairingCredentials(code) {
  const normalizedCode = String(code || "").trim();
  if (!/^\d{6}$/.test(normalizedCode)) {
    throw new ApiError("配对码格式不对（应为 6 位数字）", {
      hint: "请重新点击「生成配对码」。",
    });
  }

  try {
    const data = await requestJson(`/api/setup/app/pair?code=${encodeURIComponent(normalizedCode)}`, {
      method: "GET",
      timeoutMs: PAIR_TIMEOUT_MS,
    });

    const appId = readText(data?.app_id);
    const appSecret = readText(data?.app_secret);
    const appToken = readText(data?.app_token);

    if (!appId || !appSecret) {
      throw new ApiError("配对接口返回的凭证不完整", {
        hint: "请在 AI 宿主里重新发起一次「一键配置」，再重新生成配对码。",
      });
    }

    return { appId, appSecret, appToken };
  } catch (error) {
    // 404 = 配对码还没被宿主绑定（或已被取走），不是错误，交给调用方继续轮询
    if (error instanceof ApiError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

// ---------- 内部实现 ----------

async function requestJson(path, { method = "GET", body, auth = false, timeoutMs = DIAGNOSE_TIMEOUT_MS } = {}) {
  const settings = await getSettings();
  const baseUrl = normalizeApiBaseUrl(settings.apiBaseUrl);
  const url = `${baseUrl}${path}`;

  const headers = { Accept: "application/json" };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (auth) {
    if (!settings.hostToken) {
      throw new ApiError("还没有填写 host_token，接口无法鉴权", {
        hint: "把 AI 宿主初始化时拿到的 host_token 填进「设置 → ReadLoop 服务」；没有它所有接口都会返回 401。",
      });
    }
    headers.Authorization = `Bearer ${settings.hostToken}`;
  }

  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: createTimeoutSignal(timeoutMs),
    });
  } catch (error) {
    throw toNetworkError(error, baseUrl);
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (response.ok && payload?.success === true) {
    return payload.data;
  }

  throw mapResponseError(response.status, payload, path);
}

function createTimeoutSignal(timeoutMs) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(timeoutMs);
  }
  return undefined;
}

function toNetworkError(error, baseUrl) {
  if (error?.name === "TimeoutError" || error?.name === "AbortError") {
    return new ApiError("请求超时，服务没有在约定时间内返回", {
      detail: error?.message || "",
      hint: `请稍后重试；如果一直超时，先确认服务地址「${baseUrl}」可以访问。`,
    });
  }
  return new ApiError("连不上 ReadLoop 服务", {
    detail: error?.message || String(error),
    hint:
      `请检查服务地址「${baseUrl}」是否正确、服务是否已启动。` +
      "本地测试要填 http://localhost:3000；如果换成了自定义域名，还需要把它加到 manifest.json 的 host_permissions 里。",
  });
}

function mapResponseError(status, payload, path) {
  const serverError = payload?.error;
  const serverMessage = typeof serverError === "string" ? serverError : readText(serverError?.message);
  const code = typeof serverError === "object" && serverError ? readText(serverError.code) : "";
  const detail = typeof serverError === "object" && serverError ? readText(serverError.details) : "";
  const suffix = serverMessage ? `（服务端：${serverMessage}）` : "";

  switch (status) {
    case 400:
      return new ApiError(`请求参数有误${suffix}`, {
        status,
        code,
        detail,
        hint: "请检查模型配置（base_url / 模型名 / API Key）与译文是否填写完整后重试。",
      });
    case 401:
      return new ApiError("host_token 无效或已过期，服务拒绝了本次请求", {
        status,
        code,
        detail,
        hint: "请到 AI 宿主里重新激活一次授权码拿到新的 host_token，再填进「设置 → ReadLoop 服务」。",
      });
    case 402:
      return new ApiError("年度授权已到期，暂时无法调用 ReadLoop 服务", {
        status,
        code,
        detail,
        hint: "续费后重新激活即可继续使用。你的数据都在自己的飞书表格里，不需要重装插件，也不要去动表格。",
      });
    case 403:
      return new ApiError(`服务拒绝了本次请求${suffix}`, {
        status,
        code,
        detail,
        hint: "如果刚刚续费，请重新激活；如果一直出现，请把这条错误告诉 ReadLoop 维护者。",
      });
    case 404:
      return new ApiError(`接口不存在（404）${suffix}`, {
        status,
        code,
        detail,
        hint: `请确认服务地址是否正确，以及服务版本是否支持 ${path}。`,
      });
    case 410:
      return new ApiError("创建会话已过期", {
        status,
        code,
        detail,
        hint: "请在 AI 宿主里重新发起一次「一键配置」，然后回到插件重新生成配对码。",
      });
    case 422:
      return new ApiError(`服务端校验没通过${suffix}`, {
        status,
        code,
        detail,
        hint: "这通常意味着表格字段或数据不完整，请确认表格是从 ReadLoop 模板复制的。",
      });
    case 429:
      return new ApiError("请求太频繁，已被限流", {
        status,
        code,
        detail,
        hint: "请等 30 秒再试；配对码连续失败次数过多时，请重新生成配对码。",
      });
    case 500:
    case 502:
    case 503:
    case 504:
      return new ApiError(`ReadLoop 服务暂时异常（${status}）${suffix}`, {
        status,
        code,
        detail,
        hint: "请稍后重试；连续失败请把这条错误告诉维护者。",
      });
    default:
      return new ApiError(`请求失败（HTTP ${status}）${suffix}`, {
        status,
        code,
        detail,
        hint: "请稍后重试；如果一直失败，请把这条错误告诉维护者。",
      });
  }
}

function normalizeDiagnosis(data) {
  const analysis = data?.analysis || {};
  const points = Array.isArray(data?.knowledgePoints) ? data.knowledgePoints : [];

  return {
    aiTranslation: readText(data?.aiTranslation),
    analysis: {
      correct: Array.isArray(analysis.correct) ? analysis.correct : [],
      alternative: Array.isArray(analysis.alternative) ? analysis.alternative : [],
      missed: Array.isArray(analysis.missed) ? analysis.missed : [],
    },
    knowledgePoints: points
      .map((point) => ({
        content: readText(point?.content),
        type: readText(point?.type) || "word",
        meaning: readText(point?.meaning),
        explanation: readText(point?.explanation),
        example: readText(point?.example),
      }))
      .filter((point) => point.content),
  };
}

function readText(value) {
  return typeof value === "string" ? value.trim() : "";
}
