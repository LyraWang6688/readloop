/**
 * 插件侧自测（不连网络、不需要任何凭证）。
 *
 * 用 vm.SourceTextModule 加载 extension/src 下的真实模块，把 chrome.* 与 fetch 换成内存假实现，
 * 验证：设置分仓、app_token 解析、服务端信封与 401/402 提示、配对接口、飞书写表全链路
 * （token 缓存、表名解析、capture 写入、知识点先查后写、单选补选项、各类错误文案）。
 *
 * 运行：node --experimental-vm-modules extension/tools/selftest.mjs
 * 它只用于开发自查，不被 manifest 引用，也不参与插件运行。
 */

import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------- 假 chrome.storage ----------

const storageState = { sync: {}, local: {} };

function pickKeys(source, keys) {
  if (keys === null || keys === undefined) {
    return { ...source };
  }
  if (typeof keys === "string") {
    return { [keys]: source[keys] };
  }
  if (Array.isArray(keys)) {
    const result = {};
    for (const key of keys) {
      if (key in source) {
        result[key] = source[key];
      }
    }
    return result;
  }
  return { ...source, ...keys };
}

const chromeMock = {
  storage: {
    sync: {
      get: (keys) => Promise.resolve(pickKeys(storageState.sync, keys)),
      set: (patch) => {
        Object.assign(storageState.sync, patch);
        return Promise.resolve();
      },
    },
    local: {
      get: (keys) => Promise.resolve(pickKeys(storageState.local, keys)),
      set: (patch) => {
        Object.assign(storageState.local, patch);
        return Promise.resolve();
      },
    },
  },
};

// ---------- 假 fetch 路由 ----------

let router = async () => {
  throw new Error("没有设置 fetch 路由");
};

async function mockFetch(url, init) {
  return router(String(url), init || {});
}

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

const context = vm.createContext({
  chrome: chromeMock,
  fetch: mockFetch,
  console,
  setTimeout,
  clearTimeout,
  URL,
  AbortSignal,
});

const moduleCache = new Map();

async function loadModule(entry) {
  const abs = resolve(entry);

  async function load(identifier) {
    if (moduleCache.has(identifier)) {
      return moduleCache.get(identifier);
    }
    const mod = new vm.SourceTextModule(readFileSync(identifier, "utf8"), { context, identifier });
    moduleCache.set(identifier, mod);
    await mod.link(async (specifier, referencingModule) => {
      const target = resolve(dirname(referencingModule.identifier), specifier);
      return load(target);
    });
    return mod;
  }

  const mod = await load(abs);
  await mod.evaluate();
  return mod.namespace;
}

