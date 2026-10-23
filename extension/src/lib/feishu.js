/**
 * 插件侧直连用户自己的飞书多维表格（用户自建的飞书应用）。
 *
 * 为什么在插件里写：
 * - 插件在用户浏览器里，拿不到宿主的飞书能力；后端按设计不持有任何飞书凭证。
 * - 插件靠 manifest 的 host_permissions 直连 open.feishu.cn，写入实时、不经过后端。
 * 参见 docs/ARCHITECTURE.md §4.3。
 *
 * 实现要点：
 * - tenant_access_token 内存缓存，提前 5 分钟过期（令牌失效会自动换一次再重试）。
 * - 表按表名解析 table_id（knowledge_points / capture_events，兼容中文表名）。
 * - knowledge_points 无唯一索引 → 按「归一化内容」先查后写：命中累加暴露/待练，未命中新建。
 * - 单选字段缺选项时用「更新字段」接口补选项；缺 base:field:update 权限给可读提示。
 * - 所有错误抛 FeishuError，message/hint 是中文可读文案，绝不静默失败。
 *
 * 字段名严格按 ai-capability-store/skills/readloop/references/schema.md。
 */

import { getSettings } from "./storage.js";

const FEISHU_ORIGIN = "https://open.feishu.cn";
const REQUEST_TIMEOUT_MS = 20_000;
const TOKEN_EXPIRY_MARGIN_MS = 5 * 60 * 1000;
const CACHE_TTL_MS = 10 * 60 * 1000;
/** schema 规定待练次数上限 8 */
const MAX_PENDING_PRACTICE = 8;
/** model 返回的 JSON 过长时截断，避免写表失败 */
const MAX_JSON_LENGTH = 50_000;

/** 飞书多维表格字段类型编号 */
const FIELD_TYPE = {
  TEXT: 1,
  NUMBER: 2,
  SINGLE_SELECT: 3,
  DATE: 5,
  CHECKBOX: 7,
  URL: 15,
};

/** 表名别名：模板里用英文表名，中文表名也认 */
const TABLE_ALIASES = {
  knowledgePoints: ["knowledge_points", "知识点"],
  captureEvents: ["capture_events", "采集记录"],
};

/** knowledge_points 字段名（表 1） */
const KP = {
  content: "知识点",
  normalized: "归一化内容",
  type: "类型",
  meaning: "释义",
  explanation: "解释",
  example: "例句",
  status: "状态",
  intervalDays: "间隔天数",
  ease: "难度因子",
  streak: "连对次数",
  lapses: "答错次数",
  need: "待练次数",
  encounters: "暴露次数",
  nextReview: "下次复习",
  lastSeen: "最近暴露",
  sourceUrl: "来源链接",
  sourceSentence: "来源原句",
};

/** capture_events 字段名（表 2） */
const CE = {
  capturedAt: "采集时间",
  pageUrl: "页面链接",
  pageTitle: "页面标题",
  selectedText: "选中原文",
  userTranslation: "我的译文",
  aiTranslation: "AI参考译文",
  diagnosis: "诊断结果",
  extractedPoints: "抽出的知识点",
  isNewPoint: "是否新点",
};

const POINT_TYPES = ["word", "phrase", "pattern", "comprehension_point"];

// ---------- 缓存（只存在内存里，不落盘） ----------

const tokenCache = new Map(); // `${appId}:${secretHash}` → { token, expiresAt }
const tablesCache = new Map(); // appToken → { at, byRole }
const fieldsCache = new Map(); // `${appToken}:${tableId}` → { at, fields }

// ---------- 对外错误 ----------

export class FeishuError extends Error {
  /**
   * @param {string} message 用户可见的一句话
   * @param {{hint?: string, detail?: string, status?: number, code?: number, kind?: string}} options
   */
  constructor(message, { hint = "", detail = "", status = 0, code = 0, kind = "unknown" } = {}) {
    super(message);
    this.name = "FeishuError";
    this.hint = hint;
    this.detail = detail;
    this.status = status;
    this.code = code;
    this.kind = kind;
  }
}

