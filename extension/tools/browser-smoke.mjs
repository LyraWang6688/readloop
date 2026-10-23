/**
 * 真浏览器冒烟测试（开发自查用，不参与插件运行）。
 *
 * 用 headless Chrome（支持 --load-extension 的 Chrome for Testing / Chromium）真实加载 extension/，
 * 并按真实使用顺序把主流程走一遍（用 CDP 拦截网络请求、填假响应，不连任何真实服务）：
 *
 * 1. manifest / 图标 / MV3 service worker 能被 Chrome 接受；
 * 2. 侧边栏页面能执行 main.js，连接状态渲染 5 行；
 * 3. chrome.storage / chrome.runtime / chrome.sidePanel 在真实扩展页面里可用；
 * 4. 设置表单能保存（密钥落到 local、配置落到 sync）；
 * 5. 划词原文 + 译文 → 点诊断 → 展示参考翻译与知识点；
 * 6. 点「一键存入我的飞书表格」→ 走 feishu.js 的 token/表/字段/查重/写入 → 展示入库摘要；
 * 7. 点「生成配对码」→ 轮询 GET pair（先 404 后命中）→ 自动填好飞书凭证。
 *
 * 全程收集控制台错误与未捕获异常，有任何一条就失败。
 *
 * 用法：
 *   node extension/tools/browser-smoke.mjs
 *   CHROME_PATH="/path/to/chrome" node extension/tools/browser-smoke.mjs
 *
 * 找不到可用 Chrome 时打印 SKIP 并 exit 0；加载失败 / 流程失败 / 控制台报错 exit 1。
 * 临时 profile 建在仓库根目录 `.chrome-smoke-profile`（已约定加入 .gitignore，产物不提交），结束时删除。
 * Chrome 启动带 --use-mock-keychain / --password-store=basic，避免 macOS 弹钥匙串授权框。
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSION_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROFILE_DIR = resolve(EXTENSION_DIR, "..", ".chrome-smoke-profile");
const PORT = 9330 + Math.floor(Math.random() * 200);
const MOCK_ORIGIN = "http://127.0.0.1:19999";
// 说明：这个沙箱里的 Chrome 没有外网/本机回环网络，无法加载真实网页来触发 content script；
// 划词链路改为「service worker 广播选区 → 侧边栏更新」，content script 的取值逻辑放在 selftest.mjs 里用 vm 单测。
const ARTICLE_URL = "https://smoke.example/article";
const ARTICLE_TITLE = "Smoke Article";
const ARTICLE_TEXT = "The subsequent chapter explains even though it is hard.";

// ---------- 找 Chrome ----------

function findChrome() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }

  const home = process.env.HOME || "";
  const candidates = [
    "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/chromium",
    "/usr/bin/google-chrome",
  ];

  // Playwright 缓存目录里的 Chromium 版本号会变，兜底扫一遍
  const cacheDir = `${home}/Library/Caches/ms-playwright`;
  if (existsSync(cacheDir)) {
    for (const name of readdirSync(cacheDir)) {
      if (!name.startsWith("chromium-")) {
        continue;
      }
      for (const arch of ["chrome-mac-arm64", "chrome-mac", "chrome-linux"]) {
        const path = `${cacheDir}/${name}/${arch}/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
        if (existsSync(path)) {
          candidates.unshift(path);
        }
      }
    }
  }

  return candidates.find((path) => existsSync(path)) || "";
}

const chromePath = findChrome();
if (!chromePath) {
  console.log("SKIP: 没找到支持 --load-extension 的 Chrome/Chromium，跳过真机冒烟");
  process.exit(0);
}

// ---------- 小工具 ----------

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  return response.json();
}

async function waitFor(description, fn, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(200);
  }
  throw new Error(`等待超时：${description}${lastError ? `（最后错误：${lastError.message}）` : ""}`);
}

class CdpSession {
  constructor(webSocketUrl) {
    this.webSocketUrl = webSocketUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.eventHandlers = new Map();
  }

  async connect() {
    this.socket = new WebSocket(this.webSocketUrl);
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve: resolvePromise, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) {
          reject(new Error(message.error.message));
        } else {
          resolvePromise(message.result);
        }
        return;
      }
      this.events.push(message);
      const handlers = this.eventHandlers.get(message.method) || [];
      for (const handler of handlers) {
        Promise.resolve(handler(message.params)).catch((error) => {
          console.error(`CDP 事件处理失败(${message.method})：${error.message}`);
        });
      }
    });
    await new Promise((resolvePromise, reject) => {
      this.socket.addEventListener("open", resolvePromise);
      this.socket.addEventListener("error", () => reject(new Error("CDP WebSocket 连接失败")));
    });
    return this;
  }

  on(method, handler) {
    const handlers = this.eventHandlers.get(method) || [];
    handlers.push(handler);
    this.eventHandlers.set(method, handlers);
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`CDP 超时：${method}`));
        }
      }, 15000);
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
      throw new Error(`页面脚本异常：${detail}`);
    }
    return result.result.value;
  }

  close() {
    this.socket?.close();
  }
}

const failures = [];
function check(name, condition, extra = "") {
  if (condition) {
    console.log(`✅ ${name}`);
  } else {
    failures.push(name);
    console.error(`❌ ${name}${extra ? `\n   ${extra}` : ""}`);
  }
}

// ---------- 假服务端（CDP Fetch 拦截） ----------

const mock = {
  requests: [],
  pairAttempts: 0,
  knowledgeRecords: [],
  captureRecords: [],
  sequence: 0,
};

const KP_TYPES = {
  知识点: 1,
  归一化内容: 1,
  类型: 3,
  释义: 1,
  解释: 1,
  例句: 1,
  状态: 3,
  间隔天数: 2,
  难度因子: 2,
  连对次数: 2,
  答错次数: 2,
  待练次数: 2,
  暴露次数: 2,
  下次复习: 5,
  最近暴露: 5,
  来源链接: 15,
  来源原句: 1,
};

const CE_TYPES = {
  采集时间: 5,
  页面链接: 15,
  页面标题: 1,
  选中原文: 1,
  我的译文: 1,
  AI参考译文: 1,
  诊断结果: 1,
  抽出的知识点: 1,
  是否新点: 7,
};

function buildFields(typeMap, prefix) {
  return Object.entries(typeMap).map(([name, type], index) => ({
    field_id: `fld_${prefix}_${index}`,
    field_name: name,
    type,
    property:
      type === 3
        ? {
            options: (name === "类型"
              ? ["word", "phrase", "pattern", "comprehension_point"]
              : ["new", "learning", "review", "relearning", "mastered"]
            ).map((option, optionIndex) => ({ id: `opt_${prefix}_${index}_${optionIndex}`, name: option, color: 0 })),
          }
        : undefined,
  }));
}

const FIELDS = {
  tblKp: buildFields(KP_TYPES, "kp"),
  tblCe: buildFields(CE_TYPES, "ce"),
};

function ok(data) {
  return { status: 200, payload: { success: true, data } };
}

function okFeishu(payload) {
  return { status: 200, payload };
}

const DIAGNOSIS = {
  aiTranslation: "后续章节解释了，尽管这很难。",
  analysis: {
    correct: [{ text: "subsequent", feedback: "理解正确" }],
    alternative: [],
    missed: [{ text: "even though", meaning: "尽管", reason: "让步关系漏掉了" }],
  },
  knowledgePoints: [
    { content: "subsequent", type: "word", meaning: "随后的", explanation: "常与 subsequence 混淆", example: "The subsequent chapter…" },
    { content: "even though", type: "phrase", meaning: "尽管", explanation: "让步状语", example: "" },
  ],
  paragraphId: "web_mock",
};

/** 返回 { status, payload } */
function routeMockRequest(url, method, body) {
  if (url.startsWith(`${MOCK_ORIGIN}/api/diagnose`) && method === "POST") {
    return ok(DIAGNOSIS);
  }

  if (url.startsWith(`${MOCK_ORIGIN}/api/setup/app/pair`)) {
    if (method === "GET") {
      mock.pairAttempts += 1;
      if (mock.pairAttempts === 1) {
        return { status: 404, payload: { success: false, error: { code: "SETUP_PAIR_CODE_INVALID", message: "配对码未绑定" } } };
      }
      return ok({
        app_id: "cli_paired_smoke",
        app_secret: "secret_paired_smoke",
        app_token: "bas_paired_smoke",
        host_token: "host_paired_smoke",
      });
    }
    return ok({ paired: true });
  }

  if (url.startsWith("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal")) {
    return okFeishu({ code: 0, msg: "ok", tenant_access_token: "tok_smoke", expire: 7200 });
  }

  const pathname = new URL(url).pathname;

  if (/\/open-apis\/bitable\/v1\/apps\/[^/]+\/tables$/.test(pathname)) {
    return okFeishu({
      code: 0,
      data: {
        items: [
          { table_id: "tblKp", name: "knowledge_points" },
          { table_id: "tblCe", name: "capture_events" },
        ],
        has_more: false,
      },
    });
  }

  const fieldsMatch = pathname.match(/\/tables\/([^/]+)\/fields$/);
  if (fieldsMatch) {
    return okFeishu({ code: 0, data: { items: FIELDS[fieldsMatch[1]] || [], has_more: false } });
  }

  if (/\/tables\/[^/]+\/records\/search$/.test(pathname)) {
    return okFeishu({ code: 0, data: { items: [], has_more: false } });
  }

  const createMatch = pathname.match(/\/tables\/([^/]+)\/records$/);
  if (createMatch) {
    mock.sequence += 1;
    const tableId = createMatch[1];
    const record = { record_id: `rec_${mock.sequence}`, fields: body?.fields || {} };
    (tableId === "tblKp" ? mock.knowledgeRecords : mock.captureRecords).push(record);
    return okFeishu({ code: 0, data: { record } });
  }

  const fieldsUpdate = pathname.match(/\/tables\/[^/]+\/fields\/[^/]+$/);
  if (fieldsUpdate) {
    return okFeishu({ code: 0, data: { field: {} } });
  }

  return { status: 404, payload: { success: false, error: { message: `未 mock 的请求：${method} ${url}` } } };
}

