# Chrome Web Store Checklist

## 当前状态

- Manifest：V3，版本 `0.3.0`（`extension/manifest.json`）
- 默认服务地址：`https://readinsight.bamamei.online`
- 隐私政策：`https://readinsight.bamamei.online/privacy`
- 数据存储：**用户自己的飞书多维表格**（不是我们的数据库；插件本地只存设置与凭证）
- 模型调用：**用户自带 API Key（BYOK）**，Key 只存在 `chrome.storage.local`
- 权限：`activeTab`、`contextMenus`、`sidePanel`、`storage`
- host_permissions：`https://readinsight.bamamei.online/*`、`https://open.feishu.cn/*`、`http://localhost/*`、`http://127.0.0.1/*`

## 提交前

- 在 Chrome 里 Load unpacked 加载 `extension/`，确认侧边栏能打开、图标正常
- 在普通 HTTPS 网页测试划词采集（只取选区文本 + 标题 + URL）
- 用真实 host_token + 真实模型 Key 跑一次 `/api/diagnose`
- 用真实飞书应用凭证跑一次「一键入库」，确认 `capture_events` / `knowledge_points` 两张表被正确写入
- 配对码流程走通一次（插件显示 6 位码 → 宿主 `POST /api/setup/app/pair` → 插件取回凭证）
- 确认 `/privacy` 线上可访问，且内容覆盖「诊断文本、凭证与模型 Key 的处理方式」
- 准备商店截图与宣传图（16/32/48/128 图标已随包）

## Store Listing Draft

名称：

```text
ReadLoop
```

一句话简介（132 字符内）：

```text
Practice English reading from real webpages with AI translation feedback. Weak points are saved to your own Feishu Bitable for spaced review.
```

详细描述：

```text
ReadLoop helps English learners practice from real webpages they already care about. Select an English sentence or paragraph, open the side panel, write your own Chinese translation, and get an AI-powered comparison plus atomic knowledge points. Useful weak points are saved to a Feishu Bitable that you own, and your AI assistant reviews them on a schedule.

The extension does not run its own backend storage. It sends selected text and your translation to the ReadLoop API only when you ask for a diagnosis, and writes captured knowledge points straight into your own Feishu Bitable using a Feishu app you created during setup.
```

分类：

```text
Education
```

语言：

```text
Chinese (Simplified)
```

## 权限说明（商店必填）

`contextMenus`：

```text
Used to show "用 ReadLoop 练习这段英文" when the user selects text on a webpage.
```

`sidePanel`：

```text
Used to provide the translation practice and diagnosis workflow without leaving the current page.
```

`storage`：

```text
Used to save the service URL, host token, model settings and the user's own Feishu app credentials locally in Chrome.
```

`activeTab`：

```text
Used after a user action to read the selected text and page title/URL of the current page.
```

`host_permissions` — `https://open.feishu.cn/*`：

```text
Required to write captured knowledge points into the user's own Feishu Bitable using the Feishu app the user created during setup.
```

`host_permissions` — ReadLoop 服务域：

```text
Required to call the ReadLoop diagnosis API that the user has an annual license for.
```

`<all_urls>` content script：

```text
Required because users practice English reading on arbitrary webpages. The content script only reads the current selection text plus page title and URL; it does not read or transmit other page content.
```

## 数据使用披露（Data Usage）

- 用户主动划选的文本、页面标题与 URL、用户自己写的译文会发送到 ReadLoop 服务做诊断；
  服务端**不落库**，诊断结果原样返回。
- 模型 Key 由用户自带，仅保存在本机 `chrome.storage.local`；随诊断请求发到 ReadLoop 服务，
  由服务端直接转发给用户选择的模型供应商，**服务端不保存、不写日志**。
- 飞书 App ID / Secret 只保存在本机 `chrome.storage.local`，只发往 `open.feishu.cn`。
- 知识点只有在用户点「一键入库」时才写入**用户自己的**飞书表。
- 不读取与划选无关的页面内容，不做广告画像，不出售用户数据。
- 未购买/未激活（401/402）时，插件不发送划词内容。
