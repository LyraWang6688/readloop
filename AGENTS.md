# 项目上下文 - ReadLoop

> **当前架构（2026-10-23 起）**：Chrome 插件采集 → 用户自己的飞书多维表格 → 后端服务算规则 → AI 宿主每天陪练。
> 动手前先读：[ARCHITECTURE.md](docs/ARCHITECTURE.md)、[REVIEW_RULES.md](docs/REVIEW_RULES.md)、[MEMORY_SCIENCE.md](docs/MEMORY_SCIENCE.md)、[DECISIONS.md](docs/DECISIONS.md)。

## 技术栈

- **Framework**：Next.js 16（App Router）
- **Core**：React 19 / TypeScript 5
- **样式**：Tailwind CSS 4 + shadcn/ui
- **存储**：**无数据库**——知识点存在用户自己的飞书多维表格
- **模型**：用户自带 API Key（BYOK），默认推荐 DeepSeek
- **技能包**：Markdown，在 [ai-capability-store](https://github.com/LyraWang6688/ai-capability-store/tree/main/skills/readloop) 单独维护

## 目录结构

```
src/
├── app/
│   ├── layout.tsx
│   ├── globals.css
│   ├── robots.ts
│   ├── privacy/page.tsx          # 隐私政策（Chrome 商店要求）
│   └── api/
│       └── diagnose/route.ts     # 翻译诊断（插件调用）
├── components/
│   ├── client-layout.tsx
│   ├── error-boundary.tsx
│   └── ui/                       # shadcn/ui 基础组件
├── lib/
│   ├── scheduler.ts              # 记忆调度（纯函数）
│   ├── grading.ts                # 判分（纯函数）
│   ├── difficulty.ts             # 动态难度（纯函数）
│   ├── llm.ts                    # LLM 封装（待切 DeepSeek）
│   ├── logger.ts
│   ├── client-logger.ts
│   └── utils.ts
└── types/index.ts

scripts/                          # 纯函数自测脚本
extension/                        # Chrome 插件（MV3）
docs/                             # 架构 / 规则 / 决策 / 部署
docs/archive/                     # 历史文档（Coze 时代的方案）
```

## 常用命令

```bash
pnpm install
pnpm dev          # next dev
pnpm build        # next build
pnpm ts-check     # tsc --noEmit
pnpm lint

# 纯函数自测（不依赖项目依赖）
npx tsx scripts/scheduler-check.ts
npx tsx scripts/grading-check.ts
npx tsx scripts/difficulty-check.ts
```

## 环境变量

见 [.env.example](.env.example)。**没有 `DATABASE_URL`**，模型配置可由请求体携带。

## 开发注意事项

1. **确定性逻辑不得引入 LLM**：`scheduler.ts` / `grading.ts` / `difficulty.ts` 是纯函数，判分与间隔只能由代码决定。
2. **agent 是嘴，不是脑子**：语气与表达交给宿主模型，对错与复习时间由工具返回。
3. **数据归用户**：服务端不存储任何用户数据，也不直接访问飞书表格（由宿主用自己的飞书能力读写）。
4. **文档同步**：改规则要同步 `docs/REVIEW_RULES.md` 与 `docs/MEMORY_SCIENCE.md`，改决策要写进 `docs/DECISIONS.md`。
5. **技能包不在这里**：改动 `skills/readloop` 请去 Store 仓库，本仓库不再保留副本。

## 历史说明

2026-10-23 之前本项目是 Coze 平台的 Web App（Next.js 页面 + PostgreSQL/Drizzle + coze-coding-dev-sdk），
那套代码与文档已移除或归档到 `docs/archive/`，仅在追溯历史时参考。
