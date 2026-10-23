/**
 * ReadLoop 侧边栏主逻辑。
 *
 * 流程：网页划词 → 用户写译文 → /api/diagnose → 展示诊断 → 勾选知识点 → 直写用户自己的飞书表格。
 * 设置页负责：服务地址 / host_token / 模型（BYOK）/ 飞书应用凭证 / 表格链接，以及配对码一键配置。
 *
 * 约定：
 * - 所有 chrome.storage 读写都走 ../lib/storage.js，密钥只落 chrome.storage.local；
 * - 所有出网请求都走 ../lib/api.js（ReadLoop 服务）与 ../lib/feishu.js（飞书）；
 * - 面向用户的错误统一用中文「发生了什么 + 下一步怎么做」。
 */

import { describeApiError, diagnoseSelection, getPairingCredentials } from "../lib/api.js";
import { describeFeishuError, syncCaptureToFeishu, testFeishuConnection } from "../lib/feishu.js";
import { buildWebArticleId, buildWebParagraphId } from "../lib/ids.js";
import {
  DEFAULT_API_BASE_URL,
  DEFAULT_MODEL,
  getSettings,
  maskSecret,
  normalizeApiBaseUrl,
  parseAppToken,
  savePairedFeishuApp,
  saveSettings,
} from "../lib/storage.js";

const PAIRING_TTL_MS = 5 * 60 * 1000;
const PAIRING_INTERVAL_MS = 3000;

const POINT_TYPE_LABELS = {
  word: "单词",
  phrase: "短语",
  pattern: "句型",
  comprehension_point: "理解点",
};

const state = {
  settings: null,
  selection: { selectedText: "", pageUrl: "", pageTitle: "" },
  diagnosis: null,
  selectedPointIndexes: new Set(),
  diagnosisIngested: false,
  saving: false,
  pairing: {
    active: false,
    code: "",
    deadline: 0,
    timer: null,
    polling: false,
    nextPollAt: 0,
  },
};

const elements = {
  notice: document.querySelector("#notice"),
  settingsToggle: document.querySelector("#settingsToggle"),
  settingsPanel: document.querySelector("#settingsPanel"),
  settingsForm: document.querySelector("#settingsForm"),
  saveSettingsButton: document.querySelector("#saveSettingsButton"),
  testFeishuButton: document.querySelector("#testFeishuButton"),
  apiBaseUrl: document.querySelector("#apiBaseUrl"),
  hostToken: document.querySelector("#hostToken"),
  modelProvider: document.querySelector("#modelProvider"),
  modelBaseUrl: document.querySelector("#modelBaseUrl"),
  modelName: document.querySelector("#modelName"),
  modelApiKey: document.querySelector("#modelApiKey"),
  feishuAppId: document.querySelector("#feishuAppId"),
  feishuAppSecret: document.querySelector("#feishuAppSecret"),
  feishuTableUrl: document.querySelector("#feishuTableUrl"),
  appTokenHint: document.querySelector("#appTokenHint"),
  configStatus: document.querySelector("#configStatus"),
  pairingIdle: document.querySelector("#pairingIdle"),
  pairingActive: document.querySelector("#pairingActive"),
  pairCode: document.querySelector("#pairCode"),
  pairStatus: document.querySelector("#pairStatus"),
  startPairingButton: document.querySelector("#startPairingButton"),
  cancelPairingButton: document.querySelector("#cancelPairingButton"),
  selectedText: document.querySelector("#selectedText"),
  sourceMeta: document.querySelector("#sourceMeta"),
  refreshSelectionButton: document.querySelector("#refreshSelectionButton"),
  userTranslation: document.querySelector("#userTranslation"),
  diagnoseButton: document.querySelector("#diagnoseButton"),
  resultPanel: document.querySelector("#resultPanel"),
  aiTranslation: document.querySelector("#aiTranslation"),
  correctList: document.querySelector("#correctList"),
  alternativeList: document.querySelector("#alternativeList"),
  missedList: document.querySelector("#missedList"),
  knowledgePanel: document.querySelector("#knowledgePanel"),
  knowledgeCount: document.querySelector("#knowledgeCount"),
  knowledgeList: document.querySelector("#knowledgeList"),
  saveKnowledgeButton: document.querySelector("#saveKnowledgeButton"),
  syncSummary: document.querySelector("#syncSummary"),
  openWebAppButton: document.querySelector("#openWebAppButton"),
  toast: document.querySelector("#toast"),
};