/** 拼成一段可直接展示的中文 */
export function describeFeishuError(error) {
  if (error instanceof FeishuError) {
    return error.hint ? `${error.message}\n${error.hint}` : error.message;
  }
  return error?.message || "写入飞书表格失败，请稍后重试。";
}

// ---------- 对外能力 ----------

/**
 * 只读自检：换 token → 解析两张表 → 校验字段。
 * 不写任何数据，适合放在「测试飞书连接」按钮后面。
 */
export async function testFeishuConnection() {
  const ctx = await createContext();
  await getToken(ctx);

  const tables = await resolveTables(ctx, { force: true });
  const knowledgeFields = await loadFields(ctx, tables.knowledgePoints, { force: true });
  requireFields(knowledgeFields, Object.values(KP));
  const captureFields = await loadFields(ctx, tables.captureEvents, { force: true });
  requireFields(captureFields, Object.values(CE));

  return {
    appId: ctx.appId,
    tables: [
      { name: "knowledge_points", tableId: tables.knowledgePoints, fieldCount: knowledgeFields.length },
      { name: "capture_events", tableId: tables.captureEvents, fieldCount: captureFields.length },
    ],
  };
}

/**
 * 一次采集入库：写 capture_events + 逐个写/更新 knowledge_points。
 *
 * @param {object} params
 * @param {{pageUrl?: string, pageTitle?: string, selectedText: string, userTranslation: string, aiTranslation?: string, diagnosis?: object, capturedAt?: number}} params.capture
 * @param {Array<object>} [params.extractedPoints] 诊断抽出的全部知识点（写进采集记录）
 * @param {Array<object>} [params.selectedPoints] 用户勾选、要写入知识点表的点
 * @returns {Promise<{created: number, updated: number, total: number, failures: Array<{content: string, message: string, hint: string}>, captureSaved: boolean, captureError: string, isNew: boolean, tables: object}>}
 */
