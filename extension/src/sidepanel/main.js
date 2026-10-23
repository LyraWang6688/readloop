import { diagnoseSelection, saveKnowledgePoints } from "../lib/api.js";
import { buildWebArticleId, buildWebParagraphId } from "../lib/ids.js";
import { DEFAULT_API_BASE_URL, DEFAULT_USER_ID, getSettings, saveSettings } from "../lib/storage.js";

const state = {
  selection: {
    selectedText: "",
    pageUrl: "",
    pageTitle: "",
  },
  diagnosis: null,
  selectedPointIndexes: new Set(),
};

const elements = {
  settingsToggle: document.querySelector("#settingsToggle"),
  settingsForm: document.querySelector("#settingsForm"),
  apiBaseUrl: document.querySelector("#apiBaseUrl"),
  userId: document.querySelector("#userId"),
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
  openWebAppButton: document.querySelector("#openWebAppButton"),
  toast: document.querySelector("#toast"),
};

await init();

async function init() {
  await loadSettings();
  await refreshSelection();
  bindEvents();
}

function bindEvents() {
  elements.settingsToggle.addEventListener("click", () => {
    elements.settingsForm.classList.toggle("hidden");
  });

  elements.settingsForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await saveSettings({
      apiBaseUrl: elements.apiBaseUrl.value,
      userId: elements.userId.value,
    });
    showToast("设置已保存");
  });

  elements.refreshSelectionButton.addEventListener("click", refreshSelection);
  elements.diagnoseButton.addEventListener("click", diagnose);
  elements.saveKnowledgeButton.addEventListener("click", saveSelectedKnowledge);
  elements.openWebAppButton.addEventListener("click", openWebApp);

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "READINSIGHT_SELECTION_UPDATED") {
      applySelection(message.payload);
    }
  });
}

async function loadSettings() {
  const settings = await getSettings();
  elements.apiBaseUrl.value = settings.apiBaseUrl || DEFAULT_API_BASE_URL;
  elements.userId.value = settings.userId || DEFAULT_USER_ID;
}

async function refreshSelection() {
  const response = await chrome.runtime.sendMessage({
    type: "READINSIGHT_REFRESH_SELECTION",
  });
  applySelection(response?.selection);
}

function applySelection(selection) {
  if (!selection) {
    return;
  }

  state.selection = {
    selectedText: selection.selectedText || "",
    pageUrl: selection.pageUrl || "",
    pageTitle: selection.pageTitle || "",
  };

  if (state.selection.selectedText) {
    elements.selectedText.value = state.selection.selectedText;
  }

  elements.sourceMeta.textContent = state.selection.pageTitle
    ? `${state.selection.pageTitle} · ${state.selection.pageUrl}`
    : state.selection.pageUrl;
}

async function diagnose() {
  const selectedText = elements.selectedText.value.trim();
  const userTranslation = elements.userTranslation.value.trim();

  if (!selectedText) {
    showToast("请先在网页中选中英文，或粘贴一段英文。", "error");
    return;
  }

  if (userTranslation.length < 5) {
    showToast("请先输入更完整的中文翻译。", "error");
    return;
  }

  const articleId = buildWebArticleId(state.selection.pageUrl);
  const paragraphId = buildWebParagraphId(state.selection.pageUrl, selectedText);

  setBusy(elements.diagnoseButton, true, "AI 正在诊断...");

  try {
    state.diagnosis = await diagnoseSelection({
      articleId,
      paragraphId,
      selectedText,
      userTranslation,
    });
    state.selectedPointIndexes = new Set(
      (state.diagnosis.knowledgePoints || []).map((_, index) => index)
    );
    renderDiagnosis();
    showToast("诊断完成，可以选择知识点入库");
  } catch (error) {
    showToast(error.message || "诊断失败，请稍后重试。", "error");
  } finally {
    setBusy(elements.diagnoseButton, false, "开始 AI 对比诊断");
  }
}

function renderDiagnosis() {
  elements.resultPanel.classList.remove("hidden");
  elements.aiTranslation.textContent = state.diagnosis.aiTranslation || "暂无参考翻译";

  renderFeedbackList(elements.correctList, state.diagnosis.analysis?.correct, (item) => (
    `<strong>${escapeHtml(item.text || "理解正确")}</strong><p>${escapeHtml(item.feedback || "")}</p>`
  ));
  renderFeedbackList(elements.alternativeList, state.diagnosis.analysis?.alternative, (item) => (
    `<strong>${escapeHtml(item.original || "表达可优化")}</strong><p>${escapeHtml(item.reason || "")}</p><p>建议：${escapeHtml(item.betterTranslation || "")}</p>`
  ));
  renderFeedbackList(elements.missedList, state.diagnosis.analysis?.missed, (item) => (
    `<strong>${escapeHtml(item.text || "遗漏要点")}</strong><p>${escapeHtml(item.meaning || "")}</p><p>${escapeHtml(item.reason || "")}</p>`
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
    return;
  }

  elements.knowledgePanel.classList.remove("hidden");
  elements.knowledgeList.innerHTML = points
    .map((point, index) => {
      const checked = state.selectedPointIndexes.has(index) ? "checked" : "";
      return `
        <article class="knowledge-card">
          <label>
            <input type="checkbox" data-point-index="${index}" ${checked} />
            <span>
              <span class="knowledge-title">
                <strong>${escapeHtml(point.content || "")}</strong>
                <span class="pill">${escapeHtml(point.type || "point")}</span>
              </span>
              <p>${escapeHtml(point.meaning || "")}</p>
              <p class="muted">${escapeHtml(point.explanation || "")}</p>
            </span>
          </label>
        </article>
      `;
    })
    .join("");

  elements.knowledgeList.querySelectorAll("input[type='checkbox']").forEach((input) => {
    input.addEventListener("change", () => {
      const index = Number(input.dataset.pointIndex);
      if (input.checked) {
        state.selectedPointIndexes.add(index);
      } else {
        state.selectedPointIndexes.delete(index);
      }
    });
  });
}

async function saveSelectedKnowledge() {
  const selectedText = elements.selectedText.value.trim();
  const points = (state.diagnosis?.knowledgePoints || []).filter((_, index) =>
    state.selectedPointIndexes.has(index)
  );

  if (!state.diagnosis || points.length === 0) {
    showToast("请先选择要存入的知识点。", "error");
    return;
  }

  const articleId = buildWebArticleId(state.selection.pageUrl);
  const paragraphId = buildWebParagraphId(state.selection.pageUrl, selectedText);
  const articleTitle = state.selection.pageTitle || state.selection.pageUrl || "网页阅读片段";

  setBusy(elements.saveKnowledgeButton, true, "正在存入知识库...");

  try {
    const result = await saveKnowledgePoints({
      articleId,
      articleTitle,
      paragraphId,
      points,
    });
    showToast(`已存入 ${result.count || points.length} 个知识点`);
    state.selectedPointIndexes.clear();
    renderKnowledgePoints();
  } catch (error) {
    showToast(error.message || "存入知识库失败。", "error");
  } finally {
    setBusy(elements.saveKnowledgeButton, false, "存入知识库");
  }
}

async function openWebApp() {
  const settings = await getSettings();
  await chrome.tabs.create({ url: settings.apiBaseUrl });
}

function setBusy(button, busy, text) {
  button.disabled = busy;
  button.textContent = text;
}

function showToast(message, type = "success") {
  elements.toast.textContent = message;
  elements.toast.classList.toggle("error", type === "error");
  elements.toast.classList.remove("hidden");

  setTimeout(() => {
    elements.toast.classList.add("hidden");
  }, 3200);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
