/**
 * 一键创建之后的「三项校验」：凭证能不能用、表能不能读、表能不能写。
 *
 * 为什么需要（docs/ARCHITECTURE.md §4.3、docs/API_IMPLEMENTATION.md §6）：
 * 手动创建应用时有三个最容易漏的步骤——开通 `bitable:app`、发布版本、
 * 把应用加成表格协作者并设为「可编辑」。前两个由本服务自动做，第三个只能
 * 靠这里的校验要用户去点两下。**能读不代表能写**，所以第三项必须真的写一条。
 *
 * 约定：
 *   - 任何一步失败都只是「checks 里那一项 failed」，**不能让整个创建失败**，
 *     宿主照样能拿到 app_id 并把「差哪一步」告诉用户
 *   - 返回的 `details` 是给用户/宿主看的中文原因，**不得出现 Secret 或 tenant token**
 *   - 这里不调用 SDK，只用 `fetch` 打飞书 OpenAPI（nodejs runtime，见路由的
 *     `export const runtime = "nodejs"`）；不联网时所有请求都会超时，不影响纯逻辑自测
 */

import type { SetupCheckResult } from "./session-store";

// ============================================================
// 常量
// ============================================================

const OPEN_API_BASE = "https://open.feishu.cn/open-apis";

/** 单次请求超时：三项校验是同步跑在创建链路上的，不能让宿主等太久 */
const REQUEST_TIMEOUT_MS = 10_000;

const PAGE_SIZE = 100;

/** 写测试用的标记值；删不掉时用户能在表里搜到它 */
const WRITE_TEST_VALUE = "__readloop_setup_check__";

/**
 * knowledge_points 表的可接受名字。
 * 模板里的表名可能是英文 `knowledge_points`，也可能是中文「知识点」
 * （见 Store 的 references/schema.md），两种都认。
 */
const KNOWLEDGE_POINTS_TABLE_NAMES = ["knowledge_points", "知识点"];

/** 优先用来写测试记录的字段：模板里的两个文本字段 */
const PREFERRED_WRITE_FIELDS = ["归一化内容", "知识点"];

/** 飞书多维表格字段类型：1 = 文本（主字段也是文本） */
const FIELD_TYPE_TEXT = 1;

// ============================================================
// 脱敏
// ============================================================

/**
 * 把已知的敏感串替换掉（不截断）。
 * 用于 `checks.details` 这种要给用户看的文本，保证上游返回什么都漏不出 Secret。
 */
export function sanitizeSecrets(
  text: string,
  secrets: readonly string[] = []
): string {
  let sanitized = text;
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 4) {
      sanitized = sanitized.split(secret).join("***");
    }
  }
  return sanitized;
}

/**
 * 脱敏 + 截断，只用于错误信息 / 日志。
 */
export function redactSecrets(
  text: string,
  secrets: readonly string[] = []
): string {
  const redacted = sanitizeSecrets(text, secrets);
  return redacted.length > 300 ? `${redacted.slice(0, 300)}…` : redacted;
}

/** 拼 checks.details：多段中文结论，最后统一过一遍脱敏 */
function composeDetails(
  parts: string[],
  secrets: readonly string[]
): string {
  return sanitizeSecrets(parts.join("；"), secrets);
}

/** 飞书返回的单条短提示（不含任何凭证） */
function readableMessage(text: unknown): string {
  if (typeof text !== "string") return "";
  const trimmed = text.trim();
  if (!trimmed) return "";
  return trimmed.length > 120 ? `${trimmed.slice(0, 120)}…` : trimmed;
}

// ============================================================
// HTTP 小工具
// ============================================================

interface FeishuResponse {
  /** HTTP 状态码；0 表示没连上（网络错误 / 超时） */
  status: number;
  body: Record<string, unknown> | null;
  networkError?: string;
}

