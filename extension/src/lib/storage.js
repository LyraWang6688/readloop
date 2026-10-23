export const DEFAULT_API_BASE_URL = "https://readinsight.bamamei.online";
export const DEFAULT_USER_ID = "local-dev-user";

export async function getSettings() {
  const stored = await chrome.storage.sync.get(["apiBaseUrl", "userId"]);
  return {
    apiBaseUrl: normalizeApiBaseUrl(stored.apiBaseUrl || DEFAULT_API_BASE_URL),
    userId: (stored.userId || DEFAULT_USER_ID).trim(),
  };
}

export async function saveSettings(settings) {
  await chrome.storage.sync.set({
    apiBaseUrl: normalizeApiBaseUrl(settings.apiBaseUrl || DEFAULT_API_BASE_URL),
    userId: (settings.userId || DEFAULT_USER_ID).trim(),
  });
}

export function normalizeApiBaseUrl(value) {
  return String(value || DEFAULT_API_BASE_URL).trim().replace(/\/+$/, "");
}