init().catch((error) => {
  showNotice("插件初始化失败", "error", describeError(error));
});

async function init() {
  bindEvents();
  state.settings = await getSettings();
  fillSettingsForm(state.settings);
  renderConfigStatus();
  await refreshSelection();
}

// ---------- 事件绑定 ----------

function bindEvents() {
  elements.settingsToggle.addEventListener("click", () => {
    const hidden = elements.settingsPanel.classList.toggle("hidden");
    elements.settingsToggle.textContent = hidden ? "设置" : "收起设置";
  });

  elements.settingsForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await persistSettings();
  });

  elements.testFeishuButton.addEventListener("click", handleTestFeishu);
  elements.startPairingButton.addEventListener("click", startPairing);
  elements.cancelPairingButton.addEventListener("click", cancelPairing);

  elements.refreshSelectionButton.addEventListener("click", refreshSelection);
  elements.diagnoseButton.addEventListener("click", handleDiagnose);
  elements.saveKnowledgeButton.addEventListener("click", handleSaveKnowledge);
  elements.openWebAppButton.addEventListener("click", openWebApp);

  elements.knowledgeList.addEventListener("change", (event) => {
    const input = event.target.closest("input[type='checkbox']");
    if (!input) {
      return;
    }
    const index = Number(input.dataset.pointIndex);
    if (input.checked) {
      state.selectedPointIndexes.add(index);
    } else {
      state.selectedPointIndexes.delete(index);
    }
    state.diagnosisIngested = false;
    updateSaveKnowledgeButton();
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "READINSIGHT_SELECTION_UPDATED") {
      applySelection(message.payload);
    }
  });
}

// ---------- 设置 ----------

function fillSettingsForm(settings) {
  elements.apiBaseUrl.value = settings.apiBaseUrl || DEFAULT_API_BASE_URL;
  elements.hostToken.value = settings.hostToken || "";
  elements.modelProvider.value = settings.model.provider || DEFAULT_MODEL.provider;
  elements.modelBaseUrl.value = settings.model.baseUrl || DEFAULT_MODEL.baseUrl;
  elements.modelName.value = settings.model.model || DEFAULT_MODEL.model;
  elements.modelApiKey.value = settings.model.apiKey || "";
  elements.feishuAppId.value = settings.feishu.appId || "";
  elements.feishuAppSecret.value = settings.feishu.appSecret || "";
  elements.feishuTableUrl.value = settings.feishu.appToken || "";
  renderAppTokenHint(settings.feishu.appToken);
}

/**
 * 校验并保存表单。返回 false 表示校验没过（已在界面提示）。
 * silent = true 时用于「测试飞书连接」前的隐式保存，不弹成功 toast。
 */
async function persistSettings({ silent = false } = {}) {
  const apiBaseUrl = normalizeApiBaseUrl(elements.apiBaseUrl.value);
  if (!/^https?:\/\//i.test(apiBaseUrl)) {
    showNotice("服务地址格式不对", "error", "需要以 http:// 或 https:// 开头，例如 https://readinsight.bamamei.online 或 http://localhost:3000。");
    return false;
  }

  const modelBaseUrl = elements.modelBaseUrl.value.trim().replace(/\/+$/, "");
  if (modelBaseUrl && !/^https:\/\//i.test(modelBaseUrl)) {
    showNotice("模型 base_url 必须是 https 地址", "error", "服务端出于安全只接受 https 的模型地址，例如 https://api.deepseek.com/v1。");
    return false;
  }

  const rawTableInput = elements.feishuTableUrl.value.trim();
  const appToken = parseAppToken(rawTableInput);
  if (rawTableInput && !appToken) {
    showNotice(
      "没能从表格链接里解析出 app_token",
      "error",
      "请粘贴多维表格链接（形如 https://xxx.feishu.cn/base/xxxx?table=tblxxxx），或直接填 app_token。"
    );
    return false;
  }

  await saveSettings({
    apiBaseUrl,
    hostToken: elements.hostToken.value.trim(),
    model: {
      provider: elements.modelProvider.value.trim(),
      baseUrl: modelBaseUrl,
      model: elements.modelName.value.trim(),
      apiKey: elements.modelApiKey.value.trim(),
    },
    feishu: {
      appId: elements.feishuAppId.value.trim(),
      appSecret: elements.feishuAppSecret.value.trim(),
      appToken,
    },
  });

  state.settings = await getSettings();
  fillSettingsForm(state.settings);
  renderConfigStatus();

  if (!silent) {
    showToast("设置已保存");
  }
  return true;
}