export async function syncCaptureToFeishu({ capture, extractedPoints = [], selectedPoints = [] }) {
  if (!capture || !readText(capture.selectedText)) {
    throw new FeishuError("选中原文为空，无法入库", {
      hint: "请先在网页里选中一段英文，或在插件里粘贴原文后重新诊断。",
    });
  }
  if (selectedPoints.length === 0) {
    throw new FeishuError("还没有勾选任何知识点", {
      hint: "在诊断结果里勾选要沉淀的知识点，再点「一键存入我的飞书表格」。",
    });
  }

  const ctx = await createContext();
  const tables = await resolveTables(ctx);
  const knowledgeFields = await loadFields(ctx, tables.knowledgePoints);
  requireFields(knowledgeFields, Object.values(KP));
  const captureFields = await loadFields(ctx, tables.captureEvents);
  requireFields(captureFields, Object.values(CE));

  const nowMs = Date.now();
  const todayMs = startOfLocalDay(nowMs);
  const failures = [];
  let created = 0;
  let updated = 0;
  let fatalError = null;

  for (const point of selectedPoints) {
    try {
      const normalized = normalizeContent(point?.content);
      if (!normalized) {
        failures.push({ content: readText(point?.content), message: "知识点内容为空，已跳过", hint: "" });
        continue;
      }

      const type = normalizePointType(point?.type);
      // 单选字段选项缺失时自动补；缺 base:field:update 会抛可读错误
      await ensureSelectOption(ctx, tables.knowledgePoints, KP.type, type);
      await ensureSelectOption(ctx, tables.knowledgePoints, KP.status, "new");

      const existing = await searchRecord(ctx, tables.knowledgePoints, {
        fieldName: KP.normalized,
        value: normalized,
        fieldNames: [KP.normalized, KP.encounters, KP.need],
      });

      if (existing?.record_id) {
        const current = existing.fields || {};
        const encounters = readNumber(current[KP.encounters]);
        const need = readNumber(current[KP.need]);
        const updateFields = buildRecordFields(knowledgeFields, {
          [KP.encounters]: encounters + 1,
          [KP.need]: Math.min(need + 1, MAX_PENDING_PRACTICE),
          [KP.lastSeen]: nowMs,
        });
        await updateRecord(ctx, tables.knowledgePoints, existing.record_id, updateFields);
        updated += 1;
      } else {
        const createFields = buildRecordFields(knowledgeFields, {
          [KP.content]: readText(point?.content),
          [KP.normalized]: normalized,
          [KP.type]: type,
          [KP.meaning]: readText(point?.meaning),
          [KP.explanation]: readText(point?.explanation),
          [KP.example]: readText(point?.example) || readText(capture.selectedText),
          [KP.status]: "new",
          [KP.intervalDays]: 0,
          [KP.ease]: 2.5,
          [KP.streak]: 0,
          [KP.lapses]: 0,
          [KP.need]: 3,
          [KP.encounters]: 1,
          [KP.nextReview]: todayMs,
          [KP.lastSeen]: nowMs,
          [KP.sourceUrl]: readText(capture.pageUrl),
          [KP.sourceSentence]: readText(capture.selectedText),
        });
        await createRecord(ctx, tables.knowledgePoints, createFields);
        created += 1;
      }
    } catch (error) {
      const feishuError = toFeishuError(error);
      failures.push({
        content: readText(point?.content),
        message: feishuError.message,
        hint: feishuError.hint,
      });
      // 凭证 / 权限 / 表结构问题：后面的点也不会成功，直接中断，把已完成的量报告出去
      if (["token", "permission", "table", "field"].includes(feishuError.kind)) {
        fatalError = feishuError;
        break;
      }
    }
  }

  if (fatalError) {
    throw new FeishuError(
      `入库中断：${fatalError.message}（已新建 ${created} 个、更新 ${updated} 个知识点）`,
      { hint: fatalError.hint, detail: fatalError.detail, status: fatalError.status, code: fatalError.code, kind: fatalError.kind }
    );
  }

  // 采集记录最后写：此时才知道有没有新点
  const extracted = (extractedPoints.length > 0 ? extractedPoints : selectedPoints)
    .map((point) => normalizeContent(point?.content))
    .filter(Boolean);

  let captureSaved = false;
  let captureError = "";
  try {
    const captureValues = buildRecordFields(captureFields, {
      [CE.capturedAt]: nowMs,
      [CE.pageUrl]: readText(capture.pageUrl),
      [CE.pageTitle]: readText(capture.pageTitle),
      [CE.selectedText]: readText(capture.selectedText),
      [CE.userTranslation]: readText(capture.userTranslation),
      [CE.aiTranslation]: readText(capture.aiTranslation),
      [CE.diagnosis]: safeJsonStringify(capture.diagnosis),
      [CE.extractedPoints]: extracted.join(", "),
      [CE.isNewPoint]: created > 0,
    });
    await createRecord(ctx, tables.captureEvents, captureValues);
    captureSaved = true;
  } catch (error) {
    const feishuError = toFeishuError(error);
    captureError = describeFeishuError(feishuError);
  }

  return {
    created,
    updated,
    total: selectedPoints.length,
    failures,
    captureSaved,
    captureError,
    isNew: created > 0,
    tables: {
      knowledgePoints: tables.knowledgePoints,
      captureEvents: tables.captureEvents,
    },
  };
}

/** 归一化内容：小写 + 去掉所有空白，用于去重（schema.md 约定） */
export function normalizeContent(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/\s+/g, "");
}

// ---------- 配置与令牌 ----------

async function createContext() {
  const settings = await getSettings();
  const feishu = settings.feishu || {};

  const missing = [];
  if (!feishu.appId) missing.push("App ID");
  if (!feishu.appSecret) missing.push("App Secret");
  if (!feishu.appToken) missing.push("表格链接（app_token）");

  if (missing.length > 0) {
    throw new FeishuError(`飞书配置不完整，缺少：${missing.join("、")}`, {
      hint: "在「设置 → 飞书多维表格」手动填写，或用「一键配置（配对码）」让 AI 宿主把凭证直接送进来。",
      kind: "config",
    });
  }

  return { appId: feishu.appId, appSecret: feishu.appSecret, appToken: feishu.appToken };
}

