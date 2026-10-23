# ReadLoop

> **不是又一个背单词 App，而是一套有记忆科学依据、并由你的真实阅读数据持续校准的复习机制。**

读的时候暴露短板，AI 助手按时帮你复习。

---

## 它是什么

```
你在真实阅读中划词
        ↓
AI 对比你的翻译和参考译文，揪出没掌握的表达
        ↓
沉淀进你自己的飞书多维表格
        ↓
每天由 AI 助手按记忆曲线出题，陪你练几道
```

**数据、模型 API、浏览器插件都是你自己的。** 我们只提供规则和那套陪你练的机制。

## 和普通单词 App 不一样的地方

**1. 生词来自你正在读的东西，不是预设词表**
关注 AI，知识点就全是 AI 文章里的表达；例句就是你读到的那句原文，带来源链接。

**2. 陪伴式助手，不是答题机器**
它记得你上周卡在哪个表达、这次是新错还是老错——因为它在读你的账本，而不是随机抽题。

**3. 规则有出处，参数靠数据校准**
每条调度规则都能追到记忆科学的出处（[MEMORY_SCIENCE.md](docs/MEMORY_SCIENCE.md)），并且会用你的真实作答数据持续修正。

## 结构

```
Chrome 插件（采集）  →  你的飞书多维表格（数据）  →  后端服务（规则）  →  AI 宿主（每天陪你练）
```

- **采集**：划词即用；也可以在宿主内置浏览器里直接读网页
- **数据**：存在你自己的飞书空间，我们不托管
- **规则**：选题、组卷、判分、记忆调度——确定性逻辑在服务端，不交给模型
- **复盘**：Skill 装进豆包工作 / Codex / Work Buddy，用对话陪你做完

## 文档

| 文档 | 内容 |
|---|---|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | 产品架构、宿主接入、数据层、MVP 范围 |
| [API_IMPLEMENTATION.md](docs/API_IMPLEMENTATION.md) | 接口实现规格：签名/选题/题面/配对/幂等 |
| [REVIEW_RULES.md](docs/REVIEW_RULES.md) | 复习与出题规则（确定性部分） |
| [MEMORY_SCIENCE.md](docs/MEMORY_SCIENCE.md) | 规则的理论依据、现存偏差、待验证假设 |
| [DECISIONS.md](docs/DECISIONS.md) | 决策记录：为什么这么定 |
| [DEPLOYMENT.md](docs/DEPLOYMENT.md) | 部署方案与服务器现状 |
| [CHROME_EXTENSION_MVP.md](docs/CHROME_EXTENSION_MVP.md) | 插件加载、配置、配对码、自测 |
| [CHROME_WEB_STORE_CHECKLIST.md](docs/CHROME_WEB_STORE_CHECKLIST.md) | 商店上架清单与权限说明 |
| [PRODUCT_POSITIONING.md](docs/PRODUCT_POSITIONING.md) | 产品定位与目标用户 |

