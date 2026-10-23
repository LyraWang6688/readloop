# ReadLoop Chrome 插件（MV3）

在真实网页里划词练习英译中：先自己翻译，再让 AI 对比诊断，最后把知识点**直接写进你自己的飞书多维表格**。

- 纯静态 Chrome/Edge Manifest V3 插件，**无构建步骤、无第三方依赖**，`extension/` 目录直接 `Load unpacked`。
- 插件不经过 ReadLoop 后端写表：飞书表格由插件用**用户自建的飞书应用**直连 `open.feishu.cn` 写入（见 `docs/ARCHITECTURE.md` §4.3）。
- 插件不含任何密钥；App Secret / 模型 API Key / host_token 都只存在 `chrome.storage.local`。

## 目录结构

```text
extension/
├── manifest.json
├── assets/icons/icon-{16,32,48,128}.png   # 插件图标（由 tools/gen-icons.mjs 生成）
├── tools/gen-icons.mjs                    # 图标生成脚本（一次性工具，node 直接跑）
└── src/
    ├── background.js                      # service worker：右键菜单 / 打开侧边栏 / 选区路由
    ├── content-script.js                  # 只上报「用户划选的文本 + 页面 URL/标题」
    ├── lib/
    │   ├── api.js                         # ReadLoop 服务接口（信封、401/402、配对接口）
    │   ├── feishu.js                      # 飞书多维表格直写（token 缓存、表/字段解析、先查后写）
    │   ├── ids.js                         # 本地 articleId / paragraphId
    │   └── storage.js                     # 设置读写（密钥只进 local）
    └── sidepanel/
        ├── index.html
        ├── main.js
        └── styles.css
```

## 本地安装

1. 打开 Chrome，访问 `chrome://extensions`。
2. 打开右上角 Developer mode。
3. 点「Load unpacked」，选择本仓库的 `extension/` 目录。
4. 任意英文网页选中一段英文 → 点工具栏 ReadLoop 图标（或右键「用 ReadLoop 练习这段英文」）打开侧边栏。

> 本地联调 ReadLoop 服务时，把「服务地址」改成 `http://localhost:3000`。

## 使用前要准备什么

| 东西 | 从哪来 |
|---|---|
| `host_token` | AI 宿主初始化时用 8 位授权码换到，交给用户填进插件（授权到期会返回 402，续费后重新激活即可） |
| 飞书多维表格 | 把 ReadLoop 模板 Base 复制到自己的飞书空间 |
| 飞书应用 App ID / Secret | 宿主「一键创建用户飞书应用」完成后，用**配对码**送进插件；也可以手动创建 |
| 模型 base_url / 模型名 / API Key | 用户自带的模型（BYOK，默认推荐 DeepSeek） |

## 一键配置（配对码）

插件在浏览器里拿不到宿主的飞书能力，也不该让用户手抄 App Secret，所以用一次性配对码：

1. 侧边栏点「生成配对码」→ 本地生成 **6 位数字**并显示。
2. 把这个码告诉 AI 宿主（例如：「ReadLoop 配对码 123456」）。
3. 宿主调 `POST /api/setup/app/pair`（带 host_token）把码绑定到创建会话。
4. 插件每 3 秒轮询 `GET /api/setup/app/pair?code=…`（无需鉴权），**最多等 5 分钟**。
5. 命中后一次拿到 `{ app_id, app_secret, app_token }`，写进 `chrome.storage.local`（Secret）与 `chrome.storage.sync`（App ID / app_token），界面提示「一键配置成功」。

> 配对码只用于「把凭证交给插件」，宿主/模型上下文里不出现 Secret。超时可重新生成。

手动配置也可以：在「设置 → 飞书多维表格」填 App ID、App Secret，粘贴多维表格链接（`https://xxx.feishu.cn/base/xxxx?table=tblxxxx`），插件会解析出 `app_token`。

## 飞书应用需要什么

1. 开通权限：`bitable:app`（读写多维表格）；**自动补单选选项**还需要 `base:field:update`。
2. 创建版本并发布（**不发布权限不生效**）。
3. 在目标多维表格右上角 `⋯` → 添加文档应用 → 选中你的应用 → 设为「**可编辑**」（能读不代表能写）。