async function getToken(ctx, { force = false } = {}) {
  const cacheKey = `${ctx.appId}:${hashSecret(ctx.appSecret)}`;
  const cached = tokenCache.get(cacheKey);
  if (!force && cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }

  let payload;
  try {
    payload = await feishuRequest("/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      body: { app_id: ctx.appId, app_secret: ctx.appSecret },
    });
  } catch (error) {
    // 网络类错误原样抛出；其余一律视为凭证问题，给用户可执行的下一步
    if (error instanceof FeishuError && ["network", "timeout", "rate"].includes(error.kind)) {
      throw error;
    }
    throw new FeishuError("飞书拒绝了 App ID / App Secret", {
      hint:
        "到飞书开放平台核对应用凭证：App ID 以 cli_ 开头，App Secret 要复制完整且不能带空格；" +
        "同时确认应用已经发布过版本（不发布权限不生效）。",
      detail: error instanceof FeishuError ? error.detail : String(error?.message || error),
      status: error instanceof FeishuError ? error.status : 0,
      kind: "token",
    });
  }

  const token = readText(payload.tenant_access_token);
  if (!token) {
    throw new FeishuError("飞书没有返回 tenant_access_token", {
      hint: "请稍后重试；如果一直这样，请把这条错误告诉维护者。",
      detail: "响应里缺少 tenant_access_token",
      kind: "token",
    });
  }

  const expireSeconds = Number(payload.expire) || 7200;
  const ttl = Math.max(expireSeconds * 1000 - TOKEN_EXPIRY_MARGIN_MS, 60_000);
  tokenCache.set(cacheKey, { token, expiresAt: Date.now() + ttl });
  return token;
}

// ---------- 请求底座 ----------

