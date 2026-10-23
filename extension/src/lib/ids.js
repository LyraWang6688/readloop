/**
 * 本地生成诊断用的 articleId / paragraphId。
 *
 * 服务端目前只把它们原样回传（DiagnoseResponse.paragraphId），不依赖它们做定位；
 * 用页面 URL + 选中文本做稳定哈希，保证同一段原文多次诊断得到同一个 id。
 */

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