技能包（分发给宿主的 Skill）在独立仓库：
[ai-capability-store · skills/readloop](https://github.com/LyraWang6688/ai-capability-store/tree/main/skills/readloop)

## 接口一览

| 接口 | 作用 | 鉴权 |
|---|---|---|
| `POST /api/license/activate` | 8 位授权码 → `host_token`（年度） | 无 |
| `POST /api/review/today` | 传知识点 + 模型配置 → 今日题（`question_id` 签名） | Bearer |
| `POST /api/review/submit` | 提交一题 → 判分 + `updates`（服务端算好，宿主只抄写） | Bearer |
| `POST /api/setup/app/start` | 用飞书 Device Grant 帮用户一键创建自己的飞书应用 | Bearer |
| `GET /api/setup/app/status` | 轮询创建结果 + 三项校验 | Bearer |
| `POST/GET /api/setup/app/pair` | 配对码绑定 / 插件一次性取凭证 | Bearer / 配对码 |
| `POST /api/diagnose` | 翻译诊断（插件调用，BYOK + 防 SSRF） | Bearer |

服务端**无数据库、不存用户数据**；授权、题目都靠 HMAC 签名自包含。

## 项目状态

| 部分 | 状态 |
|---|---|
| 架构 / 规则 / 理论文档 | ✅ |
| 技能包（Skill） | ✅ 已进 Store，契约同步到 `readloop-v0.2.2` / `readloop-service-v0.2.1`（PR #291/#294） |
| 记忆调度（`scheduler.ts`） | ✅ 29 项自测 |
| 判分（`grading.ts`） | ✅ 28 项自测，生成式判分零 LLM |
| 动态难度（`difficulty.ts`） | ✅ 20 项自测 |
| 日期 / 签名（`date.ts` / `token.ts`） | ✅ 22 + 29 项自测 |
| 每日组题（`selection.ts` / `questions.ts`） | ✅ 89 项自测 |
| today/submit 编排（`review.ts`） | ✅ 91 项自测 |
| 一键创建应用（`src/lib/feishu/`） | ✅ 61 项自测（真实飞书链路未验，需真机） |
| 接口端到端冒烟 | ✅ 49 项（`bash scripts/smoke-api.sh`） |
| Chrome 插件 | ✅ 0.3.2 可加载（图标/飞书直写/配对码/自动 host_token；按官方 samples 对齐 MV3 生命周期）；真实凭证联调待做 |
| 部署 | ✅ 已上线 <https://readinsight.bamamei.online>（`bash scripts/deploy-server.sh`） |
| 真机验证（真实飞书链路 / 插件配准 / 豆包宿主） | ⏳ 待做 |

## Chrome 插件

- 下载：<https://github.com/LyraWang6688/readloop/releases>（`readloop-extension-<version>.zip`，解压后 Load unpacked）
- 源码：`extension/`，当前版本 **0.3.2**
- 自己打包：`bash scripts/pack-extension.sh`

## 线上服务

- 地址：<https://readinsight.bamamei.online>
- 健康检查：<https://readinsight.bamamei.online/api/health>
- 发布：`bash scripts/deploy-server.sh`（git push → 服务器 `git pull` → Docker 重建 → 健康检查）
- 部署细节与服务器现状：[DEPLOYMENT.md](docs/DEPLOYMENT.md)

## 技术栈

- **当前仓库**：Next.js 16 / React 19 / TypeScript
- **技能包**：Markdown（Store 分发）
- **数据**：飞书多维表格（用户自有）
- **模型**：用户自带（BYOK），默认推荐 DeepSeek

## 本地开发

```bash
pnpm install
pnpm dev          # http://localhost:3000
pnpm ts-check     # 类型检查
pnpm build        # 生产构建
```

纯函数自测（不依赖网络/数据库）：

```bash
npx tsx scripts/scheduler-check.ts     # 29
npx tsx scripts/grading-check.ts       # 28
npx tsx scripts/difficulty-check.ts    # 20
npx tsx scripts/date-check.ts          # 22
npx tsx scripts/token-check.ts         # 29
npx tsx scripts/selection-check.ts     # 89
npx tsx scripts/review-check.ts        # 91
npx tsx scripts/setup-app-check.ts     # 61
```

端到端冒烟（起一个真实 `next start`，不调飞书/模型）：

```bash
bash scripts/smoke-api.sh              # 49 项
```

发授权码（离线计算，不写库）：

```bash
LICENSE_SECRET=你的密钥 npx tsx scripts/license-gen.ts 10
```

> 本地环境变量见 [.env.example](.env.example)；部署说明见 [DEPLOYMENT.md](docs/DEPLOYMENT.md)。

## 商业形态

按年授权、非自动续费。用户买的是「一年内持续在线的服务」，数据始终归用户自己——不续费也能带走账本。

见 [ARCHITECTURE.md](docs/ARCHITECTURE.md) §十一。
