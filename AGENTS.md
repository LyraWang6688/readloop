# 项目上下文 - 个性化英文阅读学习工具

> **2026-10-23 架构调整（当前有效）**：项目更名为 ReadLoop，产品形态从 Web App 改为
> 「Chrome 插件采集 + 飞书多维表格存储 + AI 宿主复盘」。下面的技术栈与目录结构描述的是
> **现有代码**，不代表新架构目标。改动前请先读：
> [ARCHITECTURE.md](docs/ARCHITECTURE.md)、[REVIEW_RULES.md](docs/REVIEW_RULES.md)、[DECISIONS.md](docs/DECISIONS.md)。

## 技术栈

- **Framework**: Next.js 16 (App Router)
- **Core**: React 19
- **Language**: TypeScript 5
- **UI 组件**: shadcn/ui (基于 Radix UI)
- **样式方案**: Tailwind CSS 4
- **状态管理**: Zustand
- **LLM**: 豆包 2.0 (doubao-seed-2-0-lite-260215)
- **本地状态**: Zustand + Persist (localStorage)
- **知识库持久化**: PostgreSQL + Drizzle ORM

## 目录结构

```
src/
├── app/
│   ├── page.tsx                    # 首页
│   ├── globals.css                # 全局样式
│   ├── layout.tsx                 # 根布局
│   ├── reading/
│   │   └── [articleId]/
│   │       └── page.tsx          # 阅读页
│   ├── practice/
│   │   └── [paragraphId]/
│   │       └── page.tsx          # 练习页
│   ├── summary/
│   │   └── [articleId]/
│   │       └── page.tsx          # 总结页
│   └── api/
│       ├── article/parse/
│       │   └── route.ts          # 文章解析 API
│       ├── diagnose/
│       │   └── route.ts          # 翻译诊断 API
│       ├── knowledge/
│       │   └── route.ts          # 知识点入库/读取 API
│       ├── practice/generate/
│       │   └── route.ts          # 练习题生成 API
│       └── logs/client/
│           └── route.ts          # 前端日志接收 API
├── components/
│   ├── ui/                       # shadcn/ui 组件
│   ├── loading-overlay.tsx       # 加载遮罩
│   ├── error-boundary.tsx        # 错误边界组件
│   └── client-layout.tsx        # 客户端布局（含全局错误处理）
├── lib/
│   ├── store.ts                  # Zustand store
│   ├── llm.ts                    # LLM 调用封装
│   ├── logger.ts                 # 后端日志工具
│   ├── client-logger.ts          # 前端日志工具
│   ├── api-client.ts             # API 调用封装（带日志）
│   └── utils.ts                  # 工具函数
└── types/
    └── index.ts                  # 类型定义
```

## 环境变量

```bash
# LLM 使用内置 SDK (coze-coding-dev-sdk)，无需配置
# 可选环境变量（如果不配置使用默认值）
# LLM_MODEL_ID=doubao-seed-2-0-lite-260215

DATABASE_URL=postgresql://...
```

## 常用命令

```bash
# 安装依赖
pnpm install

# 开发环境
pnpm dev

# 构建生产版本
pnpm build

# 类型检查
pnpm ts-check

# 代码检查
pnpm lint

# 数据库迁移
pnpm db:migrate

# 快速同步空数据库（开发期）
pnpm db:push
```

## API 接口

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/article/parse` | POST | 解析文章 URL 或粘贴内容 |
| `/api/article/upload` | POST | 上传 PDF 或图片文件并提取文字 |
| `/api/diagnose` | POST | 翻译诊断 + 知识点提取 |
| `/api/knowledge` | GET/POST | 读取/保存知识点到 PostgreSQL |
| `/api/practice/generate` | POST | 生成练习题 |
| `/api/logs/client` | POST | 接收前端日志 |

## 开发注意事项

1. **LLM 调用**：使用内置 `coze-coding-dev-sdk`，沙箱内网调用，稳定快速
2. **知识库持久化**：当前使用 PostgreSQL + Drizzle ORM，旧的表格化存储方案不再维护
3. **Hydration 问题**：使用 Zustand 持久化状态，避免 SSR/CSR 不一致
4. **数据库延迟初始化**：`src/lib/db.ts` 使用 Proxy 实现延迟初始化，允许在不设置 `DATABASE_URL` 的情况下进行构建。实际连接在首次 API 调用时才建立。
5. **构建时环境变量**：构建时不需要 `DATABASE_URL`，运行时必须设置。
6. **Supabase 迁云**：只把 Supabase 作为 PostgreSQL 使用，继续通过 Drizzle 和 Next.js API 访问数据库；接入步骤见 `docs/SUPABASE_DRIZZLE_SETUP.md`。

## 日志系统

### 日志目录结构

```
/app/work/logs/bypass/
├── app.log       # 后端主日志（API、LLM、用户操作）
├── dev.log       # 补充调试信息（DEBUG 级别）
└── console.log   # 前端日志（通过 /api/logs/client 写入）
```

### 日志级别说明

| 级别 | 说明 | 写入文件 |
|------|------|----------|
| INFO | 正常业务流程 | app.log, dev.log |
| WARN | 警告信息（超时、LLM 慢等） | app.log, dev.log |
| ERROR | 错误信息（API 失败、异常） | app.log, dev.log |
| DEBUG | 调试信息（前端行为、组件生命周期） | dev.log |

### 后端日志工具 (`src/lib/logger.ts`)

```typescript
import { logger } from "@/lib/logger";