// ---------- 测试框架 ----------

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`✅ ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`❌ ${name}`);
    console.error(`   ${error?.message || error}`);
  }
}

function json(value) {
  return JSON.parse(JSON.stringify(value));
}

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

// ---------- 开始 ----------

const storage = await loadModule(resolve(ROOT, "src/lib/storage.js"));
const api = await loadModule(resolve(ROOT, "src/lib/api.js"));
const feishu = await loadModule(resolve(ROOT, "src/lib/feishu.js"));
const ids = await loadModule(resolve(ROOT, "src/lib/ids.js"));

console.log("— 设置与存储 —");

await test("密钥只写 chrome.storage.local，非敏感配置写 sync", async () => {
  await storage.saveSettings({
    apiBaseUrl: "http://localhost:3000/",
    hostToken: "host-token-abc",
    model: {
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com/v1/",
      model: "deepseek-chat",
      apiKey: "sk-test-key",
    },
    feishu: { appId: "cli_test", appSecret: "secret-test", appToken: "bas_token" },
  });

  assert.equal(storageState.local.hostToken, "host-token-abc");
  assert.equal(storageState.local.modelApiKey, "sk-test-key");
  assert.equal(storageState.local.feishuAppSecret, "secret-test");
  assert.equal(storageState.sync.apiBaseUrl, "http://localhost:3000");
  assert.equal(storageState.sync.modelBaseUrl, "https://api.deepseek.com/v1");
  assert.equal(storageState.sync.feishuAppId, "cli_test");
  assert.equal(storageState.sync.feishuAppToken, "bas_token");

  const syncedKeys = Object.keys(storageState.sync);
  assert.ok(!syncedKeys.some((key) => /secret|token/i.test(key) && key !== "feishuAppToken" && key !== "hostToken"), "sync 不应出现密钥");
  assert.ok(!JSON.stringify(storageState.sync).includes("sk-test-key"));
  assert.ok(!JSON.stringify(storageState.sync).includes("secret-test"));
});

await test("getSettings 读出完整配置并带默认值", async () => {
  const settings = json(await storage.getSettings());
  assert.equal(settings.apiBaseUrl, "http://localhost:3000");
  assert.equal(settings.hostToken, "host-token-abc");
  assert.equal(settings.model.model, "deepseek-chat");
  assert.equal(settings.model.apiKey, "sk-test-key");
  assert.equal(settings.feishu.appId, "cli_test");
  assert.equal(settings.feishu.appSecret, "secret-test");
  assert.equal(settings.feishu.appToken, "bas_token");
});

await test("parseAppToken 解析 base/app 链接、查询参数与裸 token", () => {
  assert.equal(storage.parseAppToken("https://my.feishu.cn/base/KEjLbvKg7aT8RpsyDzBcIJbinhf?table=tbl123&view=vew1"), "KEjLbvKg7aT8RpsyDzBcIJbinhf");
  assert.equal(storage.parseAppToken("https://x.feishu.cn/app/bascnAbCdEf123"), "bascnAbCdEf123");
  assert.equal(storage.parseAppToken("https://x.feishu.cn/base/xxx?app_token=QUERYTOKEN1"), "QUERYTOKEN1");
  assert.equal(storage.parseAppToken("bascnRawToken123"), "bascnRawToken123");
  assert.equal(storage.parseAppToken("https://x.feishu.cn/wiki/abc123"), "");
  assert.equal(storage.parseAppToken("不是链接"), "");
  assert.equal(storage.parseAppToken(""), "");
});

await test("normalizeApiBaseUrl 去掉尾部斜杠并兜底默认值", () => {
  assert.equal(storage.normalizeApiBaseUrl("https://a.example///"), "https://a.example");
  assert.equal(storage.normalizeApiBaseUrl(""), storage.DEFAULT_API_BASE_URL);
});

await test("maskSecret 不泄露完整密钥", () => {
  assert.equal(storage.maskSecret("host-token-abc"), "host…-abc");
  assert.ok(!storage.maskSecret("host-token-abcdef").includes("token"));
  assert.equal(storage.maskSecret("短"), "已填写");
});

await test("ids.js 生成稳定 id", () => {
  assert.equal(ids.buildWebArticleId("https://a.example"), ids.buildWebArticleId("https://a.example"));
  assert.notEqual(ids.buildWebArticleId("https://a.example"), ids.buildArticleId?.("https://b.example"));
  assert.ok(ids.buildWebParagraphId("https://a.example", "hello").startsWith("web_"));
});

console.log("\n— ReadLoop 服务接口 —");

await test("diagnose 发送 Bearer、BYOK model 与原文/译文，并归一化返回", async () => {
  let captured = null;
  router = async (url, init) => {
    captured = { url, init };
    return jsonResponse(200, {
      success: true,
      data: {
        aiTranslation: "参考译文",
        analysis: { correct: [{ text: "A", feedback: "对" }], alternative: [], missed: [] },
        knowledgePoints: [{ content: "subsequent", type: "word", meaning: "随后的", explanation: "易混", example: "例句" }, { content: "" }],
        paragraphId: "web_x",
      },
    });
  };

  const result = json(
    await api.diagnoseSelection({
      articleId: "web_a",
      paragraphId: "web_p",
      selectedText: "The subsequent chapter…",
      userTranslation: "接下来的章节……",
    })
  );

  assert.equal(captured.url, "http://localhost:3000/api/diagnose");
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.init.headers.Authorization, "Bearer host-token-abc");
  const body = JSON.parse(captured.init.body);
  assert.equal(body.originalParagraph, "The subsequent chapter…");
  assert.equal(body.userTranslation, "接下来的章节……");
  assert.equal(body.model.base_url, "https://api.deepseek.com/v1");
  assert.equal(body.model.model, "deepseek-chat");
  assert.equal(body.model.api_key, "sk-test-key");
  assert.equal(body.model.provider, "deepseek");
  assert.equal(result.aiTranslation, "参考译文");
  assert.equal(result.knowledgePoints.length, 1, "空 content 的点应被过滤");
  assert.equal(result.knowledgePoints[0].type, "word");
});

await test("402 映射成「年度授权已到期」可读提示", async () => {
  router = async () => jsonResponse(402, { success: false, error: { code: "LICENSE_EXPIRED", message: "license expired" } });
  await assert.rejects(
    () => api.diagnoseSelection({ articleId: "a", paragraphId: "p", selectedText: "x", userTranslation: "中文译文五个字" }),
    (error) => {
      assert.equal(error.name, "ApiError");
      assert.equal(error.status, 402);
      assert.match(error.message, /年度授权已到期/);
      assert.match(error.hint, /数据都在自己的飞书表格|续费/);
      assert.match(api.describeApiError(error), /年度授权已到期/);
      return true;
    }
  );
});

await test("401 提示重新激活 host_token", async () => {
  router = async () => jsonResponse(401, { success: false, error: { code: "UNAUTHORIZED", message: "invalid host token" } });
  await assert.rejects(
    () => api.diagnoseSelection({ articleId: "a", paragraphId: "p", selectedText: "x", userTranslation: "中文译文五个字" }),
    (error) => {
      assert.equal(error.status, 401);
      assert.match(error.message, /host_token/);
      assert.match(error.hint, /重新激活/);
      return true;
    }
  );
});

await test("429 / 500 / 无法解析的响应都有可读文案", async () => {
  router = async () => jsonResponse(429, { success: false, error: { message: "too many" } });
  await assert.rejects(
    () => api.diagnoseSelection({ articleId: "a", paragraphId: "p", selectedText: "x", userTranslation: "中文译文五个字" }),
    (error) => /限流/.test(error.message) && /30 秒/.test(error.hint)
  );

  router = async () => jsonResponse(503, { success: false, error: { message: "LLM 炸了" } });
  await assert.rejects(
    () => api.diagnoseSelection({ articleId: "a", paragraphId: "p", selectedText: "x", userTranslation: "中文译文五个字" }),
    (error) => /服务暂时异常/.test(error.message) && /LLM 炸了/.test(error.message)
  );

  router = async () => ({ ok: true, status: 200, json: async () => { throw new Error("bad json"); } });
  await assert.rejects(
    () => api.diagnoseSelection({ articleId: "a", paragraphId: "p", selectedText: "x", userTranslation: "中文译文五个字" }),
    (error) => /请求失败（HTTP 200）/.test(error.message)
  );
});

await test("网络不通时提示检查服务地址", async () => {
  router = async () => {
    throw new TypeError("Failed to fetch");
  };
  await assert.rejects(
    () => api.diagnoseSelection({ articleId: "a", paragraphId: "p", selectedText: "x", userTranslation: "中文译文五个字" }),
    (error) => /连不上 ReadLoop 服务/.test(error.message) && /localhost:3000/.test(error.hint) && /host_permissions/.test(error.hint)
  );
});

await test("缺 host_token 时直接给出可读错误（不发请求）", async () => {
  const saved = storageState.local.hostToken;
  delete storageState.local.hostToken;
  let called = false;
  router = async () => {
    called = true;
    return jsonResponse(200, { success: true, data: {} });
  };
  await assert.rejects(
    () => api.diagnoseSelection({ articleId: "a", paragraphId: "p", selectedText: "x", userTranslation: "中文译文五个字" }),
    (error) => /host_token/.test(error.message) && /设置/.test(error.hint)
  );
  assert.equal(called, false);
  storageState.local.hostToken = saved;
});

await test("配对 GET：404=未绑定→null，命中返回凭证，429 抛错", async () => {
  router = async () => jsonResponse(404, { success: false, error: { code: "SETUP_PAIR_CODE_INVALID", message: "pair code invalid" } });
  assert.equal(await api.getPairingCredentials("123456"), null);

  router = async (url, init) => {
    assert.equal(url, "http://localhost:3000/api/setup/app/pair?code=654321");
    assert.equal(init.method, "GET");
    assert.equal(init.headers.Authorization, undefined, "配对 GET 不应带鉴权");
    return jsonResponse(200, { success: true, data: { app_id: "cli_pair", app_secret: "secret_pair", app_token: "bas_pair" } });
  };

  const credentials = json(await api.getPairingCredentials("654321"));
  assert.equal(credentials.appId, "cli_pair");
  assert.equal(credentials.appSecret, "secret_pair");
  assert.equal(credentials.appToken, "bas_pair");

  router = async () => jsonResponse(429, { success: false, error: { message: "too many tries" } });
  await assert.rejects(() => api.getPairingCredentials("111111"), (error) => error.status === 429);

  await assert.rejects(() => api.getPairingCredentials("abc"), (error) => /6 位数字/.test(error.message));
});

await test("配对 POST：带 host_token 与 {session, code}", async () => {
  let captured = null;
  router = async (url, init) => {
    captured = { url, init };
    return jsonResponse(200, { success: true, data: { paired: true } });
  };
  await api.bindPairing({ session: "sess_1", code: "123456" });
  assert.equal(captured.url, "http://localhost:3000/api/setup/app/pair");
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.init.headers.Authorization, "Bearer host-token-abc");
  assert.deepEqual(JSON.parse(captured.init.body), { session: "sess_1", code: "123456" });
});

console.log("\n— 飞书直写 —");

// 假多维表格
const KP_FIELD_TYPES = {
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

const CE_FIELD_TYPES = {
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

const fake = {
  tokenCalls: 0,
  calls: [],
  permissionMode: false,
  tablesMode: "normal",
  tables: [
    { table_id: "tblKp", name: "knowledge_points" },
    { table_id: "tblCe", name: "capture_events" },
  ],
  fields: {
    tblKp: Object.entries(KP_FIELD_TYPES).map(([name, type], index) => ({
      field_id: `fldKp${index}`,
      field_name: name,
      type,
      property: type === 3 ? { options: [{ id: `opt${index}`, name: name === "类型" ? "word" : "new", color: 0 }] } : undefined,
    })),
    tblCe: Object.entries(CE_FIELD_TYPES).map(([name, type], index) => ({
      field_id: `fldCe${index}`,
      field_name: name,
      type,
      property: undefined,
    })),
  },
  records: {
    tblKp: [
      {
        record_id: "rec_existing",
        fields: { 归一化内容: "subsequent", 暴露次数: 2, 待练次数: 3 },
      },
    ],
    tblCe: [],
  },
};

function setFeishuRouter() {
  router = async (url, init) => {
    const method = init.method || "GET";
    const { pathname } = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;
    fake.calls.push({ url, method, body });

    if (pathname === "/open-apis/auth/v3/tenant_access_token/internal") {
      fake.tokenCalls += 1;
      return jsonResponse(200, { code: 0, msg: "ok", tenant_access_token: "tok-1", expire: 7200 });
    }

    const tablesMatch = pathname.match(/^\/open-apis\/bitable\/v1\/apps\/[^/]+\/tables$/);
    if (tablesMatch) {
      if (fake.tablesMode === "empty") {
        return jsonResponse(200, { code: 0, data: { items: [{ table_id: "tblOther", name: "别的表" }], has_more: false } });
      }
      return jsonResponse(200, { code: 0, data: { items: fake.tables, has_more: false } });
    }

    const fieldsMatch = pathname.match(/\/tables\/([^/]+)\/fields$/);
    if (fieldsMatch) {
      const tableId = fieldsMatch[1];
      let fields = fake.fields[tableId] || [];
      if (fake.tablesMode === "missingfield" && tableId === "tblKp") {
        fields = fields.filter((field) => field.field_name !== "例句");
      }
      return jsonResponse(200, { code: 0, data: { items: fields, has_more: false } });
    }

    const fieldsUpdateMatch = pathname.match(/\/tables\/([^/]+)\/fields\/([^/]+)$/);
    if (fieldsUpdateMatch && method === "PUT") {
      const [, tableId, fieldId] = fieldsUpdateMatch;
      const field = (fake.fields[tableId] || []).find((item) => item.field_id === fieldId);
      field.property = { options: body.property.options };
      return jsonResponse(200, { code: 0, data: { field } });
    }

    const searchMatch = pathname.match(/\/tables\/([^/]+)\/records\/search$/);
    if (searchMatch && method === "POST") {
      if (fake.permissionMode) {
        return jsonResponse(403, { code: 1254002, msg: "No permission to operate on this app" });
      }
      const tableId = searchMatch[1];
      const condition = body.filter.conditions[0];
      const value = condition.value[0];
      const hit = (fake.records[tableId] || []).find((record) => record.fields[condition.field_name] === value);
      return jsonResponse(200, { code: 0, data: { items: hit ? [hit] : [], has_more: false } });
    }

    const updateMatch = pathname.match(/\/tables\/([^/]+)\/records\/([^/]+)$/);
    if (updateMatch && method === "PUT") {
      if (fake.permissionMode) {
        return jsonResponse(403, { code: 1254002, msg: "No permission" });
      }
      const [, tableId, recordId] = updateMatch;
      const record = (fake.records[tableId] || []).find((item) => item.record_id === recordId);
      Object.assign(record.fields, body.fields);
      return jsonResponse(200, { code: 0, data: { record } });
    }

    const createMatch = pathname.match(/\/tables\/([^/]+)\/records$/);
    if (createMatch && method === "POST") {
      if (fake.permissionMode) {
        return jsonResponse(403, { code: 1254002, msg: "No permission" });
      }
      const tableId = createMatch[1];
      const record = { record_id: `rec_${fake.records[tableId].length + 1}`, fields: body.fields };
      fake.records[tableId].push(record);
      return jsonResponse(200, { code: 0, data: { record } });
    }

    throw new Error(`未处理的飞书请求：${method} ${url}`);
  };
}

const capture = {
  pageUrl: "https://example.com/article",
  pageTitle: "Example Article",
  selectedText: "The subsequent chapter explains even though it is hard.",
  userTranslation: "接下来的章节解释了即使这很难。",
  aiTranslation: "后续章节解释了尽管这很难。",
  diagnosis: { correct: [], alternative: [], missed: [] },
  capturedAt: Date.now(),
};

const selectedPoints = [
  { content: "subsequent", type: "word", meaning: "随后的", explanation: "易与 subsequent 混淆", example: "The subsequent chapter…" },
  { content: "even though", type: "phrase", meaning: "即使/尽管", explanation: "让步", example: "" },
  { content: "as a result", type: "pattern", meaning: "因此", explanation: "因果", example: "" },
];

await test("首次配置错误：token 换不到时提示核对 App ID/Secret 并发布版本", async () => {
  await storage.saveSettings({ feishu: { appId: "cli_test", appSecret: "secret-test", appToken: "bas_token" } });
  router = async () => jsonResponse(401, { code: 10003, msg: "invalid app_id" });
  await assert.rejects(
    () => feishu.testFeishuConnection(),
    (error) => {
      assert.equal(error.name, "FeishuError");
      assert.match(error.message, /App ID \/ App Secret/);
      assert.match(error.hint, /发布/);
      return true;
    }
  );
});

await test("testFeishuConnection：换 token → 解析两张表 → 校验字段", async () => {
  fake.tokenCalls = 0;
  setFeishuRouter();
  const result = json(await feishu.testFeishuConnection());
  assert.equal(fake.tokenCalls, 1);
  assert.equal(result.appId, "cli_test");
  assert.equal(result.tables.length, 2);
  assert.equal(result.tables[0].name, "knowledge_points");
  assert.equal(result.tables[0].fieldCount, 17);
  assert.equal(result.tables[1].name, "capture_events");
});

await test("入库：token 复用缓存、capture 写入、知识点先查后写、单选补选项", async () => {
  const tokenCallsBefore = fake.tokenCalls;
  const summary = json(await feishu.syncCaptureToFeishu({ capture, extractedPoints: selectedPoints, selectedPoints }));

  assert.equal(fake.tokenCalls, tokenCallsBefore, "token 应命中缓存，不重复换取");
  assert.equal(summary.created, 2);
  assert.equal(summary.updated, 1);
  assert.equal(summary.failures.length, 0);
  assert.equal(summary.captureSaved, true);
  assert.equal(summary.isNew, true);

  // 命中：暴露次数 +1、待练次数 +1、最近暴露刷新
  const existing = fake.records.tblKp.find((record) => record.record_id === "rec_existing");
  assert.equal(existing.fields.暴露次数, 3);
  assert.equal(existing.fields.待练次数, 4);
  assert.ok(existing.fields.最近暴露 > 1e12);

  // 新建：字段与 schema 默认值
  const created = fake.records.tblKp.filter((record) => record.record_id !== "rec_existing");
  assert.equal(created.length, 2);
  const phrase = created.find((record) => record.fields.归一化内容 === "eventhough");
  assert.ok(phrase, "应写入归一化内容");
  assert.equal(phrase.fields.知识点, "even though");
  assert.equal(phrase.fields.类型, "phrase");
  assert.equal(phrase.fields.状态, "new");
  assert.equal(phrase.fields.间隔天数, 0);
  assert.equal(phrase.fields.难度因子, 2.5);
  assert.equal(phrase.fields.连对次数, 0);
  assert.equal(phrase.fields.答错次数, 0);
  assert.equal(phrase.fields.待练次数, 3);
  assert.equal(phrase.fields.暴露次数, 1);
  assert.ok(phrase.fields.下次复习 > 1e12, "日期字段应是毫秒时间戳");
  assert.ok(phrase.fields.最近暴露 > 1e12);
  assert.deepEqual(phrase.fields.来源链接, { link: "https://example.com/article", text: "https://example.com/article" });
  assert.equal(phrase.fields.来源原句, capture.selectedText);
  assert.equal(phrase.fields.例句, capture.selectedText, "没有 example 时例句回退到选中原文");

  // 单选字段补选项（phrase / pattern 不在初始选项里）
  const typeField = fake.fields.tblKp.find((field) => field.field_name === "类型");
  const optionNames = typeField.property.options.map((option) => option.name);
  assert.ok(optionNames.includes("word"));
  assert.ok(optionNames.includes("phrase"));
  assert.ok(optionNames.includes("pattern"));
  assert.ok(optionNames.includes("comprehension_point") === false, "只补实际用到的选项");

  // 采集记录
  assert.equal(fake.records.tblCe.length, 1);
  const captureRecord = fake.records.tblCe[0].fields;
  assert.ok(captureRecord.采集时间 > 1e12);
  assert.deepEqual(captureRecord.页面链接, { link: "https://example.com/article", text: "https://example.com/article" });
  assert.equal(captureRecord.页面标题, "Example Article");
  assert.equal(captureRecord.选中原文, capture.selectedText);
  assert.equal(captureRecord.我的译文, capture.userTranslation);
  assert.equal(captureRecord.AI参考译文, capture.aiTranslation);
  assert.equal(captureRecord.抽出的知识点, "subsequent, eventhough, asaresult");
  assert.equal(captureRecord.是否新点, true);
  assert.ok(typeof captureRecord.诊断结果 === "string" && captureRecord.诊断结果.includes("analysis") === false);
});

await test("第二次入库：全部命中，只累加不新建", async () => {
  const before = fake.records.tblKp.length;
  const summary = json(await feishu.syncCaptureToFeishu({ capture, extractedPoints: selectedPoints, selectedPoints }));
  assert.equal(summary.created, 0);
  assert.equal(summary.updated, 3);
  assert.equal(fake.records.tblKp.length, before);
});

await test("空勾选 / 空原文给出可读错误且不写表", async () => {
  await assert.rejects(
    () => feishu.syncCaptureToFeishu({ capture, extractedPoints: [], selectedPoints: [] }),
    (error) => /还没有勾选任何知识点/.test(error.message)
  );
  await assert.rejects(
    () => feishu.syncCaptureToFeishu({ capture: { ...capture, selectedText: "  " }, selectedPoints }),
    (error) => /选中原文为空/.test(error.message)
  );
});

await test("飞书 403/无权限：提示加 bitable:app 与设为可编辑", async () => {
  fake.permissionMode = true;
  await assert.rejects(
    () => feishu.syncCaptureToFeishu({ capture, extractedPoints: selectedPoints, selectedPoints }),
    (error) => {
      assert.equal(error.name, "FeishuError");
      assert.match(error.message, /入库中断/);
      assert.match(error.message, /读写权限/);
      assert.match(error.hint, /bitable:app/);
      assert.match(error.hint, /可编辑/);
      return true;
    }
  );
  fake.permissionMode = false;
});

await test("找不到表：列出当前表格里的表名", async () => {
  await storage.saveSettings({ feishu: { appToken: "bas_other" } });
  fake.tablesMode = "empty";
  setFeishuRouter();
  await assert.rejects(
    () => feishu.testFeishuConnection(),
    (error) => /找不到表/.test(error.message) && /别的表/.test(error.hint)
  );
  fake.tablesMode = "normal";
});

await test("字段缺失：提示字段不完整、不要改模板字段名", async () => {
  await storage.saveSettings({ feishu: { appToken: "bas_missingfield" } });
  fake.tablesMode = "missingfield";
  setFeishuRouter();
  await assert.rejects(
    () => feishu.testFeishuConnection(),
    (error) => /字段不完整/.test(error.message) && /例句/.test(error.message) && /模板/.test(error.hint)
  );
  fake.tablesMode = "normal";
});

await test("配置不完整：直接提示缺哪几项", async () => {
  await storage.saveSettings({ feishu: { appId: "", appSecret: "", appToken: "" } });
  await assert.rejects(
    () => feishu.testFeishuConnection(),
    (error) => /飞书配置不完整/.test(error.message) && /App ID/.test(error.message) && /App Secret/.test(error.message)
  );
});

await test("normalizeContent：小写去空白", () => {
  assert.equal(feishu.normalizeContent(" Even  Though "), "eventhough");
  assert.equal(feishu.normalizeContent("ＡＳ　Ａ RESULT"), "ａｓａresult");
  assert.equal(feishu.normalizeContent(null), "");
});

await test("describeFeishuError 带上下一步提示", async () => {
  await storage.saveSettings({ feishu: { appId: "", appSecret: "", appToken: "" } });
  try {
    await feishu.testFeishuConnection();
    assert.fail("应该抛错");
  } catch (error) {
    const text = feishu.describeFeishuError(error);
    assert.match(text, /飞书配置不完整/);
    assert.match(text, /设置/);
  }
});


console.log("\n— content script（vm 模拟 DOM） —");

await test("content script：回复选区查询、划词上报、空选区/重复选区不上报", async () => {
  const selectionState = { text: "first selection" };
  const listeners = { mouseup: [], keyup: [] };
  const sentMessages = [];
  let messageListener = null;

  const documentMock = {
    title: "Article Title",
    addEventListener(type, handler) {
      (listeners[type] || (listeners[type] = [])).push(handler);
    },
  };
  const windowMock = {
    getSelection: () => ({ toString: () => selectionState.text }),
    location: { href: "https://example.com/post" },
  };
  const contentChrome = {
    runtime: {
      onMessage: { addListener(fn) { messageListener = fn; } },
      sendMessage(message) { sentMessages.push(message); return Promise.resolve(); },
    },
  };

  const contentContext = vm.createContext({ document: documentMock, window: windowMock, chrome: contentChrome, setTimeout, clearTimeout });
  new vm.Script(readFileSync(resolve(ROOT, "src/content-script.js"), "utf8"), { filename: "content-script.js" }).runInContext(contentContext);

  const response = await new Promise((resolveResponse) => {
    const handled = messageListener({ type: "READINSIGHT_GET_SELECTION" }, null, resolveResponse);
    assert.equal(handled, true);
  });
  assert.equal(response.selection.selectedText, "first selection");
  assert.equal(response.selection.pageUrl, "https://example.com/post");
  assert.equal(response.selection.pageTitle, "Article Title");

  assert.equal(messageListener({ type: "OTHER_TYPE" }, null, () => {}), false, "未知消息应返回 false");

  listeners.mouseup[0]();
  await sleep(260);
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].type, "READINSIGHT_SELECTION_CHANGED");
  assert.equal(sentMessages[0].payload.selectedText, "first selection");

  listeners.mouseup[0]();
  await sleep(260);
  assert.equal(sentMessages.length, 1, "同一段选区不重复上报");

  selectionState.text = "";
  listeners.keyup[0]();
  await sleep(260);
  assert.equal(sentMessages.length, 1, "空选区不上报");

  selectionState.text = "second selection";
  listeners.keyup[0]();
  await sleep(260);
  assert.equal(sentMessages.length, 2);
  assert.equal(sentMessages[1].payload.selectedText, "second selection");
});

console.log("\n— background service worker（vm 模拟 chrome.*，选区存 storage.session） —");

await test("background：选区持久化 / 右键菜单 / 消息路由（SW 重启不丢）", async () => {
  const listeners = { installed: [], startup: [], message: [], menu: [], activated: [], removed: [] };
  const calls = { menusCreate: [], removeAll: 0, panelOpen: [], panelBehavior: [], broadcasts: [], tabMessages: [] };
  const sessionState = new Map();

  const readSession = (keys) => {
    const out = {};
    if (typeof keys === "string") {
      if (sessionState.has(keys)) out[keys] = sessionState.get(keys);
      return out;
    }
    const list = Array.isArray(keys) ? keys : Object.keys(keys || {});
    for (const key of list) {
      if (sessionState.has(key)) out[key] = sessionState.get(key);
    }
    return out;
  };

  const backgroundChrome = {
    runtime: {
      onInstalled: { addListener(fn) { listeners.installed.push(fn); } },
      onStartup: { addListener(fn) { listeners.startup.push(fn); } },
      onMessage: { addListener(fn) { listeners.message.push(fn); } },
      sendMessage(message) { calls.broadcasts.push(message); return Promise.resolve(); },
      get lastError() { return undefined; },
    },
    contextMenus: {
      create(definition, callback) { calls.menusCreate.push(definition); if (callback) callback(); },
      removeAll(callback) { calls.removeAll += 1; if (callback) callback(); },
      onClicked: { addListener(fn) { listeners.menu.push(fn); } },
    },
    tabs: {
      onActivated: { addListener(fn) { listeners.activated.push(fn); } },
      onRemoved: { addListener(fn) { listeners.removed.push(fn); } },
      query: async () => [{ id: 7, url: "https://example.com/a", title: "A" }],
      sendMessage(tabId, message) {
        calls.tabMessages.push({ tabId, message });
        return Promise.resolve({
          selection: { selectedText: "tab selection", pageUrl: "https://example.com/a", pageTitle: "A", capturedAt: 1 },
        });
      },
    },
    storage: {
      session: {
        get: (keys) => Promise.resolve(readSession(keys)),
        set: (patch) => {
          for (const [key, value] of Object.entries(patch)) sessionState.set(key, value);
          return Promise.resolve();
        },
        remove: (keys) => {
          const list = Array.isArray(keys) ? keys : [keys];
          for (const key of list) sessionState.delete(key);
          return Promise.resolve();
        },
      },
    },
    sidePanel: {
      setPanelBehavior(behavior) { calls.panelBehavior.push(behavior); return Promise.resolve(); },
      open(options) { calls.panelOpen.push(options); return Promise.resolve(); },
    },
  };

  const backgroundContext = vm.createContext({
    chrome: backgroundChrome,
    console,
    setTimeout,
    clearTimeout,
    Map,
    Promise,
    Date,
    Number,
  });
  new vm.Script(readFileSync(resolve(ROOT, "src/background.js"), "utf8"), { filename: "background.js" }).runInContext(backgroundContext);

  const dispatch = (message, sender = {}) =>
    new Promise((resolveResponse) => {
      const returned = listeners.message[0](message, sender, (response) => resolveResponse(response));
      if (returned === false) {
        resolveResponse(null);
      }
      setTimeout(() => resolveResponse(null), 500);
    });

  listeners.installed.forEach((fn) => fn());
  assert.equal(calls.removeAll, 1, "注册菜单前先清理旧菜单");
  assert.equal(calls.menusCreate[0].id, "readloop-practice-selection");
  assert.equal(calls.menusCreate[0].contexts[0], "selection");
  assert.deepEqual(json(calls.panelBehavior[0]), { openPanelOnActionClick: true });

  // ① SW 里没有任何缓存时，GET 会向 content script 补拉一次（点图标打开面板的场景）
  const firstResponse = json(await dispatch({ type: "READINSIGHT_GET_ACTIVE_SELECTION" }));
  assert.equal(firstResponse.selection.selectedText, "tab selection", "无缓存时从页面补拉选区");
  assert.equal(calls.tabMessages.at(-1).tabId, 7);
  assert.equal(calls.tabMessages.at(-1).message.type, "READINSIGHT_GET_SELECTION");
  assert.equal(sessionState.get("activeTabId"), 7, "activeTabId 写进 storage.session");
  assert.equal(sessionState.get("selection:7").selectedText, "tab selection", "选区写进 storage.session");

  // ② content script 上报选区：写入 storage.session 并广播
  const changedResponse = json(
    await dispatch(
      { type: "READINSIGHT_SELECTION_CHANGED", payload: { selectedText: "chosen text", pageUrl: "https://example.com/a", pageTitle: "A", capturedAt: 1 } },
      { tab: { id: 7 } }
    )
  );
  assert.deepEqual(changedResponse, { ok: true });
  assert.equal(calls.broadcasts.at(-1).type, "READINSIGHT_SELECTION_UPDATED");
  assert.equal(calls.broadcasts.at(-1).payload.selectedText, "chosen text");
  assert.equal(sessionState.get("selection:7").selectedText, "chosen text");
  const storedResponse = json(await dispatch({ type: "READINSIGHT_GET_ACTIVE_SELECTION" }));
  assert.equal(storedResponse.selection.selectedText, "chosen text", "有缓存时不再打扰页面");

  // ③ 右键菜单：先记选区 → 开面板 → 再从页面补权威 URL/标题
  await listeners.menu[0](
    { menuItemId: "readloop-practice-selection", selectionText: "menu selection" },
    { id: 9, url: "https://example.com/b", title: "B" }
  );
  await sleep(20);
  assert.equal(calls.panelOpen.at(-1).tabId, 9, "右键菜单应打开侧边栏");
  assert.equal(calls.tabMessages.at(-1).tabId, 9, "打开面板后向该 tab 补拉一次选区");
  assert.equal(sessionState.get("activeTabId"), 9);
  assert.equal(calls.menusCreate[0].title, "用 ReadLoop 练习这段英文");

  // ④ 切 tab：广播该 tab 的选区
  listeners.activated.forEach((fn) => fn({ tabId: 9 }));
  await sleep(20);
  assert.equal(calls.broadcasts.at(-1).payload.selectedText, "tab selection", "切换 tab 时广播该 tab 的选区");
  const menuSelection = json(await dispatch({ type: "READINSIGHT_GET_ACTIVE_SELECTION" }));
  assert.equal(menuSelection.selection.selectedText, "tab selection");

  // ⑤ 手动刷新：重新向页面要
  const refreshed = json(await dispatch({ type: "READINSIGHT_REFRESH_SELECTION" }));
  assert.equal(calls.tabMessages.at(-1).message.type, "READINSIGHT_GET_SELECTION");
  assert.equal(refreshed.selection.selectedText, "tab selection");

  // ⑥ 关闭 tab：清掉该 tab 的选区与 activeTabId，回落到当前 tab
  listeners.removed.forEach((fn) => fn(9));
  await sleep(20);
  assert.equal(sessionState.get("selection:9"), undefined, "关闭 tab 时清掉该 tab 的选区");
  assert.equal(sessionState.get("activeTabId"), undefined, "关闭激活 tab 时清掉 activeTabId");
  const afterClose = json(await dispatch({ type: "READINSIGHT_GET_ACTIVE_SELECTION" }));
  assert.equal(afterClose.selection.selectedText, "chosen text", "回落到当前 tab 之前的选区");

  // ⑦ SW 重启后（内存清空）仍能从 storage.session 读到选区
  sessionState.delete("selection:7");
  sessionState.set("selection:7", { selectedText: "survives restart", pageUrl: "https://example.com/a", pageTitle: "A", capturedAt: 2 });
  const afterRestart = json(await dispatch({ type: "READINSIGHT_GET_ACTIVE_SELECTION" }));
  assert.equal(afterRestart.selection.selectedText, "survives restart", "SW 重启后从 storage.session 恢复选区");
});

console.log(`\n${"─".repeat(48)}`);
if (failures.length === 0) {
  console.log(`✅ ${passed} 项断言组全部通过`);
  process.exit(0);
} else {
  console.error(`❌ ${failures.length} 组失败，${passed} 组通过`);
  process.exit(1);
}