// ---------- 启动 Chrome ----------

rmSync(PROFILE_DIR, { recursive: true, force: true });

let chromeProcess = null;

function stopChrome() {
  if (!chromeProcess) {
    return;
  }
  try {
    chromeProcess.kill("SIGTERM");
  } catch {
    // 忽略
  }
  // 给 Chrome 一点时间退出，再兜底强杀，避免留下 headless 实例占用 profile
  setTimeout(() => {
    try {
      chromeProcess?.kill("SIGKILL");
    } catch {
      // 忽略
    }
  }, 800);
}

function cleanup() {
  stopChrome();
  try {
    rmSync(PROFILE_DIR, { recursive: true, force: true });
  } catch {
    // 忽略
  }
}

process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

console.log(`Chrome: ${chromePath}`);
console.log(`扩展目录: ${EXTENSION_DIR}`);

chromeProcess = spawn(
  chromePath,
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--disable-crash-reporter",
    "--disable-breakpad",
    "--no-first-run",
    "--no-default-browser-check",
    // macOS 上避免钥匙串授权弹窗（Chrome for Testing 默认会去解密 Safe Storage）
    "--use-mock-keychain",
    "--password-store=basic",
    "--disable-sync",
    "--disable-features=PasswordManager,PasswordLeakDetection",
    `--user-data-dir=${PROFILE_DIR}`,
    `--disable-extensions-except=${EXTENSION_DIR}`,
    `--load-extension=${EXTENSION_DIR}`,
    `--remote-debugging-port=${PORT}`,
    "about:blank",
  ],
  { stdio: "ignore" }
);

