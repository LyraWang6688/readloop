# Chrome Extension MVP

`extension/` 目录是一个静态 Chrome/Edge Manifest V3 插件。
它不直接连接 Supabase，也不包含 AI Key、数据库连接串或数据库密码。
插件只调用现有 ReadLoop Next.js API。

## 本地加载

1. 启动 Web App：

```bash
pnpm dev
```

2. 打开 Chrome，进入：

```text
chrome://extensions
```

3. 打开右上角 Developer mode。
4. 点击 "Load unpacked"。
5. 选择项目里的 `extension/` 目录。

## 配置 API Base

插件默认请求：

```text
https://readinsight.bamamei.online
```

本地测试时，在插件侧边栏设置里改成：

```text
http://localhost:3000
```

插件还会保存一个 `userId`。MVP 默认值是：

```text
local-dev-user
```

## 测试链路

1. 打开任意英文网页。
2. 选中一段英文。
3. 右键选择 "用 ReadLoop 练习这段英文"，或点击插件图标。
4. 在侧边栏输入自己的中文翻译。
5. 点击 "开始 AI 对比诊断"。
6. 查看 AI 参考翻译、诊断结果和可沉淀知识点。
7. 勾选知识点并点击 "存入知识库"。
8. 在 Supabase 中检查 `knowledge_points` 和 `knowledge_point_events`。

## 链路结构

```text
Chrome selection
→ extension side panel
→ /api/diagnose
→ /api/knowledge
→ Drizzle
→ Supabase PostgreSQL
```

插件不使用 `@supabase/supabase-js`。
