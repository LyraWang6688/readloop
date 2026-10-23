const CONTEXT_MENU_ID = "readinsight-practice-selection";

const selectionsByTab = new Map();
let activeTabId = null;

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: CONTEXT_MENU_ID,
    title: "用 ReadLoop 练习这段英文",
    contexts: ["selection"],
  });

  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  }
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  activeTabId = tabId;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  selectionsByTab.delete(tabId);
  if (activeTabId === tabId) {
    activeTabId = null;
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ID || !tab?.id) {
    return;
  }

  activeTabId = tab.id;
  rememberSelection(tab.id, {
    selectedText: info.selectionText || "",
    pageUrl: tab.url || "",
    pageTitle: tab.title || "",
    capturedAt: Date.now(),
  });

  await openSidePanel(tab.id);
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) {
    return;
  }

  activeTabId = tab.id;
  await requestSelectionFromTab(tab.id);
  await openSidePanel(tab.id);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "READINSIGHT_SELECTION_CHANGED") {
    const tabId = sender.tab?.id;
    if (tabId) {
      activeTabId = tabId;
      rememberSelection(tabId, message.payload);
      chrome.runtime.sendMessage({
        type: "READINSIGHT_SELECTION_UPDATED",
        payload: selectionsByTab.get(tabId),
      }).catch(() => {
        // The side panel may not be open. This is expected.
      });
    }
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === "READINSIGHT_GET_ACTIVE_SELECTION") {
    getActiveSelection().then((selection) => sendResponse({ selection }));
    return true;
  }

  if (message?.type === "READINSIGHT_REFRESH_SELECTION") {
    refreshActiveSelection().then((selection) => sendResponse({ selection }));
    return true;
  }

  return false;
});

function rememberSelection(tabId, payload) {
  const selectedText = (payload?.selectedText || "").trim();
  const pageUrl = payload?.pageUrl || "";
  const pageTitle = payload?.pageTitle || "";

  selectionsByTab.set(tabId, {
    selectedText,
    pageUrl,
    pageTitle,
    capturedAt: payload?.capturedAt || Date.now(),
  });
}

async function openSidePanel(tabId) {
  if (!chrome.sidePanel?.open) {
    return;
  }

  await chrome.sidePanel.open({ tabId });
}

async function getActiveSelection() {
  const tabId = activeTabId || (await getCurrentTabId());
  if (!tabId) {
    return emptySelection();
  }

  return selectionsByTab.get(tabId) || emptySelection();
}

async function refreshActiveSelection() {
  const tabId = activeTabId || (await getCurrentTabId());
  if (!tabId) {
    return emptySelection();
  }

  await requestSelectionFromTab(tabId);
  return selectionsByTab.get(tabId) || emptySelection();
}

async function requestSelectionFromTab(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: "READINSIGHT_GET_SELECTION",
    });

    if (response?.selection) {
      rememberSelection(tabId, response.selection);
    }
  } catch {
    // Some pages, such as chrome:// pages, do not allow content scripts.
  }
}

async function getCurrentTabId() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id || null;
}

function emptySelection() {
  return {
    selectedText: "",
    pageUrl: "",
    pageTitle: "",
    capturedAt: Date.now(),
  };
}
