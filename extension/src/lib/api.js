import { getSettings } from "./storage.js";

export async function diagnoseSelection({ articleId, paragraphId, selectedText, userTranslation }) {
  const { apiBaseUrl } = await getSettings();

  return requestJson(`${apiBaseUrl}/api/diagnose`, {
    articleId,
    paragraphId,
    originalParagraph: selectedText,
    userTranslation,
  });
}

export async function saveKnowledgePoints({
  articleId,
  articleTitle,
  paragraphId,
  points,
}) {
  const { apiBaseUrl, userId } = await getSettings();

  return requestJson(`${apiBaseUrl}/api/knowledge`, {
    articleId,
    articleTitle,
    paragraphId,
    userId,
    points,
  });
}

async function requestJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const result = await response.json().catch(() => null);

  if (!response.ok || !result?.success) {
    const message =
      result?.error?.message ||
      result?.error ||
      `Request failed with status ${response.status}`;
    throw new Error(message);
  }

  return result.data;
}
