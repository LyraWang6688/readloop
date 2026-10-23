/**
 * 插件设置读写。
 *
 * 存储分工（重要）：
 * - 密钥（host_token / 模型 API Key / 飞书 App Secret / 配对时间）只写 chrome.storage.local，
 *   不放进 chrome.storage.sync——sync 会把内容同步到用户的 Google 账号云端。
 * - 非敏感的配置（服务地址、模型名称、App ID、app_token）放 chrome.storage.sync，换机器不用重填。
 */

export const DEFAULT_API_BASE_URL = "https://readinsight.bamamei.online";

/** 默认推荐 DeepSeek（BYOK），与 docs/ARCHITECTURE.md §5.5 一致 */
export const DEFAULT_MODEL = {
  provider: "deepseek",
  baseUrl: "https://api.deepseek.com/v1",
  model: "deepseek-chat",
};

const SYNC_KEYS = [
  "apiBaseUrl",
  "modelProvider",
  "modelBaseUrl",
  "modelName",
  "feishuAppId",
  "feishuAppToken",
];

const LOCAL_KEYS = ["hostToken", "modelApiKey", "feishuAppSecret", "pairedAt"];

/** 读取全部设置；缺失项用默认值补齐，不抛错 */
export async function getSettings() {
  const [syncStored, localStored] = await Promise.all([
    chrome.storage.sync.get(SYNC_KEYS),
    chrome.storage.local.get(LOCAL_KEYS),
  ]);

  return {
    apiBaseUrl: normalizeApiBaseUrl(syncStored.apiBaseUrl),
    hostToken: readString(localStored.hostToken),
    model: {
      provider: readString(syncStored.modelProvider) || DEFAULT_MODEL.provider,
      baseUrl: readString(syncStored.modelBaseUrl) || DEFAULT_MODEL.baseUrl,
      model: readString(syncStored.modelName) || DEFAULT_MODEL.model,
      apiKey: readString(localStored.modelApiKey),
    },
    feishu: {
      appId: readString(syncStored.feishuAppId),
      appSecret: readString(localStored.feishuAppSecret),
      appToken: readString(syncStored.feishuAppToken),
      pairedAt: Number(localStored.pairedAt) || 0,
    },
  };
}

/**
 * 保存设置。只写传入的字段（undefined 表示不改），密钥落到 local，其余落到 sync。
 */
export async function saveSettings(input = {}) {
  const syncPatch = {};
  const localPatch = {};

  if (input.apiBaseUrl !== undefined) {
    syncPatch.apiBaseUrl = normalizeApiBaseUrl(input.apiBaseUrl);
  }
  if (input.model !== undefined) {
    const model = input.model || {};
    if (model.provider !== undefined) syncPatch.modelProvider = readString(model.provider);
    if (model.baseUrl !== undefined) syncPatch.modelBaseUrl = readString(model.baseUrl).replace(/\/+$/, "");
    if (model.model !== undefined) syncPatch.modelName = readString(model.model);
    if (model.apiKey !== undefined) localPatch.modelApiKey = readString(model.apiKey);
  }
  if (input.feishu !== undefined) {
    const feishu = input.feishu || {};
    if (feishu.appId !== undefined) syncPatch.feishuAppId = readString(feishu.appId);
    if (feishu.appToken !== undefined) syncPatch.feishuAppToken = readString(feishu.appToken);
    if (feishu.appSecret !== undefined) localPatch.feishuAppSecret = readString(feishu.appSecret);
  }
  if (input.hostToken !== undefined) {
    localPatch.hostToken = readString(input.hostToken);
  }

  const writes = [];
  if (Object.keys(syncPatch).length > 0) {
    writes.push(chrome.storage.sync.set(syncPatch));
  }
  if (Object.keys(localPatch).length > 0) {
    writes.push(chrome.storage.local.set(localPatch));
  }
  await Promise.all(writes);
}

/** 配对成功后一次性写入飞书凭证（App Secret 只进 local） */
export async function savePairedFeishuApp({ appId, appSecret, appToken }) {
  await Promise.all([
    chrome.storage.sync.set({
      feishuAppId: readString(appId),
      feishuAppToken: readString(appToken),
    }),
    chrome.storage.local.set({
      feishuAppSecret: readString(appSecret),
      pairedAt: Date.now(),
    }),
  ]);
}

export function normalizeApiBaseUrl(value) {
  const text = readString(value) || DEFAULT_API_BASE_URL;
  return text.replace(/\/+$/, "");
}

/**
 * 从多维表格链接里解析 app_token。
 * 支持：
 * - https://xxx.feishu.cn/base/<app_token>?table=tbl…
 * - https://xxx.feishu.cn/app/<app_token>
 * - 直接粘贴 app_token（不含 "://" 时）
 * 解析不出来返回空串，由调用方给出可读提示。
 */
export function parseAppToken(input) {
  const raw = readString(input);
  if (!raw) {
    return "";
  }

  // 直接填 app_token 的情况
  if (!/^https?:\/\//i.test(raw)) {
    return /^[A-Za-z0-9_-]{8,}$/.test(raw) ? raw : "";
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    return "";
  }

  const fromQuery = readString(url.searchParams.get("app_token"));
  if (fromQuery) {
    return fromQuery;
  }

  const segments = url.pathname.split("/").filter(Boolean);
  const anchorIndex = segments.findIndex((segment) => segment === "base" || segment === "app");
  if (anchorIndex >= 0 && segments[anchorIndex + 1]) {
    return segments[anchorIndex + 1];
  }

  return "";
}

/** 状态展示用：只露前后各 4 位，避免整段密钥出现在页面上 */
export function maskSecret(value) {
  const text = readString(value);
  if (!text) {
    return "";
  }
  if (text.length <= 8) {
    return "已填写";
  }
  return `${text.slice(0, 4)}…${text.slice(-4)}`;
}

function readString(value) {
  return typeof value === "string" ? value.trim() : "";
}
