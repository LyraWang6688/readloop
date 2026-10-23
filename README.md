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
每条调度规则都能追到记忆科学的出处（[MEMORY_SCIENCE.md](docs/MEMORY_SCIENCE.md)），并且会用你的真实作答数据持续修正。详见下方文档。

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
| [REVIEW_RULES.md](docs/REVIEW_RULES.md) | 复习与出题规则（确定性部分） |
| [MEMORY_SCIENCE.md](docs/MEMORY_SCIENCE.md) | 规则的理论依据、现存偏差、待验证假设 |
| [DECISIONS.md](docs/DECISIONS.md) | 决策记录：为什么这么定 |
| [DEPLOYMENT.md](docs/DEPLOYMENT.md) | 部署方案与服务器现状 |
| [PRODUCT_POSITIONING.md](docs/PRODUCT_POSITIONING.md) | 产品定位与目标用户 |

技能包（分发给宿主的 Skill）在独立仓库：
[ai-capability-store · skills/readloop](https://github.com/LyraWang6688/ai-capability-store/tree/main/skills/readloop)

## 项目状态

| 部分 | 状态 |
|---|---|
| 架构 / 规则 / 理论文档 | ✅ |
| 技能包（Skill） | ✅ 已进 AI Capability Store |
| 记忆调度（`scheduler.ts`） | ✅ 29 项自测通过 |
| 判分（`grading.ts`） | ✅ 28 项自测通过，生成式判分零 LLM |
| 动态难度（`difficulty.ts`） | ✅ 20 项自测通过 |
| 后端服务（三个接口） | ⏳ 进行中 |
| Chrome 插件改造 | ⏳ 待做 |
| 部署与真机验证 | ⏳ 待做 |

## 技术栈

- **当前仓库**：Next.js 16 / React 19 / TypeScript
- **技能包**：Markdown（Store 分发）
- **数据**：飞书多维表格（用户自有）
- **模型**：用户自带（BYOK），默认推荐 DeepSeek

## 本地开发

```bash
pnpm install
pnpm ts-check    # 类型检查
```

调度逻辑的自测不依赖项目依赖：

```bash
npx tsx scripts/scheduler-check.ts
```

> 仓库正在从「Web App」重构为「Skill + 后端服务 + 插件」，旧的页面代码保留但不再是主链路。
> 本地运行与部署说明见 [DEPLOYMENT.md](docs/DEPLOYMENT.md)。

## 商业形态

按年授权、非自动续费。用户买的是「一年内持续在线的服务」，数据始终归用户自己——不续费也能带走账本。

见 [ARCHITECTURE.md](docs/ARCHITECTURE.md) §十一。