async function callFeishu(
  path: string,
  init: { method: string; token?: string; body?: unknown; secrets?: readonly string[] }
): Promise<FeishuResponse> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
  };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;

  try {
    const response = await fetch(`${OPEN_API_BASE}${path}`, {
      method: init.method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    let body: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = await response.json();
      if (parsed && typeof parsed === "object") {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      body = null;
    }
    return { status: response.status, body };
  } catch {
    return {
      status: 0,
      body: null,
      networkError: redactSecrets(
        "连接飞书失败或超时，请检查网络后重试",
        init.secrets
      ),
    };
  }
}

function feishuCode(body: Record<string, unknown> | null): number | null {
  const code = body?.code;
  return typeof code === "number" ? code : null;
}

function feishuErrorSuffix(response: FeishuResponse): string {
  const code = feishuCode(response.body);
  const message = readableMessage(response.body?.msg);
  const parts: string[] = [];
  if (response.status > 0) parts.push(`HTTP ${response.status}`);
  if (code !== null && code !== 0) parts.push(`飞书错误码 ${code}`);
  const head = parts.length > 0 ? `（${parts.join("，")}）` : "";
  return message ? `${head}：${message}` : head;
}

// ============================================================
// 返回类型
// ============================================================

export interface SetupCheckReport {
  token: SetupCheckResult;
  read: SetupCheckResult;
  write: SetupCheckResult;
  details: string;
}

/** 表字段的最小形状（只取校验要用的两个字段） */
interface TableField {
  name: string;
  type: number | null;
}

/** 表的最小形状 */
interface BaseTable {
  tableId: string;
  name: string;
}

export interface RunSetupChecksInput {
  appId: string;
  appSecret: string;
  appToken: string;
}

// 飞书返回结构的最小声明（只取用到的字段，避免把整个 SDK 的响应类型搬过来）
function parseTables(body: Record<string, unknown> | null): BaseTable[] {
  const data = body?.data;
  if (!data || typeof data !== "object") return [];
  const items = (data as Record<string, unknown>).items;
  if (!Array.isArray(items)) return [];
  const tables: BaseTable[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const tableId = typeof record.table_id === "string" ? record.table_id : "";
    const name = typeof record.name === "string" ? record.name : "";
    if (tableId) tables.push({ tableId, name });
  }
  return tables;
}

function parseFields(body: Record<string, unknown> | null): TableField[] {
  const data = body?.data;
  if (!data || typeof data !== "object") return [];
  const items = (data as Record<string, unknown>).items;
  if (!Array.isArray(items)) return [];
  const fields: TableField[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.field_name !== "string") continue;
    fields.push({
      name: record.field_name,
      type: typeof record.type === "number" ? record.type : null,
    });
  }
  return fields;
}

function pickKnowledgePointsTable(tables: BaseTable[]): BaseTable | null {
  for (const table of tables) {
    const normalized = table.name.trim().toLowerCase();
    if (KNOWLEDGE_POINTS_TABLE_NAMES.some((name) => name.toLowerCase() === normalized)) {
      return table;
    }
  }
  return null;
}

function pickWriteField(fields: TableField[]): TableField | null {
  for (const preferred of PREFERRED_WRITE_FIELDS) {
    const hit = fields.find(
      (field) => field.name === preferred && field.type === FIELD_TYPE_TEXT
    );
    if (hit) return hit;
  }
  return fields.find((field) => field.type === FIELD_TYPE_TEXT) ?? null;
}

function describeVisibleTables(tables: BaseTable[]): string {
  if (tables.length === 0) return "当前应用看不到任何数据表";
  const names = tables.slice(0, 6).map((table) => `「${table.name || table.tableId}」`);
  const more = tables.length > 6 ? ` 等 ${tables.length} 张表` : "";
  return `当前可见的表：${names.join("、")}${more}`;
}

// ============================================================
// 三项校验
// ============================================================

/**
 * 跑三项校验。永不抛错：任何一步失败都收敛成 `failed` + 可读 `details`。
 */
