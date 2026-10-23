export function buildWebArticleId(pageUrl) {
  return `web_${hashText(pageUrl || "unknown-page")}`;
}

export function buildWebParagraphId(pageUrl, selectedText) {
  return `web_${hashText(`${pageUrl || "unknown-page"}::${selectedText || ""}`)}`;
}

function hashText(input) {
  let hash = 2166136261;
  const text = String(input);

  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(36);
}