function renderAppTokenHint(appToken) {
  elements.appTokenHint.textContent = appToken
    ? `已解析 app_token：${appToken}`
    : "表格链接只用来解析 app_token；解析结果会保存在 chrome.storage.sync。";
}

function renderConfigStatus() {
  if (!state.settings) {
    return;
  }
  const settings = state.settings;
  const modelReady = Boolean(settings.model.baseUrl && settings.model.model && settings.model.apiKey);
  const feishuCredentialReady = Boolean(settings.feishu.appId && settings.feishu.appSecret);

  const rows = [
    {
      label: "服务地址",
      value: settings.apiBaseUrl,
      state: "ok",
      text: "已设置",
    },
    settings.hostToken
      ? { label: "host_token", value: maskSecret(settings.hostToken), state: "ok", text: "已填写" }
      : { label: "host_token", value: "未填写", state: "missing", text: "必填" },
    modelReady
      ? { label: "模型", value: `${settings.model.model}（${settings.model.provider || "custom"}）`, state: "ok", text: "已配置" }
      : { label: "模型", value: "未配置完整", state: "missing", text: "必填" },
    feishuCredentialReady
      ? {
          label: "飞书应用",
          value: `App ID ${settings.feishu.appId}`,
          state: "ok",
          text: settings.feishu.pairedAt ? "已配对" : "已填写",
        }
      : { label: "飞书应用", value: "未配置", state: "missing", text: "必填" },
    settings.feishu.appToken
      ? { label: "表格", value: `app_token ${settings.feishu.appToken}`, state: "ok", text: "已解析" }
      : { label: "表格", value: "未配置", state: "missing", text: "必填" },
  ];

  elements.configStatus.innerHTML = rows
    .map(
      (row) => `
      <div class="status-row">
        <span class="status-label">${escapeHtml(row.label)}</span>
        <span class="status-value">${escapeHtml(row.value)}</span>
        <span class="status-state ${row.state}">${escapeHtml(row.text)}</span>
      </div>`
    )
    .join("");
}

async function handleTestFeishu() {
  clearNotice();
  const saved = await persistSettings({ silent: true });
  if (!saved) {
    return;
  }

  setBusy(elements.testFeishuButton, true, "正在测试…");
  try {
    const result = await testFeishuConnection();
    showNotice(
      "飞书连接正常",
      "success",
      `App ID：${result.appId}\n` +
        result.tables.map((table) => `${table.name} → ${table.tableId}（${table.fieldCount} 个字段）`).join("\n")
    );
    showToast("飞书连接正常");
  } catch (error) {
    showNotice("飞书连接失败", "error", describeError(error));
  } finally {
    setBusy(elements.testFeishuButton, false, "测试飞书连接");
  }
}

// ---------- 一键配置（配对码） ----------

function generatePairCode() {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return String(100000 + (buffer[0] % 900000));
}

function startPairing() {
  stopPairing();
  clearNotice();

  state.pairing = {
    active: true,
    code: generatePairCode(),
    deadline: Date.now() + PAIRING_TTL_MS,
    timer: null,
    polling: false,
    nextPollAt: 0,
  };

  elements.pairingIdle.classList.add("hidden");
  elements.pairingActive.classList.remove("hidden");
  elements.pairCode.textContent = state.pairing.code;
  updatePairingStatus("把这个 6 位码告诉 AI 宿主，等它提交…");

  state.pairing.timer = setInterval(pairingTick, 1000);
  pairingTick();
}

