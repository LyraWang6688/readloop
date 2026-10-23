# 历史文档归档

这个目录里的文件**不再代表当前架构**，只在追溯「当时为什么那样设计」时参考。

| 文件 | 当时的角色 | 何时失效 |
|---|---|---|
| `PRODUCT_TECHNICAL_SPEC.md` | v1.0 产品与技术方案 | 文件自身已标注「历史方案参考」 |
| `API_DESIGN.md` | Web App 时代的接口设计（文章解析 / 诊断 / 题库） | 入口从「导入文章」改为「划词」后 |
| `PROMPT_DESIGN.md` | coze 时代的 prompt 方案 | 模型改为用户自带（BYOK）后 |
| `UI_DESIGN_GUIDE.md` | Web App 的 UI 规范 | 产品形态改为「插件 + 宿主」后 |
| `SUPABASE_DRIZZLE_SETUP.md` | PostgreSQL + Drizzle 接入步骤 | 数据改为存在用户自己的多维表格后 |

**当前有效的文档**在上一级目录，入口是 [ARCHITECTURE.md](../ARCHITECTURE.md)。

> 归档原则：历史文档保留原文，不改写成「后来变成了什么」——否则就看不出当时的判断依据了。
> 想知道后来怎么变的，看 [DECISIONS.md](../DECISIONS.md)。