async function feishuRequest(path, { method = "GET", query, body, token } = {}) {
  const url = new URL(`${FEISHU_ORIGIN}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const headers = { Accept: "application/json" };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json; charset=utf-8";
  }
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  let response;
  try {
    response = await fetch(url.toString(), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: createTimeoutSignal(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw toFeishuNetworkError(error);
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!payload) {
    throw new FeishuError(`飞书返回了无法解析的响应（HTTP ${response.status}）`, {
      hint: "请稍后重试；如果一直失败，请确认网络没有经过拦截或代理。",
      detail: `HTTP ${response.status} · ${method} ${path}`,
      status: response.status,
      kind: response.status === 401 || response.status === 403 ? "permission" : "unknown",
    });
  }

  if (!response.ok || payload.code !== 0) {
    throw describeFeishuResponseError(response.status, payload, { method, path });
  }

  return payload;
}

/** 需要 token 的多维表格接口 */
async function feishuApi(ctx, path, { method = "GET", query, body, retried = false } = {}) {
  const token = await getToken(ctx);
  try {
    const payload = await feishuRequest(path, { method, query, body, token });
    return payload.data ?? {};
  } catch (error) {
    // 令牌被提前作废（权限变更 / 换应用）时，换一次新令牌再重试一次
    if (!retried && error instanceof FeishuError && error.kind === "token") {
      await getToken(ctx, { force: true });
      return feishuApi(ctx, path, { method, query, body, retried: true });
    }
    throw error;
  }
}

function createTimeoutSignal(timeoutMs) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(timeoutMs);
  }
  return undefined;
}

function toFeishuNetworkError(error) {
  if (error?.name === "TimeoutError" || error?.name === "AbortError") {
    return new FeishuError("飞书接口请求超时", {
      hint: "请检查网络后重试；表格很大或网络波动时偶尔会超时。",
      detail: error?.message || "",
      kind: "timeout",
    });
  }
  return new FeishuError("连不上飞书开放平台（open.feishu.cn）", {
    hint: "请确认当前网络能访问 open.feishu.cn；公司网络限制时请让管理员放行。",
    detail: error?.message || String(error),
    kind: "network",
  });
}

function describeFeishuResponseError(status, payload, { method, path }) {
  const code = Number(payload?.code) || 0;
  const message = readText(payload?.msg) || readText(payload?.message);
  const detail = `HTTP ${status} · code=${code} · ${message || "无错误信息"} · ${method} ${path}`;
  const combined = message;

  const isToken = status === 401 || [99991663, 99991664, 99991661].includes(code) || /access token|tenant_access_token/i.test(combined);
  const isPermission =
    status === 403 ||
    [99991672, 99991679, 1254002].includes(code) ||
    /permission|forbidden|denied|scope|权限/i.test(combined);
  const isField = code === 1254040 || /field.?name.?not.?found|FieldNameNotFound|字段/i.test(combined);
  const isTable = [1254041, 1254005, 1254006].includes(code) || /table.?not.?found|app.?not.?found|表不存在/i.test(combined);
  const isRate = status === 429 || code === 99991400 || /frequency|rate.?limit|too many/i.test(combined);

  if (isToken) {
    return new FeishuError("飞书访问令牌无效或已过期", {
      hint: "请到「设置」点一次「测试飞书连接」重新换取令牌；如果仍然失败，重新配对一次。",
      detail,
      status,
      code,
      kind: "token",
    });
  }
  if (isPermission) {
    return new FeishuError("飞书应用没有这张表的读写权限", {
      hint:
        "两件事都要做：① 在飞书开放平台给应用开通 bitable:app（自动补选项还需要 base:field:update），并发布版本；" +
        "② 在表格右上角 ⋯ → 添加文档应用 → 选中你的应用 → 设为「可编辑」。",
      detail,
      status,
      code,
      kind: "permission",
    });
  }
  if (isField) {
    return new FeishuError("表格字段名对不上", {
      hint: "请确认多维表格是从 ReadLoop 模板复制的，字段名不要改动；改过名就重新复制一份模板。",
      detail,
      status,
      code,
      kind: "field",
    });
  }
  if (isTable) {
    return new FeishuError("在目标表格里找不到对应的表或应用", {
      hint: "请确认设置里的表格链接指向 ReadLoop 模板复制出来的多维表格（…/base/…），并且 app_token 没填错。",
      detail,
      status,
      code,
      kind: "table",
    });
  }
  if (isRate) {
    return new FeishuError("飞书接口调用太频繁，被限流了", {
      hint: "请等几秒后重试；一次入库会写多条记录，不要连续快速点击。",
      detail,
      status,
      code,
      kind: "rate",
    });
  }
  if (status >= 500) {
    return new FeishuError(`飞书服务暂时异常（HTTP ${status}）`, {
      hint: "请稍后重试；连续失败请把这条错误告诉维护者。",
      detail,
      status,
      code,
      kind: "server",
    });
  }
  return new FeishuError(`飞书接口报错${message ? `：${message}` : ""}`, {
    hint: "请检查配置后重试；如果一直失败，请把这条错误告诉维护者。",
    detail,
    status,
    code,
    kind: "unknown",
  });
}

// ---------- 表 / 字段解析 ----------

async function resolveTables(ctx, { force = false } = {}) {
  const cached = tablesCache.get(ctx.appToken);
  if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.byRole;
  }

  const items = [];
  let pageToken = "";
  do {
    const data = await feishuApi(ctx, `/open-apis/bitable/v1/apps/${encodeURIComponent(ctx.appToken)}/tables`, {
      query: { page_size: 100, page_token: pageToken },
    });
    for (const item of data?.items || []) {
      items.push(item);
    }
    pageToken = data?.has_more ? readText(data.page_token) : "";
  } while (pageToken);

  const byRole = { knowledgePoints: "", captureEvents: "" };
  for (const [role, aliases] of Object.entries(TABLE_ALIASES)) {
    const match = items.find((item) => {
      const name = readText(item?.name).toLowerCase();
      return name && aliases.some((alias) => alias.toLowerCase() === name);
    });
    if (match) {
      byRole[role] = readText(match.table_id);
    }
  }

  const missing = Object.entries(byRole)
    .filter(([, tableId]) => !tableId)
    .map(([role]) => TABLE_ALIASES[role][0]);
  if (missing.length > 0) {
    const existing = items.map((item) => readText(item?.name)).filter(Boolean);
    throw new FeishuError(`在目标多维表格里找不到表：${missing.join("、")}`, {
      hint: `请确认表格是用 ReadLoop 模板复制的。当前表格里的表：${existing.length > 0 ? existing.join("、") : "（没有读到任何表）"}。`,
      kind: "table",
    });
  }

  tablesCache.set(ctx.appToken, { at: Date.now(), byRole });
  return byRole;
}

async function loadFields(ctx, tableId, { force = false } = {}) {
  const cacheKey = `${ctx.appToken}:${tableId}`;
  const cached = fieldsCache.get(cacheKey);
  if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.fields;
  }

  const fields = [];
  let pageToken = "";
  do {
    const data = await feishuApi(
      ctx,
      `/open-apis/bitable/v1/apps/${encodeURIComponent(ctx.appToken)}/tables/${encodeURIComponent(tableId)}/fields`,
      { query: { page_size: 100, page_token: pageToken } }
    );
    for (const item of data?.items || []) {
      fields.push(item);
    }
    pageToken = data?.has_more ? readText(data.page_token) : "";
  } while (pageToken);

  fieldsCache.set(cacheKey, { at: Date.now(), fields });
  return fields;
}

function requireFields(fields, names) {
  const missing = names.filter((name) => !fields.some((field) => readText(field?.field_name) === name));
  if (missing.length > 0) {
    throw new FeishuError(`表格字段不完整，缺少：${missing.join("、")}`, {
      hint: "请确认多维表格是从 ReadLoop 模板复制的，字段名不能改动；改过名就重新复制一份最新模板。",
      kind: "field",
    });
  }
}

function findField(fields, name) {
  return fields.find((field) => readText(field?.field_name) === name) || null;
}

/**
 * 单选字段缺少某个选项时补上。
 * 需要应用具备 base:field:update 权限；没有权限时给用户可执行的提示，不静默跳过。
 */
async function ensureSelectOption(ctx, tableId, fieldName, optionName) {
  const name = readText(optionName);
  if (!name) {
    return;
  }

  const fields = await loadFields(ctx, tableId);
  const field = findField(fields, fieldName);
  if (!field) {
    throw new FeishuError(`表格缺少字段「${fieldName}」，无法写入`, {
      hint: "请确认表格是从 ReadLoop 模板复制的，字段名不能改动。",
      kind: "field",
    });
  }
  if (Number(field.type) !== FIELD_TYPE.SINGLE_SELECT) {
    return;
  }

  const options = Array.isArray(field.property?.options) ? field.property.options : [];
  if (options.some((option) => readText(option?.name) === name)) {
    return;
  }

  // 保留已存在选项的 id/颜色，只追加新选项，避免把老记录的选项关系打乱
  const nextOptions = options.map((option) => ({
    id: option.id,
    name: option.name,
    color: typeof option.color === "number" ? option.color : 0,
  }));
  nextOptions.push({ name });

  try {
    await feishuApi(
      ctx,
      `/open-apis/bitable/v1/apps/${encodeURIComponent(ctx.appToken)}/tables/${encodeURIComponent(tableId)}/fields/${encodeURIComponent(field.field_id)}`,
      {
        method: "PUT",
        body: { field_name: fieldName, type: FIELD_TYPE.SINGLE_SELECT, property: { options: nextOptions } },
      }
    );
  } catch (error) {
    if (error instanceof FeishuError && ["permission", "token"].includes(error.kind)) {
      throw new FeishuError(`单选字段「${fieldName}」缺少选项「${name}」，自动补充失败：飞书应用缺少 base:field:update 权限`, {
        hint: "到飞书开放平台给应用添加 base:field:update 权限并重新发布版本；或者手动在表格里添加这个选项后重新入库。",
        detail: error.detail,
        kind: "field",
      });
    }
    throw error;
  }

  // 同步更新字段缓存，避免同一批知识点重复补同一个选项
  const cached = fieldsCache.get(`${ctx.appToken}:${tableId}`);
  if (cached) {
    const target = findField(cached.fields, fieldName);
    if (target) {
      target.property = { ...(target.property || {}), options: nextOptions };
    }
  }
}

// ---------- 记录读写 ----------

async function searchRecord(ctx, tableId, { fieldName, value, fieldNames = [] }) {
  const data = await feishuApi(
    ctx,
    `/open-apis/bitable/v1/apps/${encodeURIComponent(ctx.appToken)}/tables/${encodeURIComponent(tableId)}/records/search`,
    {
      method: "POST",
      query: { page_size: 1 },
      body: {
        field_names: fieldNames,
        filter: {
          conjunction: "and",
          conditions: [{ field_name: fieldName, operator: "is", value: [value] }],
        },
      },
    }
  );

  const items = Array.isArray(data?.items) ? data.items : [];
  return items[0] || null;
}

async function createRecord(ctx, tableId, fields) {
  const data = await feishuApi(
    ctx,
    `/open-apis/bitable/v1/apps/${encodeURIComponent(ctx.appToken)}/tables/${encodeURIComponent(tableId)}/records`,
    { method: "POST", body: { fields } }
  );
  return readText(data?.record?.record_id);
}

async function updateRecord(ctx, tableId, recordId, fields) {
  const data = await feishuApi(
    ctx,
    `/open-apis/bitable/v1/apps/${encodeURIComponent(ctx.appToken)}/tables/${encodeURIComponent(tableId)}/records/${encodeURIComponent(recordId)}`,
    { method: "PUT", body: { fields } }
  );
  return readText(data?.record?.record_id);
}

// ---------- 字段值序列化 ----------

/**
 * 按字段类型把值转成飞书接受的格式：
 * - 超链接字段（15）要 { link, text }，直接传字符串会报错
 * - 日期字段（5）传毫秒时间戳
 * - 模板里日期字段若被错建成文本，退化为 YYYY-MM-DD 字符串
 */
function buildRecordFields(fieldsMeta, values) {
  const result = {};
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    const meta = findField(fieldsMeta, name);
    const type = Number(meta?.type) || 0;

    if (type === FIELD_TYPE.URL) {
      const link = String(value);
      result[name] = { link, text: link };
      continue;
    }
    if (type === FIELD_TYPE.DATE) {
      result[name] = typeof value === "number" ? value : Number(value);
      continue;
    }
    if (type === FIELD_TYPE.TEXT && typeof value === "number" && value > 1e12) {
      result[name] = formatDateYmd(value);
      continue;
    }
    result[name] = value;
  }
  return result;
}

// ---------- 小工具 ----------

function normalizePointType(type) {
  const text = readText(type).toLowerCase();
  return POINT_TYPES.includes(text) ? text : "word";
}

function toFeishuError(error) {
  if (error instanceof FeishuError) {
    return error;
  }
  return new FeishuError("写入飞书表格失败", {
    hint: "请稍后重试；如果一直失败，请把这条错误告诉维护者。",
    detail: String(error?.message || error),
  });
}

function startOfLocalDay(ms) {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function formatDateYmd(ms) {
  const date = new Date(ms);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function safeJsonStringify(value) {
  try {
    const text = JSON.stringify(value ?? {});
    return text.length > MAX_JSON_LENGTH ? `${text.slice(0, MAX_JSON_LENGTH)}…（已截断）` : text;
  } catch {
    return "";
  }
}

function readNumber(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 只用作内存缓存 key，不用于任何对外输出 */
function hashSecret(secret) {
  let hash = 2166136261;
  const text = String(secret);
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function readText(value) {
  return typeof value === "string" ? value.trim() : "";
}