async function pairingTick() {
  const pairing = state.pairing;
  if (!pairing.active) {
    return;
  }

  updatePairingStatus("等待 AI 宿主提交配对码…");

  if (Date.now() >= pairing.deadline) {
    await finishPairing("timeout");
    return;
  }
  if (pairing.polling || Date.now() < pairing.nextPollAt) {
    return;
  }

  pairing.polling = true;
  pairing.nextPollAt = Date.now() + PAIRING_INTERVAL_MS;

  try {
    const credentials = await getPairingCredentials(pairing.code);
    if (!pairing.active) {
      return;
    }
    if (credentials) {
      await finishPairing("success", credentials);
      return;
    }
    updatePairingStatus("还没收到凭证，确认 AI 宿主已经提交这个码…");
  } catch (error) {
    if (!pairing.active) {
      return;
    }
    const status = error?.name === "ApiError" ? error.status : 0;
    if (status === 404) {
      // 配对码还没被宿主绑定，继续轮询
      return;
    }
    if (status === 0) {
      // 网络抖动：保留轮询，等下一次
      updatePairingStatus("网络不稳定，正在重试…");
      return;
    }
    // 410 会话过期 / 429 限流 / 其它服务端错误：直接结束，给出可读原因
    await finishPairing("error", error);
    return;
  } finally {
    pairing.polling = false;
  }
}

function updatePairingStatus(prefix) {
  const remain = Math.max(0, state.pairing.deadline - Date.now());
  const minutes = Math.floor(remain / 60000);
  const seconds = String(Math.floor((remain % 60000) / 1000)).padStart(2, "0");
  elements.pairStatus.textContent = `${prefix}（剩余 ${minutes}:${seconds}）`;
}

async function finishPairing(kind, payload) {
  const usedCode = state.pairing.code;
  stopPairing();
  elements.pairingIdle.classList.remove("hidden");
  elements.pairingActive.classList.add("hidden");

  if (kind === "success") {
    try {
      await savePairedFeishuApp({
        appId: payload.appId,
        appSecret: payload.appSecret,
        appToken: payload.appToken,
      });
      // 宿主绑定时带来的 host_token：一并写入，插件不再需要用户手抄
      if (payload.hostToken) {
        await saveSettings({ hostToken: payload.hostToken });
      }
      state.settings = await getSettings();
      fillSettingsForm(state.settings);
      renderConfigStatus();
      showNotice(
        "一键配置成功",
        "success",
        payload.hostToken
          ? `已收到飞书应用凭证（App ID：${payload.appId}）和 host_token，都已自动填好。\n建议点一次「测试飞书连接」，确认应用已被加成表格协作者、权限已发布。`
          : `已收到飞书应用凭证（App ID：${payload.appId}），表格 app_token 也自动填好了。\n建议点一次「测试飞书连接」，确认应用已被加成表格协作者、权限已发布。`
      );
      showToast("配对成功，飞书凭证已保存");
    } catch (error) {
      showNotice("配对成功，但保存凭证失败", "error", describeError(error));
    }
    return;
  }

  if (kind === "timeout") {
    showNotice(
      "配对超时（5 分钟内没有收到凭证）",
      "warn",
      `配对码 ${usedCode} 已失效。确认 AI 宿主已经拿到并提交了这个码后，重新点「生成配对码」。`
    );
    return;
  }

  showNotice("配对失败", "error", describeError(payload));
}

function cancelPairing() {
  stopPairing();
  elements.pairingIdle.classList.remove("hidden");
  elements.pairingActive.classList.add("hidden");
  showToast("已取消配对");
}

function stopPairing() {
  state.pairing.active = false;
  state.pairing.polling = false;
  if (state.pairing.timer) {
    clearInterval(state.pairing.timer);
    state.pairing.timer = null;
  }
}

// ---------- 选区 ----------

async function refreshSelection() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "READINSIGHT_REFRESH_SELECTION" });
    applySelection(response?.selection);
  } catch {
    // service worker 未就绪时只渲染本地来源信息
    renderSourceMeta();
  }
}

