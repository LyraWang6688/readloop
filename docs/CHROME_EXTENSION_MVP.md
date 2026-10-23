# Chrome 插件（MV3）开发与使用

`extension/` 是一个静态 Manifest V3 插件，**无构建步骤**，直接用 Chrome「加载已解压的扩展程序」即可。

它不连数据库、不在代码里内置任何密钥。两条外部通道：

| 通道 | 用途 | 鉴权 |
|---|---|---|
| `https://open.feishu.cn/*` | 直写**用户自己的**飞书多维表格 | 用户自建飞书应用的 App ID / Secret（本地保存） |
| ReadLoop 服务（默认 `https://readinsight.bamamei.online`） | 翻译诊断 `/api/diagnose`、配对取凭证 `/api/setup/app/pair` | `Authorization: Bearer <host_token>`（配对那步除外） |

> 数据流向：划词文本 → ReadLoop 服务做诊断 → 结果写回**用户自己的**飞书表。
> 服务端不存用户数据；飞书凭证和模型 Key 只存在 `chrome.storage.local`。

## 本地加载

1. （可选）启动服务：`pnpm dev`（本地默认 `http://localhost:3000`）
2. 打开 `chrome://extensions` → 右上角打开 Developer mode → 「Load unpacked」
3. 选择仓库里的 `extension/` 目录
4. 点工具栏的 ReadLoop 图标打开侧边栏

图标产物在 `extension/assets/icons/`，由 `node extension/tools/gen-icons.mjs` 生成（无第三方依赖）。

## 首次配置（侧边栏设置区）

| 设置项 | 从哪来 |
|---|---|
| 服务地址 | 生产默认 `https://readinsight.bamamei.online`；本地填 `http://localhost:3000` |
| host_token | **一键配置成功时自动填入**（宿主绑定配对码时会把 token 一并交过来）；也可手动粘贴 |
| 模型配置 | 用户自带（BYOK）：`base_url` / `model` / `api_key`，默认推荐 DeepSeek |
| 飞书凭证 | **一键配置**：点「一键配置」显示 6 位配对码 → 把码交给宿主 → 宿主调 `/api/setup/app/pair` 绑定 → 插件自动轮询取回 App ID / Secret / app_token |
| 兜底 | 也可手填 App ID / Secret + 表格链接（服务端 `status?...&reveal_secret=1` 只给一次） |

## 测试链路

1. 打开任意英文网页（HTTPS）。
2. 选中一段英文（右键菜单「用 ReadLoop 练习这段英文」，或直接打开侧边栏）。
3. 在侧边栏输入自己的中文翻译 → 点「AI 对比诊断」。
4. 查看 AI 参考翻译、诊断结果与可沉淀知识点。
5. 点「一键入库」→ 插件**直连飞书**写入 `capture_events`，并把知识点 upsert 进 `knowledge_points`
   （按「归一化内容」先查后写：命中则暴露次数/待练次数 +1、更新最近暴露；未命中则按 schema 默认值新建）。
6. 打开用户自己的飞书 Base 核对两张表。

## 链路结构

```text
Chrome 选区
→ content-script.js（只取选区文本 + 标题 + URL，不读正文）
→ sidepanel（用户写译文）
→ POST /api/diagnose（Bearer host_token + 用户模型配置）
→ 服务端：多维度对比 + 抽知识点
→ lib/feishu.js：tenant_access_token → bitable 写入用户自己的表
```

## 本地自测（不依赖真实凭证）

```bash
node extension/tools/selftest.mjs                              # 逻辑自测（假 chrome.* / fetch）
node --experimental-vm-modules extension/tools/selftest.mjs    # 同上，显式开 vm 模块
node extension/tools/browser-smoke.mjs                         # headless Chrome 真加载扩展（mock 网络）
```

`browser-smoke.mjs` 用 Playwright 的 Chrome for Testing，自动加
`--use-mock-keychain --password-store=basic --disable-sync`（避免 macOS 弹钥匙串授权），
临时 profile `.chrome-smoke-profile/` 用完自动删、不提交。
