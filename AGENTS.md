# 项目上下文 - ReadLoop

> **当前架构（2026-10-23 起）**：Chrome 插件采集 → 用户自己的飞书多维表格 → 后端服务算规则 → AI 宿主每天陪练。
> 动手前先读：[ARCHITECTURE.md](docs/ARCHITECTURE.md)、[REVIEW_RULES.md](docs/REVIEW_RULES.md)、[MEMORY_SCIENCE.md](docs/MEMORY_SCIENCE.md)、[DECISIONS.md](docs/DECISIONS.md)、[API_IMPLEMENTATION.md](docs/API_IMPLEMENTATION.md)（接口实现规格：签名/选题/配对）。

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
│       ├── diagnose/route.ts     # 翻译诊断（插件调用，BYOK）
│       ├── license/activate/     # 授权码 → host_token
│       ├── review/today/         # 选题 + 出题（确定性 + 签名）
│       ├── review/submit/        # 判分 + updates（状态快照在签名里）
│       └── setup/app/            # 一键创建用户飞书应用（start/status/pair）
├── components/
│   ├── client-layout.tsx
│   ├── error-boundary.tsx
│   └── ui/                       # shadcn/ui 基础组件
├── lib/
│   ├── scheduler.ts              # 记忆调度（纯函数）
│   ├── grading.ts                # 判分（纯函数）
│   ├── difficulty.ts             # 动态难度（纯函数）
│   ├── selection.ts              # 每日选题（纯函数，确定性）
│   ├── questions.ts              # 题面构造（纯函数）
│   ├── review.ts                 # today/submit 编排
│   ├── metrics.ts                # 学习效果指标（保持率/完成率/建议）
│   ├── token.ts                  # 授权码 / host_token / question_id 签名
│   ├── date.ts                   # 上海时区日期工具
│   ├── http.ts                   # 响应信封 / 鉴权 / 错误码
│   ├── feishu/                   # 一键创建应用：会话、注册、三项校验
│   ├── llm.ts                    # LLM 封装（BYOK，OpenAI 兼容）
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
pnpm install        # store 在仓库内 .pnpm-store/（已 gitignore；沙箱只能写工作区）
pnpm dev          # next dev
pnpm build        # next build
pnpm ts-check     # tsc --noEmit
pnpm lint

# 纯函数自测（不依赖网络/数据库），也可以用 ./node_modules/.bin/tsx 直接跑
npx tsx scripts/scheduler-check.ts
npx tsx scripts/grading-check.ts
npx tsx scripts/difficulty-check.ts
npx tsx scripts/date-check.ts
npx tsx scripts/token-check.ts
npx tsx scripts/selection-check.ts
npx tsx scripts/review-check.ts
npx tsx scripts/setup-app-check.ts
npx tsx scripts/metrics-check.ts

# 发授权码（离线计算，不写库；换 LICENSE_SECRET 会让旧码全失效）
LICENSE_SECRET=你的密钥 npx tsx scripts/license-gen.ts 10

# 端到端接口冒烟（起真实 next start，不调飞书/模型）
bash scripts/smoke-api.sh

# 规则离线回放（SM-2 vs FSRS；真实日志用 --practice）
npx tsx scripts/replay-compare.ts
npx tsx scripts/replay-check.ts

# 发布到生产（git push → 服务器 git pull → Docker 重建 → 健康检查）
bash scripts/deploy-server.sh
```

## 环境变量与线上服务

- 本地模板见 [.env.example](.env.example)；**没有 `DATABASE_URL`**，模型配置由请求体携带（BYOK）。
- 生产：<https://readinsight.bamamei.online>（`/api/health` 可查状态）；服务器 `/opt/readloop` 是 GitHub 的 git clone，`.env` 存两个签名密钥。
- 发布：`bash scripts/deploy-server.sh`（会先要求 commit 干净 → push → 服务器 pull → 重建）。
- **授权码必须用生产同一个 `LICENSE_SECRET` 生成**（`scripts/license-gen.ts`），换密钥会让已发出的码全部失效。

## 开发注意事项

1. **确定性逻辑不得引入 LLM**：`scheduler.ts` / `grading.ts` / `difficulty.ts` / `selection.ts` / `questions.ts` 是纯函数，判分、选题与间隔只能由代码决定。
2. **agent 是嘴，不是脑子**：语气与表达交给宿主模型，对错与复习时间由工具返回。
3. **数据归用户**：服务端不存储任何用户数据，也不直接访问飞书表格（由宿主用自己的飞书能力读写）。
4. **服务端无状态**：身份、题目、授权都靠 HMAC 签名（`src/lib/token.ts`，规格见 `docs/API_IMPLEMENTATION.md` §2）。不要为了「方便」加缓存库或会话库。
5. **改规则先看指标**：调 `scheduler.ts` / `difficulty.ts` / `selection.ts` 前，先用 `/api/review/metrics` 或 `scripts/metrics-check.ts` 做改前/改后对比，结论写进 `docs/REVIEW_RULES.md` §十一。
6. **凭证永不进日志/上下文**：`api_key`、`app_secret`、完整 `host_token` 不得出现在日志、错误 `details` 或宿主的对话里（插件用配对码自取）。
7. **文档同步**：改规则要同步 `docs/REVIEW_RULES.md` 与 `docs/MEMORY_SCIENCE.md`，改决策要写进 `docs/DECISIONS.md`，改接口要同步 `docs/API_IMPLEMENTATION.md` 与 Store 的 `references/api.md`。
8. **技能包不在这里**：改动 `skills/readloop` 请去 Store 仓库，本仓库不再保留副本。

## 历史说明

2026-10-23 之前本项目是 Coze 平台的 Web App（Next.js 页面 + PostgreSQL/Drizzle + coze-coding-dev-sdk），
那套代码与文档已移除或归档到 `docs/archive/`，仅在追溯历史时参考。