function applySelection(selection) {
  if (!selection) {
    renderSourceMeta();
    return;
  }

  const next = {
    selectedText: (selection.selectedText || "").trim(),
    pageUrl: selection.pageUrl || "",
    pageTitle: selection.pageTitle || "",
  };

  const textChanged = Boolean(next.selectedText) && next.selectedText !== state.selection.selectedText;
  state.selection = next;

  if (next.selectedText) {
    elements.selectedText.value = next.selectedText;
  }
  if (textChanged) {
    resetDiagnosis();
  }
  renderSourceMeta();
}

function renderSourceMeta() {
  const { pageUrl, pageTitle, selectedText } = state.selection;

  if (pageUrl) {
    elements.sourceMeta.textContent = pageTitle ? `来源：${pageTitle} · ${pageUrl}` : `来源：${pageUrl}`;
    return;
  }

  elements.sourceMeta.textContent = selectedText
    ? "手动粘贴的文本（没有页面来源，来源链接会留空）"
    : "还没有选区：在网页里划选一段英文，或把英文直接粘贴到上面。";
}

// ---------- 诊断 ----------

async function handleDiagnose() {
  const selectedText = elements.selectedText.value.trim();
  const userTranslation = elements.userTranslation.value.trim();

  if (!selectedText) {
    showNotice("还没有要诊断的英文", "error", "先在网页里划选一段英文，或把英文粘贴到「网页选中文本」。");
    return;
  }
  if (userTranslation.length < 5) {
    showNotice("请先写更完整的中文译文", "error", "至少写 5 个字，AI 才能看出你的理解偏差。");
    return;
  }

  const pageUrl = state.selection.pageUrl || "";
  const articleId = buildWebArticleId(pageUrl);
  const paragraphId = buildWebParagraphId(pageUrl, selectedText);

  resetDiagnosis();
  clearNotice();
  setBusy(elements.diagnoseButton, true, "AI 正在诊断…");

  try {
    state.diagnosis = await diagnoseSelection({ articleId, paragraphId, selectedText, userTranslation });
    state.selectedPointIndexes = new Set(state.diagnosis.knowledgePoints.map((_, index) => index));
    state.diagnosisIngested = false;
    renderDiagnosis();

    if (state.diagnosis.knowledgePoints.length === 0) {
      showNotice("这次没有抽出可沉淀的知识点", "warn", "可能是这段太简单，换一段再试；诊断结果本身仍然可以参考。");
    } else {
      showToast("诊断完成，勾选知识点后一键入库");
    }
  } catch (error) {
    resetDiagnosis();
    showNotice("AI 诊断失败", "error", describeError(error));
  } finally {
    setBusy(elements.diagnoseButton, false, "开始 AI 对比诊断");
  }
}

function resetDiagnosis() {
  state.diagnosis = null;
  state.diagnosisIngested = false;
  state.selectedPointIndexes = new Set();
  elements.resultPanel.classList.add("hidden");
  elements.knowledgePanel.classList.add("hidden");
  elements.syncSummary.classList.add("hidden");
  elements.syncSummary.innerHTML = "";
  elements.knowledgeCount.textContent = "0";
  updateSaveKnowledgeButton();
}

function renderDiagnosis() {
  const diagnosis = state.diagnosis;
  if (!diagnosis) {
    return;
  }

  elements.resultPanel.classList.remove("hidden");
  elements.aiTranslation.textContent = diagnosis.aiTranslation || "（服务没有返回参考翻译）";

  renderFeedbackList(elements.correctList, diagnosis.analysis.correct, (item) => (
    `<strong>${escapeHtml(item.text || "理解正确")}</strong><p>${escapeHtml(item.feedback || "")}</p>`
  ));
  renderFeedbackList(elements.alternativeList, diagnosis.analysis.alternative, (item) => (
    `<strong>${escapeHtml(item.original || "表达可优化")}</strong>` +
    `<p>${escapeHtml(item.reason || "")}</p>` +
    `<p class="muted">建议：${escapeHtml(item.betterTranslation || "")}</p>`
  ));
  renderFeedbackList(elements.missedList, diagnosis.analysis.missed, (item) => (
    `<strong>${escapeHtml(item.text || "遗漏要点")}</strong>` +
    `<p>${escapeHtml(item.meaning || "")}</p>` +
    `<p class="muted">${escapeHtml(item.reason || "")}</p>`
  ));

  renderKnowledgePoints();
}