// 通用日志
logger.info("操作描述", { 上下文数据 });
logger.warn("警告描述", { 上下文数据 });
logger.error("错误描述", { 上下文数据 });
logger.debug("调试信息", { 上下文数据 });

// API 日志
logger.api.request("POST", "/api/xxx", { body });
logger.api.response("POST", "/api/xxx", 200, 150);
logger.api.error("POST", "/api/xxx", error);

// LLM 日志
logger.llm.request("doubao-seed-2-0-lite", 3);
logger.llm.response("doubao-seed-2-0-lite", 15000, true);
logger.llm.error("doubao-seed-2-0-lite", error);
logger.llm.timeout("doubao-seed-2-0-lite", 180000);

// 用户操作日志
logger.user.parseArticle("url", true);
logger.user.submitTranslation("p_xxx", true);
logger.user.diagnoseTranslation("p_xxx", true, 45000);
```

### 前端日志工具 (`src/lib/client-logger.ts`)

```typescript
import { clientLogger } from "@/lib/client-logger";

// 通用日志
clientLogger.info("描述", { 数据 });
clientLogger.error("错误描述", { 数据 });

// API 调用日志
clientLogger.api.request("POST", "/api/xxx", body);
clientLogger.api.response("POST", "/api/xxx", 200, 150, true);
clientLogger.api.error("POST", "/api/xxx", error);

// 页面事件日志
clientLogger.page.view("ReadingPage");
clientLogger.page.action("StartTranslation", { paragraphId: "xxx" });
clientLogger.page.error("PracticePage", error, { context });

// 用户交互日志
clientLogger.user.click("SubmitButton", { paragraphId: "xxx" });
clientLogger.user.submit("TranslationForm");

// LLM 交互日志
clientLogger.llm.request("Diagnose", "doubao-seed-2-0-lite");
clientLogger.llm.response("Diagnose", 45000, true);
clientLogger.llm.stream("Diagnose", "chunk", { text: "..." });
```

### 组件错误捕获

使用 `ErrorBoundary` 组件包裹可能出错的组件：

```tsx
import { ErrorBoundary } from "@/components/error-boundary";

<ErrorBoundary>
  <YourComponent />
</ErrorBoundary>
```

### 日志查看命令

```bash
# 查看后端日志（最新 50 行）
tail -n 50 /app/work/logs/bypass/app.log

# 查看前端日志（最新 50 行）
tail -n 50 /app/work/logs/bypass/console.log

# 搜索错误信息
grep -nE "ERROR|Exception|Traceback|WARN" /app/work/logs/bypass/app.log | tail -n 50

# 查看特定时间段的日志
grep "2024-01-15T10:" /app/work/logs/bypass/app.log | tail -n 50
```

### 日志字段说明

每条日志包含以下字段：

| 字段 | 说明 |
|------|------|
| timestamp | ISO 8601 格式时间 |
| level | 日志级别 |
| message | 日志消息 |
| data/meta | 上下文数据（可选） |
| url | 请求 URL（前端日志） |
| userAgent | 浏览器信息（前端日志） |

## Coze 平台配置

### `.coze` 配置说明

项目根目录 `/workspace/projects/.coze` 的配置如下：

```toml
[project]
sub_id = "21820635"
name = "english-reading-tool"
requires = ["nodejs-24"]
project_type = "web"
entrypoint = "dist/server.js"

[preview]
preview_enable = "enabled"

[dev]
build = [ "bash", "./scripts/prepare.sh" ]
run = [ "bash", "./scripts/dev.sh" ]
deps = [ "git" ]

[deploy]
build = [ "bash", "./scripts/build.sh" ]
run = [ "bash", "./scripts/start.sh" ]
deps = [ "git" ]

[deploy.profile]
kind = "service"
flavor = "web"

[deploy.backend]
enabled = true
```

### 预览链路

- **预览端口**: 3000
- **预览命令**: `bash ./scripts/dev.sh`
- **开发服务器**: 自定义 Next.js server (`src/server.ts`)，绑定 `0.0.0.0:3000`
- **预览验证**: `curl http://localhost:3000` 返回 200

### 部署链路

- **构建**: `bash ./scripts/build.sh`
  - 安装依赖 (`pnpm install`)
  - 构建 Next.js 项目 (`pnpm next build`)
  - 打包 server (`pnpm tsup src/server.ts`)
- **启动**: `bash ./scripts/start.sh`
  - 启动打包后的服务 (`node dist/server.js`)
  - 端口: 3000

### 技术项目与工作区关系

- 工作区根目录: `/workspace/projects`
- 技术项目根目录: `/workspace/projects`（重合）
- `.coze` 位置: `/workspace/projects/.coze`（同时承担根 `.coze` 和子项目 `.coze` 的职责）
