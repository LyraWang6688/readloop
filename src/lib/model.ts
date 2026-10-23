/**
 * 用户自带的模型配置（BYOK）。
 *
 * 服务端不保存模型凭证：每次请求由调用方（Skill / 插件）带上来。
 * 因为 base_url 是用户可控的，服务端要拿它发请求，必须先做 SSRF 校验。
 */

export interface ModelConfig {
  /** 供应商标识，仅用于日志与提示，不参与调用 */
  provider?: string;
  /** OpenAI 兼容的 API 根地址，例如 https://api.deepseek.com/v1 */
  base_url: string;
  /** 模型名，例如 deepseek-chat */
  model: string;
  /** 用户的 API Key */
  api_key: string;
}

export class ModelConfigError extends Error {}

const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /\.local$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^0\./,
  /^\[?::1\]?$/,
  /^\[?f[cd][0-9a-f]{2}:/i,
];

function isPrivateHost(hostname: string): boolean {
  return PRIVATE_HOST_PATTERNS.some((re) => re.test(hostname));
}

/**
 * 校验并归一化用户的模型配置。
 *
 * 规则（见 docs/ARCHITECTURE.md §5.5 安全要求）：
 * - 只允许 https
 * - 拒绝回环、内网、链路本地地址
 * - 三个字段都不能为空
 */
export function normalizeModelConfig(input: unknown): ModelConfig {
  if (!input || typeof input !== "object") {
    throw new ModelConfigError("缺少 model 配置");
  }

  const raw = input as Record<string, unknown>;
  const baseUrl = typeof raw.base_url === "string" ? raw.base_url.trim() : "";
  const model = typeof raw.model === "string" ? raw.model.trim() : "";
  const apiKey = typeof raw.api_key === "string" ? raw.api_key.trim() : "";

  if (!baseUrl || !model || !apiKey) {
    throw new ModelConfigError("model 配置不完整：需要 base_url / model / api_key");
  }

  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ModelConfigError("model.base_url 不是合法 URL");
  }

  if (url.protocol !== "https:") {
    throw new ModelConfigError("model.base_url 必须是 https");
  }

  if (isPrivateHost(url.hostname)) {
    throw new ModelConfigError("model.base_url 不允许指向内网或本机地址");
  }

  return {
    provider: typeof raw.provider === "string" ? raw.provider : undefined,
    base_url: baseUrl.replace(/\/+$/, ""),
    model,
    api_key: apiKey,
  };
}