function renderFeedbackList(container, items, renderItem) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) {
    container.innerHTML = `<p class="empty-state">暂无</p>`;
    return;
  }
  container.innerHTML = list
    .map((item) => `<article class="feedback-card">${renderItem(item)}</article>`)
    .join("");
}

function renderKnowledgePoints() {
  const points = state.diagnosis?.knowledgePoints || [];
  elements.knowledgeCount.textContent = String(points.length);

  if (points.length === 0) {
    elements.knowledgePanel.classList.add("hidden");
    updateSaveKnowledgeButton();
    return;
  }

  elements.knowledgePanel.classList.remove("hidden");
  elements.knowledgeList.innerHTML = points
    .map((point, index) => {
      const checked = state.selectedPointIndexes.has(index) ? "checked" : "";
      const typeLabel = POINT_TYPE_LABELS[point.type] || point.type || "知识点";
      const example = point.example ? `<p class="muted">例句：${escapeHtml(point.example)}</p>` : "";
      return `
        <article class="knowledge-card">
          <label>
            <input type="checkbox" data-point-index="${index}" ${checked} />
            <span>
              <span class="knowledge-title">
                <strong>${escapeHtml(point.content)}</strong>
                <span class="pill">${escapeHtml(typeLabel)}</span>
              </span>
              <p>${escapeHtml(point.meaning)}</p>
              <p class="muted">${escapeHtml(point.explanation || "")}</p>
              ${example}
            </span>
          </label>
        </article>`;
    })
    .join("");

  updateSaveKnowledgeButton();
}

function updateSaveKnowledgeButton() {
  const button = elements.saveKnowledgeButton;

  // 写入进行中：保持禁用，防止重复点击导致同一批点被写入两次
  if (state.saving) {
    button.disabled = true;
    return;
  }
  if (!state.diagnosis) {
    button.disabled = true;
    button.textContent = "一键存入我的飞书表格";
    return;
  }
  if (state.diagnosisIngested) {
    button.disabled = true;
    button.textContent = "已入库 ✔（重新诊断可再存）";
    return;
  }

  const count = state.selectedPointIndexes.size;
  button.disabled = count === 0;
  button.textContent = count === 0 ? "请先勾选要入库的知识点" : `一键存入我的飞书表格（${count} 个）`;
}

// ---------- 入库（直写飞书） ----------

async function handleSaveKnowledge() {
  const diagnosis = state.diagnosis;
  if (!diagnosis) {
    showNotice("还没有诊断结果", "error", "先写译文并点「开始 AI 对比诊断」。");
    return;
  }

  const selectedText = elements.selectedText.value.trim();
  const userTranslation = elements.userTranslation.value.trim();
  const selectedPoints = diagnosis.knowledgePoints.filter((_, index) => state.selectedPointIndexes.has(index));

  if (selectedPoints.length === 0) {
    showNotice("还没有勾选知识点", "error", "在「可沉淀知识点」里勾选要存进飞书表格的点。");
    return;
  }

  state.settings = await getSettings();
  const feishu = state.settings.feishu;
  if (!feishu.appId || !feishu.appSecret || !feishu.appToken) {
    elements.settingsPanel.classList.remove("hidden");
    elements.settingsToggle.textContent = "收起设置";
    showNotice(
      "飞书配置还不完整，无法入库",
      "error",
      "在「设置 → 飞书多维表格」填好 App ID / App Secret / 表格链接，或用上面的「一键配置（配对码）」让 AI 宿主把凭证送进来。"
    );
    return;
  }

  clearNotice();
  state.saving = true;
  setBusy(elements.saveKnowledgeButton, true, "正在写入飞书表格…");

  try {
    const summary = await syncCaptureToFeishu({
      capture: {
        pageUrl: state.selection.pageUrl,
        pageTitle: state.selection.pageTitle,
        selectedText,
        userTranslation,
        aiTranslation: diagnosis.aiTranslation,
        diagnosis: diagnosis.analysis,
        capturedAt: Date.now(),
      },
      extractedPoints: diagnosis.knowledgePoints,
      selectedPoints,
    });

    renderSyncSummary(summary);

    const problems = [];
    if (summary.failures.length > 0) {
      problems.push(
        `有 ${summary.failures.length} 个知识点没写入：\n` +
          summary.failures
            .map((failure) => `· ${failure.content || "（空内容）"}：${failure.message}${failure.hint ? `\n  ${failure.hint}` : ""}`)
            .join("\n")
      );
    }
    if (!summary.captureSaved) {
      problems.push(`采集记录写入失败：\n${summary.captureError}`);
    }

    if (problems.length > 0) {
      showNotice(
        `入库完成，但有一部分失败（新建 ${summary.created} 个 / 更新 ${summary.updated} 个）`,
        "warn",
        problems.join("\n\n")
      );
      showToast("部分写入失败，请看上方提示", "error");
    } else {
      state.diagnosisIngested = true;
      showNotice(
        "入库成功",
        "success",
        `新建 ${summary.created} 个知识点，更新 ${summary.updated} 个重复点；采集记录已写入你的飞书表格。`
      );
      showToast(`已写入飞书表格：新建 ${summary.created} 个，更新 ${summary.updated} 个`);
    }
  } catch (error) {
    showNotice("写入飞书表格失败", "error", describeError(error));
    showToast("写入失败，请看上方提示", "error");
  } finally {
    state.saving = false;
    updateSaveKnowledgeButton();
  }
}