配置完点「测试飞书连接」：插件会换 token、解析 `knowledge_points` 与 `capture_events` 两张表、校验字段名（只读，不写数据）。

## 日常使用

1. 在网页里划选一段英文（右键菜单或点图标打开侧边栏）。
2. 输入自己的中文译文。
3. 点「开始 AI 对比诊断」→ 插件调 `POST {服务地址}/api/diagnose`（带 `Authorization: Bearer <host_token>`，模型配置随请求体上传，服务端不保存）。
4. 看参考翻译、理解正确 / 可以优化 / 遗漏要点，勾选要沉淀的知识点。
5. 点「一键存入我的飞书表格」→ 插件直连飞书：
   - 写一条 `capture_events`：采集时间、页面链接/标题、选中原文、我的译文、AI 参考译文、诊断结果（JSON）、抽出的知识点（归一化内容，逗号分隔）、是否新点；
   - `knowledge_points` 按「归一化内容」**先查后写**：命中则 `暴露次数 +1`、`待练次数 +1`（上限 8）、更新 `最近暴露`；未命中则新建（状态 `new`、间隔 0、难度因子 2.5、连对 0、答错 0、待练 3、暴露 1、下次复习与最近暴露为今天、来源链接与原句）。
   - 单选字段（`类型` / `状态`）缺选项时会自动补；缺 `base:field:update` 会明确提示怎么加权限。

## 权限说明（最小化）

| manifest 项 | 用途 | 说明 |
|---|---|---|
| `host_permissions: https://readinsight.bamamei.online/*` | 调 ReadLoop 服务（诊断 / 配对） | 生产默认地址 |
| `host_permissions: https://open.feishu.cn/*` | 用你自己的飞书应用直连写表 | 只连飞书开放平台，不连其它第三方 |
| `host_permissions: http://localhost/*`、`http://127.0.0.1/*` | 本地开发联调 | 可改成自定义域名，但要同步加进这个列表 |
| `permissions: storage` | 保存设置与凭证 | 密钥只存 `chrome.storage.local` |
| `permissions: sidePanel` | 打开右侧练习面板 | —— |
| `permissions: contextMenus` | 右键「用 ReadLoop 练习这段英文」 | —— |
| `permissions: activeTab` | 在用户主动操作后读取当前标签页 URL/标题 | 不需要 `tabs` 全量权限 |
| `content_scripts: <all_urls>` | 任意英文网页都能划词 | 见下方隐私边界 |

## 隐私边界

- 内容脚本**只**在用户划选文本时上报「选中的文本 + 当前页 URL/标题」，不读取页面正文，不注入 UI，不后台采集。
- 只有点「开始 AI 对比诊断」才会把**选中原文 + 你的译文 + 模型配置**发给 ReadLoop 服务；服务端不存储任何用户数据。
- 写表格是浏览器直连 `open.feishu.cn`，用的是**你自己创建的应用**凭证，ReadLoop 服务端拿不到。
- 密钥存储：`host_token`、模型 `api_key`、飞书 `app_secret` 只在 `chrome.storage.local`（本机）；App ID、app_token、模型名/地址在 `chrome.storage.sync`（会随 Chrome 账号同步，不含密钥）。
- 代码里不写任何密钥。换机时重新激活授权 + 重新填密钥即可，飞书表格数据始终在你自己的飞书里。

## 常见错误与处理

| 现象 | 含义 / 怎么办 |
|---|---|
| 401 host_token 无效或已过期 | 回 AI 宿主重新激活授权码，拿新 host_token 填进设置 |
| 402 年度授权已到期 | 续费后重新激活；**数据不动、不要重装**、不要去动表格 |
| 飞书 403 / 没有读写权限 | ① 开放平台给应用加 `bitable:app`（补选项再加 `base:field:update`）并发布版本；② 表格 `⋯` → 添加文档应用 → 设为「可编辑」 |
| 提示缺少「类型 / 状态」选项且自动补充失败 | 应用缺 `base:field:update`。加上权限并重新发布版本，或手动在表格里加该选项 |
| 找不到表 `knowledge_points` / `capture_events` | 表格不是从 ReadLoop 模板复制的，或链接指向了别的 Base |
| 表格字段不完整 / 字段名对不上 | 模板被改过名，重新复制一份最新模板 |
| 连不上 ReadLoop 服务 | 检查「服务地址」；本地要 `http://localhost:3000` 且服务已启动；自定义域名要加进 `host_permissions` |
| 配对 5 分钟没反应 | 确认宿主已提交这个 6 位码（`POST /api/setup/app/pair`），重新生成配对码再试 |
| 飞书接口限流 | 一次入库会写多条记录，稍等几秒再点 |