export async function runSetupChecks(
  input: RunSetupChecksInput
): Promise<SetupCheckReport> {
  const secrets = [input.appSecret];
  const details: string[] = [];
  let tenantToken: string | null = null;

  // ---------- ① 换 tenant_access_token：验证凭证本身 ----------
  const tokenResponse = await callFeishu(
    "/auth/v3/tenant_access_token/internal",
    {
      method: "POST",
      body: { app_id: input.appId, app_secret: input.appSecret },
      secrets,
    }
  );
  const token = tokenResponse.body?.tenant_access_token;
  const tokenOk =
    tokenResponse.status === 200 &&
    feishuCode(tokenResponse.body) === 0 &&
    typeof token === "string" &&
    token.length > 0;

  if (!tokenOk) {
    const code = feishuCode(tokenResponse.body);
    const reason =
      tokenResponse.networkError ??
      (code === 10014 || code === 10003 || code === 10012
        ? "App ID / Secret 不正确，请重新发起创建"
        : `换取 tenant_access_token 失败${feishuErrorSuffix(tokenResponse)}`);
    details.push(`① 凭证校验失败：${redactSecrets(reason, secrets)}`);
    details.push("② 未执行（凭证未通过）");
    details.push("③ 未执行（凭证未通过）");
    return {
      token: "failed",
      read: "failed",
      write: "failed",
      details: composeDetails(details, secrets),
    };
  }
  tenantToken = token;
  details.push("① 凭证有效（已换取 tenant_access_token）");

  const tablePath = `/bitable/v1/apps/${encodeURIComponent(input.appToken)}/tables?page_size=${PAGE_SIZE}`;

  // ---------- ② 读表：验证协作者身份 / bitable:app 权限 / 模板是否在 ----------
  const tablesResponse = await callFeishu(tablePath, {
    method: "GET",
    token: tenantToken,
    secrets,
  });
  const tablesOk =
    tablesResponse.status === 200 && feishuCode(tablesResponse.body) === 0;
  if (!tablesOk) {
    const reason = describeReadFailure(tablesResponse, "读取数据表列表失败");
    details.push(`② 读表失败：${reason}`);
    details.push("③ 未执行（读表未通过）");
    return {
      token: "ok",
      read: "failed",
      write: "failed",
      details: composeDetails(details, secrets),
    };
  }

  const tables = parseTables(tablesResponse.body);
  const targetTable = pickKnowledgePointsTable(tables);
  if (!targetTable) {
    details.push(
      `② 读表失败：没找到 knowledge_points（知识点）表。${describeVisibleTables(tables)}。请确认表格链接是 ReadLoop 模板复制出来的那份`
    );
    details.push("③ 未执行（读表未通过）");
    return {
      token: "ok",
      read: "failed",
      write: "failed",
      details: composeDetails(details, secrets),
    };
  }

  const fieldsResponse = await callFeishu(
    `/bitable/v1/apps/${encodeURIComponent(input.appToken)}/tables/${encodeURIComponent(targetTable.tableId)}/fields?page_size=${PAGE_SIZE}`,
    { method: "GET", token: tenantToken, secrets }
  );
  const fieldsOk =
    fieldsResponse.status === 200 && feishuCode(fieldsResponse.body) === 0;
  if (!fieldsOk) {
    const reason = describeReadFailure(fieldsResponse, "读取表字段失败");
    details.push(`② 读表失败：${reason}`);
    details.push("③ 未执行（读表未通过）");
    return {
      token: "ok",
      read: "failed",
      write: "failed",
      details: composeDetails(details, secrets),
    };
  }

  const fields = parseFields(fieldsResponse.body);
  details.push(
    `② 读表成功（找到表「${targetTable.name}」，共 ${fields.length} 个字段）`
  );

  // ---------- ③ 写一条临时记录再删除：验证「可编辑」而不只是「可阅读」 ----------
  const writeField = pickWriteField(fields);
  if (!writeField) {
    details.push(
      "③ 写表失败：表里没有可写的文本字段（模板字段可能被改名了，请用模板复制出来的表）"
    );
    return {
      token: "ok",
      read: "ok",
      write: "failed",
      details: composeDetails(details, secrets),
    };
  }

  const recordsPath = `/bitable/v1/apps/${encodeURIComponent(input.appToken)}/tables/${encodeURIComponent(targetTable.tableId)}/records`;
  const createResponse = await callFeishu(recordsPath, {
    method: "POST",
    token: tenantToken,
    body: { fields: { [writeField.name]: WRITE_TEST_VALUE } },
    secrets,
  });
  const recordId = extractRecordId(createResponse.body);
  const createOk =
    createResponse.status === 200 &&
    feishuCode(createResponse.body) === 0 &&
    recordId !== null;

  if (!createOk) {
    details.push(`③ 写表失败：${describeWriteFailure(createResponse)}`);
    return {
      token: "ok",
      read: "ok",
      write: "failed",
      details: composeDetails(details, secrets),
    };
  }

  const deleteResponse = await callFeishu(`${recordsPath}/${encodeURIComponent(recordId)}`, {
    method: "DELETE",
    token: tenantToken,
    secrets,
  });
  const deleteOk =
    deleteResponse.status === 200 && feishuCode(deleteResponse.body) === 0;

  if (deleteOk) {
    details.push("③ 写表成功（已写入并删除一条临时记录）");
  } else {
    // 写能力已验证通过；但临时记录没删掉，要提醒用户清理
    details.push(
      `③ 写表成功，但临时记录没删掉（${redactSecrets(`可搜索「${WRITE_TEST_VALUE}」手动删除`, secrets)}）`
    );
  }

  const report: SetupCheckReport = {
    token: "ok",
    read: "ok",
    write: "ok",
    details: composeDetails(details, secrets),
  };
  return report;
}

function extractRecordId(body: Record<string, unknown> | null): string | null {
  const data = body?.data;
  if (!data || typeof data !== "object") return null;
  const record = (data as Record<string, unknown>).record;
  if (!record || typeof record !== "object") return null;
  const recordId = (record as Record<string, unknown>).record_id;
  return typeof recordId === "string" && recordId.length > 0 ? recordId : null;
}

function describeReadFailure(response: FeishuResponse, prefix: string): string {
  if (response.networkError) return response.networkError;
  if (response.status === 403 || feishuCode(response.body) === 91403) {
    return `${prefix}：应用还没被加成这张表的协作者（表格右上角 ⋯ → 添加文档应用 → 设为可编辑）`;
  }
  if (response.status === 404) {
    return `${prefix}：表格不存在或应用没有权限（检查表格链接是否发错）`;
  }
  return `${prefix}${feishuErrorSuffix(response)}`;
}

function describeWriteFailure(response: FeishuResponse): string {
  if (response.networkError) return response.networkError;
  const code = feishuCode(response.body);
  if (response.status === 403 || code === 91403) {
    return "应用只有「可阅读」权限：请在表格右上角 ⋯ → 添加文档应用，把权限改成「可编辑」";
  }
  if (code === 1254043 || code === 1254045) {
    return "写入字段不存在或类型不对：模板字段可能被改名/改类型了，请用模板复制出来的表";
  }
  return `写入记录失败${feishuErrorSuffix(response)}`;
}