function renderSyncSummary(summary) {
  const lines = [
    `<div class="sync-line">新建知识点：<strong>${summary.created}</strong> 个</div>`,
    `<div class="sync-line">更新重复点：<strong>${summary.updated}</strong> 个（暴露次数 +1，待练次数 +1）</div>`,
    `<div class="sync-line">采集记录：<strong>${summary.captureSaved ? "已写入" : "写入失败"}</strong></div>`,
  ];
  if (summary.failures.length > 0) {
    lines.push(`<div class="sync-line">失败：<strong>${summary.failures.length}</strong> 个</div>`);
  }
  lines.push(
    `<div class="sync-line muted">knowledge_points → ${escapeHtml(shortId(summary.tables.knowledgePoints))} · ` +
      `capture_events → ${escapeHtml(shortId(summary.tables.captureEvents))}</div>`
  );

  elements.syncSummary.innerHTML = lines.join("");
  elements.syncSummary.classList.remove("hidden");
}

function shortId(id) {
  const text = String(id || "");
  return text.length > 12 ? `${text.slice(0, 8)}…${text.slice(-3)}` : text;
}

// ---------- 其他 ----------

async function openWebApp() {
  const settings = state.settings || (await getSettings());
  try {
    await chrome.tabs.create({ url: settings.apiBaseUrl });
  } catch (error) {
    showToast(`打不开服务地址：${error?.message || "未知错误"}`, "error");
  }
}

function setBusy(button, busy, text) {
  button.disabled = busy;
  button.textContent = text;
}

/** type: info | success | warn | error */
function showNotice(message, type = "info", detail = "") {
  elements.notice.className = `notice ${type}`;
  elements.notice.innerHTML =
    `<div class="notice-body">` +
    `<p class="notice-title">${escapeHtml(message)}</p>` +
    (detail ? `<p class="notice-detail">${escapeHtml(detail).replace(/\n/g, "<br>")}</p>` : "") +
    `</div>` +
    `<button class="notice-close" type="button" aria-label="关闭">×</button>`;
  elements.notice.classList.remove("hidden");

  elements.notice.querySelector(".notice-close")?.addEventListener("click", clearNotice);
}

function clearNotice() {
  elements.notice.classList.add("hidden");
  elements.notice.innerHTML = "";
}

function showToast(message, type = "success") {
  elements.toast.textContent = message;
  elements.toast.classList.toggle("error", type === "error");
  elements.toast.classList.remove("hidden");

  setTimeout(() => {
    elements.toast.classList.add("hidden");
  }, 3600);
}

function describeError(error) {
  if (error?.name === "FeishuError") {
    return describeFeishuError(error);
  }
  if (error?.name === "ApiError") {
    return describeApiError(error);
  }
  return error?.message || "发生未知错误，请稍后重试。";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
