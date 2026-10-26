> **源码位置（2026-10-27 起）**：插件已迁至 Store 仓库 `external-capabilities/plugin/chrome/readloop-external-capabilities/plugin/chrome/readloop-extension/`；本文中的 `external-capabilities/plugin/chrome/readloop-extension/` 路径均指该目录，发布见 <https://github.com/LyraWang6688/ai-capability-store/releases/tag/readloop-extension-v0.3.2>。

# Chrome 插件最佳实践审查（2026-10-23）

> 对照对象：Chrome 官方 `GoogleChrome/chrome-extensions-samples` 的 side panel 示例
> （[sample.sidepanel-dictionary](https://github.com/GoogleChrome/chrome-extensions-samples/tree/main/functional-samples/sample.sidepanel-dictionary)）
> 与官方 MV3 文档中的 service worker 生命周期、storage、messaging 约定。
> 结论落在插件 0.3.2（`external-capabilities/plugin/chrome/readloop-extension/`），改动面只在 `background.js` / `sidepanel/main.js` / 测试 / 文档。
> 官方没有「Chrome 插件 SDK / 脚手架」，能对照的就是 samples 和文档，本文件是这次对照的记录。

## 一、结论摘要

| # | 检查项 | 官方做法 | 我们改之前 | 判断 | 处理 |
|---|---|---|---|---|---|
| 1 | **SW 状态持久化** | 用 `chrome.storage.session`；SW 会被回收，不能靠内存 | `selectionsByTab` Map + `activeTabId` 变量 | 🔴 高（会丢选区） | ✅ 已改 |
| 2 | **侧边栏如何拿更新** | `storage.session.onChanged`（示例就是这么做的） | 只靠 `runtime.sendMessage` 广播，面板未开/加载中会漏 | 🟠 中 | ✅ 已改（广播保留，storage 变化为准） |
| 3 | **右键菜单路径的 URL/标题** | 用 activeTab 拿页面信息 | `tab.url`/`tab.title` 在非 host_permissions 页面为空 | 🟠 中（来源链接会空） | ✅ 已改（打开面板后再向 content script 要一次） |
| 4 | **图标点击 vs `setPanelBehavior`** | 官方推荐 `setPanelBehavior({openPanelOnActionClick:true})` 让 Chrome 打开面板 | 同时保留 `action.onClicked`；开启该设置后它**不会触发**，是死代码 | 🟡 低（无害但误导） | ✅ 已删死代码；面板加载时主动拉选区 |
| 5 | **监听器注册时机** | 顶层同步注册，异步放回调里 | 已符合 | ✅ | 不改 |
| 6 | **顶层 await / 长定时器** | 禁用 | 已符合（无顶层 await、无 timer 依赖） | ✅ | 不改 |
| 7 | **存储分仓** | 密钥进 local，非密钥配置进 sync | 已符合（`host_token`/`api_key`/`app_secret` 只进 local） | ✅ | 不改 |
| 8 | **权限最小化** | 不申请用不到的权限；host 只列必要域 | 已符合（无 `tabs`；host 只有服务域 + `open.feishu.cn` + 本地调试） | ✅ | 不改 |
| 9 | **消息错误处理** | `sendMessage` 的 Promise 要 catch（无接收方会 reject） | 已符合 | ✅ | 不改 |
| 10 | **`sidePanel.open()` 需要用户手势** | 只能从 action / 右键菜单等手势里调 | 已符合（只在右键菜单回调里调用） | ✅ | 不改 |
| 11 | **消息命名** | 建议带产品前缀 | 仍用旧名 `READINSIGHT_*`（产品已改名 ReadLoop） | 🟡 低（纯风格） | ⏭ 跳过（会牵动三处代码与两组测试，收益低） |
| 12 | **content script 触发时机** | `selectionchange` 可更实时，但会在光标移动时频繁触发 | 用 `mouseup`/`keyup` + 150ms 去抖 | ✅ 合理（只关心「用户主动选中」） | 不改 |
| 13 | **`storage.session` 访问级别** | 默认 `TRUSTED_CONTEXTS`（content script 读不到） | content script 不需要读 | ✅ | 不改 |

## 二、这次改了什么（0.3.2）

1. **`external-capabilities/plugin/chrome/readloop-extension/src/background.js`**
   - 删除模块级 `selectionsByTab` / `activeTabId`，改存 `chrome.storage.session`：
     `selection:<tabId>` + `activeTabId`；
   - `READINSIGHT_SELECTION_CHANGED` 写入 storage 后再广播；
   - `GET_ACTIVE_SELECTION`：优先读 storage；无记录时向 content script 补拉一次
     （覆盖「点图标打开面板，SW 里没缓存」）；
   - tab 激活时广播该 tab 选区；tab 关闭时清理该 tab 的键与 `activeTabId`；
   - 右键菜单：记选区 → 打开面板 → 再用 activeTab 向 content script 拉权威 URL/标题；
   - 删除不会触发的 `action.onClicked`（`openPanelOnActionClick` 已开启，由 Chrome 打开面板）。
2. **`external-capabilities/plugin/chrome/readloop-extension/src/sidepanel/main.js`**：订阅 `chrome.storage.session.onChanged`，
   `activeTabId` / `selection:*` 变化时重新 `refreshSelection()`；保留 runtime 广播作为即时更新。
3. **测试**：`tools/selftest.mjs` 的 background 用例重写为 storage.session 语义
   （无缓存补拉、写入持久化、切 tab 广播、关闭清理、SW 重启后恢复）；
   `tools/browser-smoke.mjs` 版本断言改为读 manifest，其余用例全过。
4. **文档**：`external-capabilities/plugin/chrome/readloop-extension/README.md`、`docs/CHROME_EXTENSION_MVP.md` 增加「MV3 生命周期」段。

## 三、验证

```bash
node --experimental-vm-modules external-capabilities/plugin/chrome/readloop-extension/tools/selftest.mjs   # 27 组断言全过
node external-capabilities/plugin/chrome/readloop-extension/tools/browser-smoke.mjs                        # 真机加载扩展冒烟全过
node --check 各 js / manifest JSON / 图标尺寸                 # 见 external-capabilities/plugin/chrome/readloop-extension/README「开发自查」
```

## 四、仍未验证（如实）

- 真实飞书写入、真实服务联调（缺用户凭证）——与本次改动无关，见 README「已知未验证项」。
- Chrome Web Store 审核。

## 五、以后升级时怎么复查

1. 打开官方 samples 对应样例（sidePanel / storage / messaging / lifecycle）；
2. 先看本文件的检查项表，逐项确认没有回退；
3. SW 里新增任何模块级状态前先问：它能不能放 `chrome.storage.session` / `local`；
4. 新增权限前先确认确实用得到（尤其 `tabs`、`<all_urls>` 之外的 host）。