## 开发自查

```bash
# 1. 重新生成图标（改了设计才需要）
node extension/tools/gen-icons.mjs

# 2. manifest 是合法 JSON
node -e 'JSON.parse(require("fs").readFileSync("extension/manifest.json","utf8"));console.log("manifest ok")'

# 3. 所有 ES module 语法检查（service worker / 侧边栏 / lib）
for f in extension/src/background.js extension/src/content-script.js extension/src/lib/*.js extension/src/sidepanel/main.js; do
  node --experimental-vm-modules -e 'const vm=require("vm");const fs=require("fs");const p=process.argv[1];new vm.SourceTextModule(fs.readFileSync(p,"utf8"),{identifier:p});console.log("syntax ok:",p)' "$f"
done

# 4. 图标是合法 PNG 且尺寸正确
file extension/assets/icons/*.png

# 5. 逻辑自测：用假 chrome.* / 假 fetch 跑 storage、api、feishu、content script、background
#    （不连网络、不需要任何凭证；覆盖 401/402 文案、配对、飞书写表全链路）
node --experimental-vm-modules extension/tools/selftest.mjs

# 6. 真机冒烟：用支持 --load-extension 的 Chrome/Chromium 真实加载插件，
#    并把「设置 → 诊断 → 入库 → 配对」主流程用 mock 网络走一遍
node extension/tools/browser-smoke.mjs
# 找不到 Chrome 时打印 SKIP；可用 CHROME_PATH 指定
```

### 关于真机冒烟的三个环境前提

- 只用 **Chrome for Testing / Chromium**（品牌版 Chrome 已移除 `--load-extension`），脚本会自动搜索 Playwright 缓存里的 Chrome for Testing。
- 脚本会加 `--no-sandbox`，因为沙箱化环境里 Chrome 自带的进程沙箱起不来；同时带 `--use-mock-keychain --password-store=basic --disable-sync`，避免 macOS 弹「Chrome 想访问钥匙串」授权框。这些都是测试脚本参数，不影响插件本身。
- **本地临时产物**：冒烟会在仓库根目录建 `.chrome-smoke-profile/`（已约定加入 `.gitignore`，不提交），脚本退出时自动删除；如果上次异常退出留下该目录，直接删掉即可。
- 本沙箱里的 Chrome 没有外网/本机回环网络，所以「加载真实网页 → content script 上报」这一段用 `selftest.mjs` 的 vm 单测覆盖，浏览器里改用「service worker 广播选区」验证侧边栏一侧。

## 打包（Chrome 商店 / 分发）

```bash
cd extension
zip -r ../readloop-extension.zip . -x "*.DS_Store" -x "tools/*"
```

`tools/` 是开发自查脚本（图标生成 / 逻辑自测 / 真机冒烟），不打进发布包。

zip 根目录必须直接包含 `manifest.json`（即打包 `extension/` 里的内容，而不是 `extension/` 这一层目录）。

## 已知未验证项

- **真实飞书写入**：仓库里没有用户凭证，写入链路是用假飞书接口验证的（字段、默认值、token 缓存、先查后写、单选补选项都对过），但没有对真实 Base 落过一条记录。
- **真实服务联调**：`/api/diagnose` 与配对接口的行为按 `docs/API_IMPLEMENTATION.md` 与当前 `src/app/api` 实现对齐，但没有连真实服务端跑过。
- **MV3 生命周期**：service worker 休眠/唤醒后的选区状态会丢（设计如此，侧边栏会主动再拉一次），极端时序需要真机长时间使用才能覆盖。
- **Chrome 商店审核**：截图、隐私政策文案见 `docs/CHROME_WEB_STORE_CHECKLIST.md`，尚未提交。
- Chrome 商店审核相关的截图、隐私政策文案见 `docs/CHROME_WEB_STORE_CHECKLIST.md`。