try {
  // 1. 扩展必须被 Chrome 加载（MV3 service worker 起来）
  const serviceWorker = await waitFor("扩展 service worker 启动", async () => {
    const targets = await fetchJson(`http://127.0.0.1:${PORT}/json/list`);
    return targets.find((target) => target.type === "service_worker" && /\/src\/background\.js$/.test(target.url));
  });
  const extensionId = new URL(serviceWorker.url).host;
  console.log(`✅ 扩展已加载：${extensionId}`);

  // 2. 打开侧边栏页面（扩展页面，具备完整 chrome.* 权限）
  const pageTarget = await fetchJson(
    `http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(`chrome-extension://${extensionId}/src/sidepanel/index.html`)}`,
    { method: "PUT" }
  );
  const session = await new CdpSession(pageTarget.webSocketDebuggerUrl).connect();
  await session.send("Runtime.enable");
  await session.send("Log.enable");
  await session.send("Page.enable");

  // 拦截网络：ReadLoop 假服务 + 飞书假接口
  session.on("Fetch.requestPaused", async ({ requestId, request }) => {
    const body = request.postData ? safeJsonParse(request.postData) : null;
    mock.requests.push({ url: request.url, method: request.method, headers: request.headers, body });

    const { status, payload } = routeMockRequest(request.url, request.method, body);
    await session.send("Fetch.fulfillRequest", {
      requestId,
      responseCode: status,
      responseHeaders: [{ name: "Content-Type", value: "application/json; charset=utf-8" }],
      body: Buffer.from(JSON.stringify(payload)).toString("base64"),
    });
  });

  await waitFor("侧边栏页面加载完成", async () => (await session.evaluate("document.readyState")) === "complete");
  await sleep(1200); // 等 init() 里的 chrome.storage / 消息往返

  const pageState = JSON.parse(
    await session.evaluate(`
      (async () => {
        const ids = [
          "apiBaseUrl", "hostToken", "modelProvider", "modelBaseUrl", "modelName", "modelApiKey",
          "feishuAppId", "feishuAppSecret", "feishuTableUrl", "configStatus", "notice",
          "selectedText", "userTranslation", "diagnoseButton", "saveKnowledgeButton",
          "pairingIdle", "pairingActive", "pairCode", "syncSummary", "settingsForm"
        ];
        const missing = ids.filter((id) => !document.getElementById(id));
        const statusRows = document.querySelectorAll("#configStatus .status-row").length;
        const statusText = document.getElementById("configStatus")?.innerText || "";
        let api = {};
        try {
          await chrome.storage.local.set({ __smoke: "ok" });
          const got = await chrome.storage.local.get(["__smoke"]);
          await chrome.storage.local.remove(["__smoke"]);
          api.storageRoundTrip = got.__smoke;
        } catch (error) {
          api.storageError = String(error);
        }
        try {
          const response = await chrome.runtime.sendMessage({ type: "READINSIGHT_GET_ACTIVE_SELECTION" });
          api.backgroundReply = response && typeof response === "object" ? Object.keys(response).join(",") : String(response);
        } catch (error) {
          api.backgroundError = String(error);
        }
        try {
          const res = await fetch(chrome.runtime.getURL("assets/icons/icon-16.png"));
          const blob = await res.blob();
          api.icon = { status: res.status, type: blob.type, size: blob.size };
        } catch (error) {
          api.iconError = String(error);
        }
        return JSON.stringify({
          title: document.title,
          panels: document.querySelectorAll(".panel").length,
          statusRows,
          statusText,
          missing,
          toastHidden: document.getElementById("toast")?.classList.contains("hidden"),
          hasRuntime: typeof chrome !== "undefined" && !!chrome.runtime,
          hasSidePanel: typeof chrome !== "undefined" && !!chrome.sidePanel,
          api,
        });
      })()
    `)
  );

  check("侧边栏页面标题是 ReadLoop", pageState.title === "ReadLoop", pageState.title);
  check("页面渲染出面板（≥6 个）", pageState.panels >= 6, `panels=${pageState.panels}`);
  check("关键 DOM 节点齐全", pageState.missing.length === 0, `缺少：${pageState.missing.join(",")}`);
  check("连接状态渲染出 5 行（init 执行成功）", pageState.statusRows === 5, `statusRows=${pageState.statusRows}\n${pageState.statusText}`);
  check("chrome.runtime 可用", pageState.hasRuntime === true);
  check("chrome.sidePanel 可用", pageState.hasSidePanel === true);
  check("chrome.storage.local 读写正常", pageState.api.storageRoundTrip === "ok", JSON.stringify(pageState.api));
  check("background service worker 能响应消息", pageState.api.backgroundReply === "selection", JSON.stringify(pageState.api));
  check(
    "图标能被扩展页面加载（PNG 有效）",
    pageState.api.icon?.status === 200 && pageState.api.icon?.type === "image/png" && pageState.api.icon?.size > 100,
    JSON.stringify(pageState.api.icon || pageState.api.iconError)
  );

  // 3. 设置表单 → 保存（验证密钥分仓）
  await session.send("Fetch.enable", {
    patterns: [
      { urlPattern: `${MOCK_ORIGIN}/*`, requestStage: "Request" },
      { urlPattern: "https://open.feishu.cn/*", requestStage: "Request" },
    ],
  });

  await session.evaluate(`
    (() => {
      const fill = (id, value) => {
        const element = document.getElementById(id);
        element.value = value;
        element.dispatchEvent(new Event("input", { bubbles: true }));
      };
      fill("apiBaseUrl", "${MOCK_ORIGIN}");
      fill("hostToken", "host_smoke");
      fill("modelProvider", "deepseek");
      fill("modelBaseUrl", "https://api.deepseek.com/v1");
      fill("modelName", "deepseek-chat");
      fill("modelApiKey", "sk-smoke-key");
      fill("feishuAppId", "cli_smoke");
      fill("feishuAppSecret", "secret_smoke");
      fill("feishuTableUrl", "https://x.feishu.cn/base/bas_smoke?table=tblKp");
      document.getElementById("settingsForm").requestSubmit();
    })()
  `);

  await waitFor("设置保存完成", async () => (await session.evaluate("document.getElementById('toast').textContent")) === "设置已保存");

  const stored = JSON.parse(
    await session.evaluate(`
      (async () => {
        const local = await chrome.storage.local.get(["hostToken", "modelApiKey", "feishuAppSecret"]);
        const sync = await chrome.storage.sync.get(["apiBaseUrl", "feishuAppId", "feishuAppToken", "modelName"]);
        return JSON.stringify({ local, sync });
      })()
    `)
  );

  check(
    "host_token / 模型 Key / App Secret 存到 chrome.storage.local",
    stored.local.hostToken === "host_smoke" && stored.local.modelApiKey === "sk-smoke-key" && stored.local.feishuAppSecret === "secret_smoke",
    JSON.stringify(stored.local)
  );
  check(
    "服务地址 / App ID / app_token 存到 chrome.storage.sync",
    stored.sync.apiBaseUrl === MOCK_ORIGIN && stored.sync.feishuAppId === "cli_smoke" && stored.sync.feishuAppToken === "bas_smoke",
    JSON.stringify(stored.sync)
  );
  check("表格链接被解析成 app_token 回填", (await session.evaluate("document.getElementById('feishuTableUrl').value")) === "bas_smoke");
  check("连接状态 5 行都是已配置", (await session.evaluate("document.querySelectorAll('#configStatus .status-state.ok').length")) === 5);

  // 4. 选区链路：service worker 广播选区 → 侧边栏更新（content script 取值逻辑见 selftest.mjs）
  const swSession = await new CdpSession(serviceWorker.webSocketDebuggerUrl).connect();
  await swSession.send("Runtime.enable");
  const manifestVersion = await swSession.evaluate("chrome.runtime.getManifest().version");
  const expectedManifestVersion = JSON.parse(readFileSync(resolve(EXTENSION_DIR, "manifest.json"), "utf8")).version;
  check(`service worker 里读到 manifest 版本 ${expectedManifestVersion}`, manifestVersion === expectedManifestVersion, manifestVersion);
  check(
    "service worker 里 chrome.sidePanel / contextMenus 可用",
    (await swSession.evaluate("Boolean(chrome.sidePanel && chrome.contextMenus && chrome.action)")) === true
  );

  await swSession.evaluate(`
    chrome.runtime.sendMessage({
      type: "READINSIGHT_SELECTION_UPDATED",
      payload: {
        selectedText: ${JSON.stringify(ARTICLE_TEXT)},
        pageUrl: ${JSON.stringify(ARTICLE_URL)},
        pageTitle: ${JSON.stringify(ARTICLE_TITLE)},
        capturedAt: Date.now(),
      },
    }).catch(() => {})
  `);

  const selectedInPanel = await waitFor("侧边栏收到选区更新", async () => {
    const value = await session.evaluate("document.getElementById('selectedText').value");
    return value.includes("subsequent chapter") ? value : null;
  });
  const sourceMeta = await session.evaluate("document.getElementById('sourceMeta').textContent");
  check("选区广播后侧边栏填入原文", selectedInPanel === ARTICLE_TEXT, selectedInPanel);
  check("侧边栏记录页面标题与链接", sourceMeta.includes(ARTICLE_TITLE) && sourceMeta.includes(ARTICLE_URL), sourceMeta);

  // 5. 诊断流程
  await session.evaluate(`
    (() => {
      document.getElementById("userTranslation").value = "接下来的章节解释了即使这很难。";
      document.getElementById("diagnoseButton").click();
    })()
  `);

  await waitFor("诊断结果渲染", async () => {
    const state = JSON.parse(
      await session.evaluate(`
        JSON.stringify({
          resultHidden: document.getElementById("resultPanel").classList.contains("hidden"),
          aiTranslation: document.getElementById("aiTranslation").textContent,
        })
      `)
    );
    return !state.resultHidden && state.aiTranslation.includes("后续章节") ? state : null;
  });

  const diagnoseState = JSON.parse(
    await session.evaluate(`
      JSON.stringify({
        aiTranslation: document.getElementById("aiTranslation").textContent,
        feedbackCards: document.querySelectorAll("#correctList .feedback-card").length,
        missedCards: document.querySelectorAll("#missedList .feedback-card").length,
        knowledgeCards: document.querySelectorAll("#knowledgeList .knowledge-card").length,
        checked: document.querySelectorAll("#knowledgeList input[type=checkbox]:checked").length,
        saveButtonText: document.getElementById("saveKnowledgeButton").textContent,
        saveButtonDisabled: document.getElementById("saveKnowledgeButton").disabled,
      })
    `)
  );

  check("参考翻译展示正确", diagnoseState.aiTranslation.includes("后续章节"));
  check("诊断反馈（理解正确 / 遗漏要点）都渲染", diagnoseState.feedbackCards === 1 && diagnoseState.missedCards === 1, JSON.stringify(diagnoseState));
  check("知识点卡片渲染 2 个且默认全选", diagnoseState.knowledgeCards === 2 && diagnoseState.checked === 2, JSON.stringify(diagnoseState));
  check("入库按钮可用且显示数量", !diagnoseState.saveButtonDisabled && diagnoseState.saveButtonText.includes("2 个"), diagnoseState.saveButtonText);

  const diagnoseRequest = mock.requests.find((item) => item.url === `${MOCK_ORIGIN}/api/diagnose`);
  check(
    "诊断请求带 Bearer host_token、BYOK 模型配置与真实选中的原文",
    diagnoseRequest?.headers?.Authorization === "Bearer host_smoke" &&
      diagnoseRequest?.body?.model?.api_key === "sk-smoke-key" &&
      diagnoseRequest?.body?.model?.base_url === "https://api.deepseek.com/v1" &&
      diagnoseRequest?.body?.originalParagraph === ARTICLE_TEXT &&
      typeof diagnoseRequest?.body?.articleId === "string" &&
      diagnoseRequest.body.articleId.startsWith("web_"),
    JSON.stringify(diagnoseRequest?.body || null)
  );

  // 5. 一键入库（飞书直写）
  await session.evaluate("document.getElementById('saveKnowledgeButton').click()");

  await waitFor("入库完成", async () => {
    const text = await session.evaluate("document.getElementById('syncSummary').textContent");
    return text.includes("新建知识点") ? text : null;
  });

  const syncState = JSON.parse(
    await session.evaluate(`
      JSON.stringify({
        summary: document.getElementById("syncSummary").textContent,
        summaryHidden: document.getElementById("syncSummary").classList.contains("hidden"),
        saveButtonText: document.getElementById("saveKnowledgeButton").textContent,
        saveButtonDisabled: document.getElementById("saveKnowledgeButton").disabled,
        noticeTitle: document.querySelector("#notice .notice-title")?.textContent || "",
        noticeDetail: document.querySelector("#notice .notice-detail")?.textContent || "",
      })
    `)
  );

  check("入库摘要展示新建/更新/采集记录", syncState.summary.includes("新建知识点") && syncState.summary.includes("采集记录"), syncState.summary);
  check("入库成功后按钮进入已入库状态", syncState.saveButtonDisabled && syncState.saveButtonText.includes("已入库"), syncState.saveButtonText);
  check("入库成功提示可见", syncState.noticeTitle.includes("入库成功"), `${syncState.noticeTitle} / ${syncState.noticeDetail}`);

  const feishuRequests = mock.requests.filter((item) => item.url.startsWith("https://open.feishu.cn"));
  const tokenRequests = feishuRequests.filter((item) => item.url.includes("tenant_access_token"));
  check("飞书 token 只换一次（命中缓存）", tokenRequests.length === 1, `tokenRequests=${tokenRequests.length}`);
  check("写入 2 个知识点 + 1 条采集记录", mock.knowledgeRecords.length === 2 && mock.captureRecords.length === 1, `kp=${mock.knowledgeRecords.length} ce=${mock.captureRecords.length}`);

  const captureRecord = mock.captureRecords[0]?.fields || {};
  const firstPoint = mock.knowledgeRecords[0]?.fields || {};
  check(
    "采集记录字段符合 schema（时间/链接/标题/原文/译文/AI译文/诊断/知识点/是否新点）",
    typeof captureRecord.采集时间 === "number" &&
      captureRecord.页面链接?.link === ARTICLE_URL &&
      captureRecord.页面标题 === ARTICLE_TITLE &&
      captureRecord.选中原文.includes("subsequent") &&
      captureRecord.我的译文.includes("接下来的章节") &&
      captureRecord.AI参考译文.includes("后续章节") &&
      typeof captureRecord.诊断结果 === "string" &&
      captureRecord.抽出的知识点 === "subsequent, eventhough" &&
      captureRecord.是否新点 === true,
    JSON.stringify(captureRecord)
  );
  check(
    "知识点新建字段符合 schema 默认值",
    firstPoint.知识点 === "subsequent" &&
      firstPoint.归一化内容 === "subsequent" &&
      firstPoint.类型 === "word" &&
      firstPoint.状态 === "new" &&
      firstPoint.间隔天数 === 0 &&
      firstPoint.难度因子 === 2.5 &&
      firstPoint.连对次数 === 0 &&
      firstPoint.答错次数 === 0 &&
      firstPoint.待练次数 === 3 &&
      firstPoint.暴露次数 === 1 &&
      typeof firstPoint.下次复习 === "number" &&
      typeof firstPoint.最近暴露 === "number" &&
      firstPoint.来源原句.includes("subsequent"),
    JSON.stringify(firstPoint)
  );

  // 6. 配对码流程
  await session.evaluate("document.getElementById('startPairingButton').click()");
  const pairCode = await waitFor("配对码展示", async () => {
    const visible = !(await session.evaluate("document.getElementById('pairingActive').classList.contains('hidden')"));
    return visible ? session.evaluate("document.getElementById('pairCode').textContent") : null;
  });
  check("生成本地 6 位配对码", /^\d{6}$/.test(pairCode), pairCode);

  await waitFor("配对成功并自动填好凭证", async () => {
    const state = JSON.parse(
      await session.evaluate(`
        JSON.stringify({
          activeHidden: document.getElementById("pairingActive").classList.contains("hidden"),
          noticeTitle: document.querySelector("#notice .notice-title")?.textContent || "",
        })
      `)
    );
    return state.activeHidden && state.noticeTitle.includes("一键配置成功") ? state : null;
  });

  const pairedState = JSON.parse(
    await session.evaluate(`
      (async () => {
        const local = await chrome.storage.local.get(["feishuAppSecret", "hostToken"]);
        return JSON.stringify({
          appId: document.getElementById("feishuAppId").value,
          appSecret: document.getElementById("feishuAppSecret").value,
          appToken: document.getElementById("feishuTableUrl").value,
          hostTokenInput: document.getElementById("hostToken").value,
          storedSecret: local.feishuAppSecret,
          storedHostToken: local.hostToken,
        });
      })()
    `)
  );
  check(
    "配对成功后凭证回填并写入 storage",
    pairedState.appId === "cli_paired_smoke" &&
      pairedState.appSecret === "secret_paired_smoke" &&
      pairedState.appToken === "bas_paired_smoke" &&
      pairedState.storedSecret === "secret_paired_smoke",
    JSON.stringify(pairedState)
  );
  check(
    "配对一并下发 host_token 并自动填入（覆盖手填值）",
    pairedState.hostTokenInput === "host_paired_smoke" &&
      pairedState.storedHostToken === "host_paired_smoke",
    JSON.stringify(pairedState)
  );
  check("配对轮询先 404 后命中（未绑定时继续轮询）", mock.pairAttempts >= 2, `attempts=${mock.pairAttempts}`);

  // 7. 控制台错误 / 未捕获异常
  const noise = /favicon|Failed to load resource: the server responded with a status of 404/i;
  const allEvents = [...session.events, ...(swSession?.events || [])];
  const exceptions = allEvents.filter((event) => event.method === "Runtime.exceptionThrown");
  const consoleErrors = allEvents.filter(
    (event) => event.method === "Log.entryAdded" && ["error", "warning"].includes(event.params.entry.level) && !noise.test(event.params.entry.text)
  );

  check(
    "没有未捕获异常",
    exceptions.length === 0,
    exceptions.map((event) => event.params.exceptionDetails?.exception?.description || event.params.exceptionDetails?.text).join("\n")
  );
  check("没有控制台报错/告警", consoleErrors.length === 0, consoleErrors.map((event) => event.params.entry.text).join("\n"));

  swSession?.close();
  session.close();
} catch (error) {
  failures.push("冒烟测试执行");
  console.error(`❌ 冒烟测试执行失败：${error.message}`);
}

cleanup();

if (failures.length === 0) {
  console.log("\n✅ 真机冒烟测试全部通过");
  process.exit(0);
}
console.error(`\n❌ ${failures.length} 项失败：${failures.join("；")}`);
process.exit(1);

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
