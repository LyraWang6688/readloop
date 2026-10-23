/**
 * 内容脚本：只做一件事——把用户在当前页面「划选」的文本、页面 URL 和标题交给扩展。
 *
 * 隐私边界：不读取页面正文、不注入任何 UI、不主动上传；只有用户自己选中文本时才发送。
 */

let lastSelectedText = "";
let notifyTimer = null;

document.addEventListener("mouseup", scheduleSelectionNotification);
document.addEventListener("keyup", scheduleSelectionNotification);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "READINSIGHT_GET_SELECTION") {
    return false;
  }

  sendResponse({ selection: getPageSelection() });
  return true;
});

function scheduleSelectionNotification() {
  if (notifyTimer) {
    clearTimeout(notifyTimer);
  }

  notifyTimer = setTimeout(() => {
    const selection = getPageSelection();
    if (!selection.selectedText || selection.selectedText === lastSelectedText) {
      return;
    }

    lastSelectedText = selection.selectedText;
    chrome.runtime
      .sendMessage({
        type: "READINSIGHT_SELECTION_CHANGED",
        payload: selection,
      })
      .catch(() => {
        // 扩展被重载 / service worker 未就绪时会出现，忽略即可
      });
  }, 150);
}

function getPageSelection() {
  let selectedText = "";
  try {
    selectedText = window.getSelection()?.toString().trim() || "";
  } catch {
    selectedText = "";
  }

  return {
    selectedText,
    pageUrl: window.location.href,
    pageTitle: document.title || window.location.href,
    capturedAt: Date.now(),
  };
}
