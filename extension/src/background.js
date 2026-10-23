/**
 * ReadLoop MV3 service worker：右键菜单 / 打开侧边栏 / 选区消息路由。
 *
 * MV3 生命周期约束（官方文档 + sample.sidepanel-dictionary 的做法）：
 * - service worker 空闲约 30 秒会被回收，**不能用模块级变量保存状态**；
 * - 选区因此存 `chrome.storage.session`（浏览器会话内有效、SW 重启不丢；
 *   侧边栏通过 `storage.session.onChanged` 或主动拉取恢复，不会出现「选了词但面板空着」）；
 * - 监听器全部在顶层同步注册，回调里才做异步工作；type: module 下不用顶层 await。
 *
 * 写飞书表格在侧边栏页面里完成（那里有 DOM 和完整权限），这里只做路由。
 */

const CONTEXT_MENU_ID = "readloop-practice-selection";
/** 每个 tab 一条选区：`selection:<tabId>` */
const SELECTION_KEY_PREFIX = "selection:";
/** 当前激活的 tabId；用于 SW 重启后仍能回答「当前选区是什么」 */
const ACTIVE_TAB_KEY = "activeTabId";

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
  // 监听器保持同步注册，异步工作在函数内部完成
  void handleTabActivated(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void handleTabRemoved(tabId);
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  void handleContextMenuClick(info, tab);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "READINSIGHT_SELECTION_CHANGED") {
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false });
      return false;
    }
    rememberSelection(tabId, message.payload)
      .then((selection) => {
        broadcastSelection(selection);
        sendResponse({ ok: true });
      })
      .catch(() => sendResponse({ ok: false }));
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

// ---------- 右键菜单 ----------

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

async function handleContextMenuClick(info, tab) {
  if (info.menuItemId !== CONTEXT_MENU_ID || !tab?.id) {
    return;
  }

  const tabId = tab.id;
  // info.selectionText 是菜单点选时的选区；URL/标题可能因权限拿不到，先用可用值占位
  await rememberSelection(tabId, {
    selectedText: info.selectionText || "",
    pageUrl: tab.url || "",
    pageTitle: tab.title || "",
    capturedAt: Date.now(),
  });

  await openSidePanel(tabId);

  // 右键点击本身授予了 activeTab：再从 content script 拉一次权威的 URL/标题/选区，
  // 补上 tab.url 在非 host_permissions 页面拿不到的空缺。
  await requestSelectionFromTab(tabId);
}

// ---------- 选区状态（storage.session） ----------

function selectionKey(tabId) {
  return `${SELECTION_KEY_PREFIX}${tabId}`;
}

function normalizeSelection(payload) {
  return {
    selectedText: (payload?.selectedText || "").trim(),
    pageUrl: payload?.pageUrl || "",
    pageTitle: payload?.pageTitle || "",
    capturedAt: payload?.capturedAt || Date.now(),
  };
}

async function rememberSelection(tabId, payload) {
  const selection = normalizeSelection(payload);
  await chrome.storage.session.set({
    [selectionKey(tabId)]: selection,
    [ACTIVE_TAB_KEY]: tabId,
  });
  return selection;
}

async function readSelection(tabId) {
  const stored = await chrome.storage.session.get(selectionKey(tabId));
  const selection = stored[selectionKey(tabId)];
  return selection && typeof selection === "object" ? selection : null;
}

async function readActiveTabId() {
  const stored = await chrome.storage.session.get(ACTIVE_TAB_KEY);
  const tabId = stored[ACTIVE_TAB_KEY];
  return typeof tabId === "number" ? tabId : null;
}

// ---------- tab 生命周期 ----------

async function handleTabActivated(tabId) {
  await chrome.storage.session.set({ [ACTIVE_TAB_KEY]: tabId });
  const stored = await readSelection(tabId);
  if (stored) {
    broadcastSelection(stored);
    return;
  }
  // 这个 tab 还没有选区记录（比如 SW 重启后又切回来）：向页面要一次
  await requestSelectionFromTab(tabId);
}

async function handleTabRemoved(tabId) {
  await chrome.storage.session.remove(selectionKey(tabId));
  const activeTabId = await readActiveTabId();
  if (activeTabId === tabId) {
    await chrome.storage.session.remove(ACTIVE_TAB_KEY);
  }
}

// ---------- 侧边栏 / 选区读取 ----------

function broadcastSelection(selection) {
  if (!selection) {
    return;
  }
  chrome.runtime
    .sendMessage({ type: "READINSIGHT_SELECTION_UPDATED", payload: selection })
    .catch(() => {
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

/**
 * 当前选区。
 *
 * 优先读 storage.session；没有记录时向 content script 要一次
 * （覆盖「点图标打开侧边栏」——此时 panel 自己会发 GET，而 SW 里没有任何缓存）。
 */
async function getActiveSelection({ refreshIfMissing = true } = {}) {
  const tabId = (await readActiveTabId()) ?? (await getCurrentTabId());
  if (!tabId) {
    return emptySelection();
  }

  const stored = await readSelection(tabId);
  if (stored) {
    return stored;
  }

  if (refreshIfMissing) {
    await requestSelectionFromTab(tabId);
    const refreshed = await readSelection(tabId);
    if (refreshed) {
      return refreshed;
    }
  }
  return emptySelection();
}

async function refreshActiveSelection() {
  const tabId = (await readActiveTabId()) ?? (await getCurrentTabId());
  if (!tabId) {
    return emptySelection();
  }
  await requestSelectionFromTab(tabId);
  return (await readSelection(tabId)) ?? emptySelection();
}

async function requestSelectionFromTab(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "READINSIGHT_GET_SELECTION" });
    if (response?.selection) {
      const selection = await rememberSelection(tabId, response.selection);
      broadcastSelection(selection);
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
