/**
 * ReadLoop MV3 service worker：右键菜单 / 打开侧边栏 / 选区消息路由。
 *
 * 注意：
 * - service worker 以 type: module 加载，不能用顶层 await；
 * - 选区数据只存在内存里，service worker 休眠即丢，侧边栏会主动再拉一次；
 * - 写飞书表格在侧边栏页面里完成（那里有 DOM 和完整权限），这里只做路由。
 */

const CONTEXT_MENU_ID = "readloop-practice-selection";

/** tabId → { selectedText, pageUrl, pageTitle, capturedAt } */
const selectionsByTab = new Map();
let activeTabId = null;

chrome.runtime.onInstalled.addListener(() => {
  setupContextMenu();

  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {
      // 旧版本 Chrome 没有 sidePanel 时忽略，右键菜单仍可用
    });
  }
});

chrome.runtime.onStartup?.addListener(() => {
  setupContextMenu();
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  activeTabId = tabId;
  const selection = selectionsByTab.get(tabId);
  if (selection) {
    broadcastSelection(selection);
  }
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
  await openSidePanel(tab.id);
  await requestSelectionFromTab(tab.id);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "READINSIGHT_SELECTION_CHANGED") {
    const tabId = sender.tab?.id;
    if (tabId) {
      activeTabId = tabId;
      rememberSelection(tabId, message.payload);
      broadcastSelection(selectionsByTab.get(tabId));
    }
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === "READINSIGHT_GET_ACTIVE_SELECTION") {
    getActiveSelection()
      .then((selection) => sendResponse({ selection }))
      .catch(() => sendResponse({ selection: emptySelection() }));
    return true;
  }

  if (message?.type === "READINSIGHT_REFRESH_SELECTION") {
    refreshActiveSelection()
      .then((selection) => sendResponse({ selection }))
      .catch(() => sendResponse({ selection: emptySelection() }));
    return true;
  }

  return false;
});

function setupContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create(
      {
        id: CONTEXT_MENU_ID,
        title: "用 ReadLoop 练习这段英文",
        contexts: ["selection"],
      },
      () => {
        // 重复创建时 Chrome 会设置 lastError，读取一下即可消除告警
        void chrome.runtime.lastError;
      }
    );
  });
}

function rememberSelection(tabId, payload) {
  selectionsByTab.set(tabId, {
    selectedText: (payload?.selectedText || "").trim(),
    pageUrl: payload?.pageUrl || "",
    pageTitle: payload?.pageTitle || "",
    capturedAt: payload?.capturedAt || Date.now(),
  });
}

function broadcastSelection(selection) {
  if (!selection) {
    return;
  }
  chrome.runtime.sendMessage({ type: "READINSIGHT_SELECTION_UPDATED", payload: selection }).catch(() => {
    // 侧边栏没打开时没有接收方，属于正常情况
  });
}

async function openSidePanel(tabId) {
  if (!chrome.sidePanel?.open) {
    return;
  }
  try {
    await chrome.sidePanel.open({ tabId });
  } catch {
    // 没有用户手势或该标签页不允许时忽略；右键菜单和图标点击本身就是手势
  }
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
    const response = await chrome.tabs.sendMessage(tabId, { type: "READINSIGHT_GET_SELECTION" });
    if (response?.selection) {
      rememberSelection(tabId, response.selection);
      broadcastSelection(selectionsByTab.get(tabId));
    }
  } catch {
    // chrome:// 页面、扩展商店页面等不允许注入 content script
  }
}

async function getCurrentTabId() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0]?.id || null;
  } catch {
    return null;
  }
}

function emptySelection() {
  return {
    selectedText: "",
    pageUrl: "",
    pageTitle: "",
    capturedAt: Date.now(),
  };
}
