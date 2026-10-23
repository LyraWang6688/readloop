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
    chrome.runtime.sendMessage({
      type: "READINSIGHT_SELECTION_CHANGED",
      payload: selection,
    }).catch(() => {
      // The extension context can be unavailable during reloads.
    });
  }, 150);
}

function getPageSelection() {
  return {
    selectedText: window.getSelection()?.toString().trim() || "",
    pageUrl: window.location.href,
    pageTitle: document.title || window.location.href,
    capturedAt: Date.now(),
  };
}
