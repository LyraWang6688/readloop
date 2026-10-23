# 个性化英文阅读学习工具 - 产品技术方案

> 版本：v1.0
> 日期：2025年
> 状态：历史方案参考
>
> 当前产品定位、知识库逻辑和 PostgreSQL 技术路线请以
> [PRODUCT_POSITIONING.md](./PRODUCT_POSITIONING.md) 为准。本文件保留早期方案细节，
> 其中段落难度评估、推荐机制、旧表格化主存储等内容不再作为当前实现方向。

---

## 一、产品愿景与定位

### 1.1 产品愿景

打造一个"英文阅读教练"产品，让用户在真实阅读场景中持续提升英文能力，而非机械背单词。

### 1.2 核心价值主张

| 竞品定位 | 我们的定位 |
|---------|-----------|
| 翻译器（直接给译文） | 学习伙伴（引导你自己理解） |
| 背单词工具（脱离语境） | 阅读教练（围绕真实文章） |
| 评估翻译对错 | 识别薄弱点 + 持续改进 |

### 1.3 关键用户洞察

```
用户痛点                    →    产品解决方案

"认识单词但读不懂句子"       →    句式结构分析 + 理解逻辑诊断
"依赖翻译器"                →    渐进式翻译（先自己翻，再给参考）
"背单词容易忘"              →    知识点沉淀 + 围绕文章的练习题
"不知道从哪里开始练"         →    段落难度评分 + 推荐练习机制
"希望直接读英文获取信息"     →    不做全文翻译，只做学习辅助
```

---

## 二、目标用户画像

### 2.1 用户特征

| 维度 | 描述 |
|------|------|
| 英语水平 | CET-4 以上，能阅读基础英文，但遇到长难句/专业内容吃力 |
| 阅读需求 | AI、产品经理、创业、商业类英文资讯 |
| 学习动机 | 希望提升英文能力，直接获取一手英文信息 |
| 痛点 | 依赖翻译器，无法独立阅读，被动学习效率低 |
| 技术接受度 | 中高，能接受 Web 应用，有一定在线学习习惯 |

### 2.2 典型使用场景

```
场景1：每天通勤时阅读一篇英文文章
场景2：工作中需要阅读英文文档/邮件
场景3：周末系统学习某个领域的英文资料
场景4：备考托福/雅思但不想脱离实际阅读
```

---

## 三、功能架构总览

### 3.1 产品路线图

```
┌─────────────────────────────────────────────────────────────┐
│                       MVP (当前阶段)                        │
├─────────────────────────────────────────────────────────────┤
│  文章导入 → 段落练习 → 知识沉淀 → 练习巩固                  │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                    P1 阶段（知识库增强）                      │
├─────────────────────────────────────────────────────────────┤
│  艾宾浩斯复习 → 每日推送 → 能力画像 → 智能推荐               │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                   P2 阶段（内容生态）                        │
├─────────────────────────────────────────────────────────────┤
│  精选文章库 → 社区讨论 → 学习数据分享                        │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 MVP 功能矩阵

| 功能模块 | 子功能 | 优先级 | 说明 |
|---------|--------|--------|------|
| 文章导入 | URL 抓取 | P00 | 提取网页正文 |
| 文章导入 | 手动粘贴 | P00 | 兜底方案 |
| 段落练习 | 难度评估 | P00 | 1-4级难度 |
| 段落练习 | 推荐段落 | P00 | 智能推荐 |
| 段落练习 | 翻译练习 | P00 | 先翻再给参考 |
| 薄弱点诊断 | 单词识别 | P00 | 四类知识点 |
| 薄弱点诊断 | 词组识别 | P00 | - |
| 薄弱点诊断 | 句式识别 | P00 | - |
| 薄弱点诊断 | 理解逻辑 | P00 | - |
| 知识沉淀 | 本地存储 | P00 | IndexedDB |
| 知识沉淀 | 导出功能 | P00 | JSON 格式 |
| 练习巩固 | 即时练习 | P00 | 3-5 题/次 |
| 总结展示 | 学习报告 | P00 | 本次知识点 |

---

## 四、核心功能详细设计

### 4.1 文章导入（P00）

#### 4.1.1 功能描述

支持两种方式输入文章：URL 抓取 + 手动粘贴

#### 4.1.2 用户流程

```
┌──────────────────────────────────────────────────────────────┐
│                                                              │
│   ┌─────────────┐          ┌─────────────┐                  │
│   │  输入 URL   │ → 解析中 → │ 预览结果   │ → 确认导入      │
│   └─────────────┘          └─────────────┘        ↓          │
│        ↓                       ↓                      ┌─────────────┐
│   ┌─────────────┐          ┌─────────────┐            │  解析失败   │
│   │ 手动粘贴文章 │ → 确认 → │  开始练习   │ ←──兜底──│  手动修正   │
│   └─────────────┘          └─────────────┘            └─────────────┘
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

#### 4.1.3 正文提取规则

| 优先级 | 标签 | 提取内容 |
|--------|------|----------|
| 高 | `<h1>` | 文章标题 |
| 高 | `<meta title>` | 备选标题 |
| 中 | `<p>` | 段落正文 |
| 中 | `<h2>-<h4>` | 小标题 |
| 低 | 其他文本节点 | 补充内容 |
| 过滤 | `<nav>`, `<footer>`, `<aside>`, `<script>`, `<style>` | 噪音内容 |

#### 4.1.4 文本预处理规则

- 过短段落合并（<50 字符合并到上段）
- 过滤纯数字/纯符号段落
- 过滤重复段落（相似度 >90%）
- 保留段落原始顺序

#### 4.1.5 数据结构

```typescript
interface ArticleInput {
  type: "url" | "paste";
  url?: string;           // 来源 URL
  title?: string;         // 手动输入标题
  content?: string;        // 粘贴的正文
}

interface ParsedArticle {
  id: string;
  url?: string;
  title: string;
  paragraphs: Paragraph[];
  wordCount: number;
  readingTime: number;     // 预估阅读时间（分钟）
  createdAt: number;
  status: "reading" | "completed";
}

interface Paragraph {
  id: string;
  articleId: string;
  index: number;           // 段落序号
  content: string;         // 原文
  difficulty?: number;     // 难度分 0-100
  difficultyLevel?: "L1" | "L2" | "L3" | "L4";
  status: "unread" | "in_progress" | "completed";
}
```

---

### 4.2 段落难度评估（P00）

#### 4.2.1 评估维度

| 维度 | 权重 | 评估内容 | 算法说明 |
|------|------|----------|----------|
| 句子长度 | 30% | 平均句子字符数 | 句子越长越难 |
| 词汇难度 | 30% | 高难度词汇占比 | CET-6/托福/雅思词汇比例 |
| 句式复杂度 | 25% | 从句嵌套层数 | 超过 2 层算复杂 |
| 术语密度 | 15% | 专业术语数量 | 统计领域专有名词 |

#### 4.2.2 难度等级定义

| 等级 | 分值 | 标签 | 颜色标识 | 建议 |
|------|------|------|----------|------|
| L1 | 0-25 | 简单 | 绿色 | 适合热身，建立信心 |
| L2 | 26-50 | 中等 | 蓝色 | 适合日常练习 |
| L3 | 51-75 | 较难 | 橙色 | 适合挑战，有提升空间 |
| L4 | 76-100 | 困难 | 红色 | 建议积累后再练 |

#### 4.2.3 推荐算法

```
推荐得分 = 基础匹配分 × 亮点加成

基础匹配分：
- 用户当前水平 L2 → 推荐 L1-L3 段落
- 权重：越接近目标难度得分越高

亮点加成：
- 有明确句式结构（+10%）
- 有常用词组搭配（+10%）
- 非纯过渡段（+5%）

过滤规则：
- 段落句子数 < 3 → 不推荐
- 段落句子数 > 10 → 降权
- 重复内容 → 过滤
```

---

### 4.3 段落翻译练习（P00）

#### 4.3.1 核心交互设计

```
┌─────────────────────────────────────────────────────────────┐
│  步骤 1：准备翻译                                           │
│  ════════════════════════════════════════════════════════   │
│                                                             │
│  [段落难度 L2]                                               │
│                                                             │
│  The fundamental limitation of traditional machine         │
│  learning is its dependency on manual feature engineering.  │
│  Unlike humans who can automatically identify relevant     │
│  patterns, ML systems require experts to painstakingly      │
│  extract and format data features before training.         │
│                                                             │
│  ─────────────────────────────────────────────────────────  │
│  [开始翻译]                                                 │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│  步骤 2：用户输入翻译                                       │
│  ════════════════════════════════════════════════════════   │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ 传统机器学习有一个根本的限制，即对手工特征工程       │   │
│  │ 的依赖。与人类能够自动识别相关模式不同，机器学习     │   │
│  │ 系统需要专家在训练前煞费苦心地提取和格式化数据特征。 │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  字数：86 字                                                │
│  ─────────────────────────────────────────────────────────  │
│  [提交翻译]                                                 │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│  步骤 3：AI 参考翻译 + 差异分析                             │
│  ════════════════════════════════════════════════════════   │
│                                                             │
│  📝 AI 参考翻译：                                           │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ 传统机器学习的根本局限在于其对人工特征工程的依赖。   │   │
│  │ 与人类能够自动识别相关模式不同，机器学习系统需要     │   │
│  │ 领域专家在训练前 painstakingly（煞费苦心地）提取    │   │
│  │ 并格式化数据特征。                                   │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  📊 差异分析：                                              │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ ✓ 理解正确：                                        │   │
│  │   - "fundamental limitation" = 根本限制            │   │
│  │   - "dependency on" = ...的依赖                    │   │
│  │   - "unlike humans" = 与人类不同                    │   │
│  │                                                     │   │
│  │ ⚠️ 表达差异：                                       │   │
│  │   - "limitation" → "局限" 更好                   │   │
│  │   - "manual" → "人工" 而非 "手工"                 │   │
│  │                                                     │   │
│  │ ✗ 遗漏要点：                                        │   │
│  │   - "painstakingly" 未译出（煞费苦心/费力地）       │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  [标记为已掌握] [加入待复习] [下一段 →]                      │
└─────────────────────────────────────────────────────────────┘
```

#### 4.3.2 设计原则

1. **先自己想，再给参考**：强制用户先提交自己的翻译
2. **对比式学习**：展示差异而非直接评判对错
3. **正向引导**：先肯定理解正确的部分，再指出提升空间
4. **留白翻译**（可选）：用户可只翻译不懂的部分

---

### 4.4 薄弱点诊断（P00）

#### 4.4.1 四类知识点分类

| 类型 | 标识 | 说明 | 示例 |
|------|------|------|------|
| Word | 单词 | 核心词汇，语境含义 | "dependency" - 依赖（n.） |
| Phrase | 词组 | 固定搭配/短语 | "be dependent on" - 取决于 |
| Pattern | 句式 | 表达模式/结构 | "Unlike X, Y..." - 与X不同，Y... |
| Comprehension | 理解 | 逻辑难点/推理 | "painstakingly" 的情感色彩 |

#### 4.4.2 知识点数据结构

```typescript
type KnowledgePointType = "word" | "phrase" | "pattern" | "comprehension_point";

interface KnowledgePoint {
  id: string;
  type: KnowledgePointType;
  content: string;         // 原文片段
  meaning: string;         // 含义解释
  example: string;         // 原句示例
  explanation?: string;    // 详细说明
  difficulty: "cet4" | "cet6" | "toefl" | "ielts" | "advanced";
  masterStatus: "learning" | "mastered";
  reviewCount: number;
  lastReviewAt?: number;
  createdAt: number;
  sourceArticleId: string;
  sourceParagraphId: string;
}
```

#### 4.4.3 诊断流程

```
用户翻译文本
     ↓
AI 参考翻译
     ↓
逐句对比分析
     ↓
识别差异点
     ↓
分类到知识点类型
     ↓
生成知识点卡片
     ↓
用户确认 → 沉淀到知识库
```

---

### 4.5 知识沉淀（P00）

#### 4.5.1 数据流向

```
薄弱点诊断结果
       ↓
   用户确认
       ↓
  写入知识库
       ↓
  展示未掌握知识点总结
       ↓
  生成即时练习题
```

#### 4.5.2 存储策略

| 存储位置 | 容量 | 说明 |
|----------|------|------|
| IndexedDB | 50MB | 浏览器本地存储 |
| 导出文件 | 无限制 | JSON 格式，可导入恢复 |

#### 4.5.3 知识点管理

- 支持查看所有知识点
- 支持按类型筛选
- 支持按来源文章筛选
- 支持搜索关键词
- 支持导出/导入（JSON）

---

### 4.6 练习题生成（P00）

#### 4.6.1 题型设计

| 题型 | 英文名 | 适用类型 | 示例 |
|------|--------|----------|------|
| 选词填空 | fill_blank | Word | The AI system demonstrates remarkable _____ (能力) |
| 短语配对 | match | Phrase | "be dependent on" → 取决于 |
| 句式改写 | rewrite | Pattern | 用 "Unlike X, Y..." 改写句子 |
| 理解判断 | judge | Comprehension | 判断理解是否正确 |

#### 4.6.2 生成规则

```
题目数量：3-5 题/次
题目来源：
- 本次新学知识点：70%
- 历史回顾知识点：30%

题目质量：
- 考察理解而非记忆
- 提供详细解析
- 关联原文语境
```

---

## 五、数据模型设计

### 5.1 实体关系图

```
┌─────────────┐       ┌─────────────┐       ┌─────────────┐
│   Article   │──1:N──│  Paragraph  │──1:N──│KnowledgePoint│
└─────────────┘       └─────────────┘       └─────────────┘
       │                    │
       │                    │
       ↓                    ↓
┌─────────────┐       ┌─────────────┐
│PracticeRecord│      │PracticeQuestion│
└─────────────┘       └─────────────┘
```

### 5.2 完整数据模型

```typescript
// 文章
interface Article {
  id: string;
  url?: string;
  title: string;
  paragraphs: Paragraph[];
  wordCount: number;
  readingTime: number;
  createdAt: number;
  status: "reading" | "completed";
}

// 段落
interface Paragraph {
  id: string;
  articleId: string;
  index: number;
  content: string;
  difficulty: number;           // 0-100
  difficultyLevel: "L1" | "L2" | "L3" | "L4";
  status: "unread" | "in_progress" | "completed";
  userTranslation?: string;
  aiTranslation?: string;
  knowledgePoints?: KnowledgePoint[];
}

// 知识点
interface KnowledgePoint {
  id: string;
  type: "word" | "phrase" | "pattern" | "comprehension_point";
  content: string;
  meaning: string;
  explanation?: string;
  sourceParagraphId: string;
  masterStatus: "learning" | "mastered";
  reviewCount: number;
  lastReviewAt?: number;
  createdAt: number;
}

// 练习记录
interface PracticeRecord {
  id: string;
  articleId: string;
  paragraphId: string;
  userTranslation: string;
  aiTranslation: string;
  knowledgePoints: string[];    // 知识点 ID 列表
  practicedAt: number;
}

// 练习题
interface PracticeQuestion {
  id: string;
  type: "fill_blank" | "match" | "rewrite" | "judge";
  question: string;
  options?: string[];
  correctAnswer: string;
  explanation: string;
  relatedKnowledgePointId: string;
}

// 用户进度
interface UserProgress {
  totalArticlesRead: number;
  totalParagraphsPracticed: number;
  totalKnowledgePoints: number;
  masteredKnowledgePoints: number;
  currentStreak: number;
  lastPracticeAt?: number;
}
```

---

## 六、API 设计

### 6.1 端点清单

| 端点 | 方法 | 说明 | 请求体 | 响应 |
|------|------|------|--------|------|
| `/api/article/parse` | POST | 解析文章 | ArticleInput | ParsedArticle |
| `/api/diagnose` | POST | 翻译诊断 | DiagnoseRequest | DiagnoseResult |
| `/api/practice/generate` | POST | 生成练习题 | {knowledgePoints} | PracticeResult |

### 6.2 接口详情

#### 6.2.1 POST /api/article/parse

**请求**
```json
{
  "type": "url",
  "url": "https://example.com/article"
}
```
或
```json
{
  "type": "paste",
  "content": "文章正文内容...",
  "title": "文章标题（可选）"
}
```

**响应**
```json
{
  "success": true,
  "data": {
    "id": "art_xxx",
    "title": "文章标题",
    "paragraphs": [
      {"id": "p1", "index": 0, "content": "第一段内容...", "status": "unread"},
      {"id": "p2", "index": 1, "content": "第二段内容...", "status": "unread"}
    ],
    "wordCount": 1250,
    "readingTime": 5
  }
}
```

#### 6.2.2 POST /api/diagnose

**请求**
```json
{
  "originalParagraph": "The fundamental limitation of traditional machine learning...",
  "userTranslation": "传统机器学习有一个根本的限制..."
}
```

**响应**
```json
{
  "success": true,
  "data": {
    "aiTranslation": "传统机器学习的根本局限在于其对人工特征工程的依赖...",
    "analysis": {
      "correct": [
        {"text": "fundamental limitation", "feedback": "理解准确"},
        {"text": "dependency on", "feedback": "翻译正确"}
      ],
      "missed": [
        {"text": "painstakingly", "meaning": "煞费苦心地", "reason": "漏译重要修饰词"}
      ],
      "alternative": [
        {"original": "limitation", "your": "限制", "better": "局限", "reason": "语境更准确"}
      ]
    },
    "knowledgePoints": [
      {
        "id": "kp1",
        "type": "word",
        "content": "painstakingly",
        "meaning": "煞费苦心地，费力地",
        "difficulty": "toefl"
      },
      {
        "id": "kp2",
        "type": "phrase",
        "content": "be dependent on",
        "meaning": "取决于，依赖于"
      }
    ]
  }
}
```

#### 6.2.4 POST /api/practice/generate

**请求**
```json
{
  "knowledgePoints": ["kp1", "kp2", "kp3"],
  "count": 5
}
```

**响应**
```json
{
  "success": true,
  "data": {
    "questions": [
      {
        "id": "q1",
        "type": "fill_blank",
        "question": "The experts must _____ extract and format data features.",
        "options": ["automatically", "painstakingly", "quickly", "easily"],
        "correctAnswer": "painstakingly",
        "explanation": "painstakingly 表示煞费苦心地，符合语境"
      }
    ]
  }
}
```

---

## 七、前端界面设计

### 7.1 页面结构

```
├── 首页 (/)
│   ├── Hero - 价值主张
│   ├── 快速开始入口
│   ├── 最近阅读
│   └── 学习统计概览
│
├── 阅读页 (/reading/[articleId])
│   ├── 文章信息区
│   ├── 段落列表
│   │   ├── 难度标识
│   │   ├── 状态标签
│   │   └── 操作按钮
│   └── 进度指示
│
├── 练习页 (/practice/[paragraphId])
│   ├── 原文展示
│   ├── 翻译输入
│   ├── 参考翻译区
│   ├── 差异分析区
│   └── 知识点卡片
│
├── 总结页 (/summary/[articleId])
│   ├── 本次学习概览
│   ├── 知识点列表
│   └── 练习入口
│
└── 知识库页 (/knowledge)
    ├── 分类浏览
    ├── 搜索功能
    └── 复习模式 [P1]
```

### 7.2 页面流程图

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                  │
│  首页                                                             │
│    │                                                              │
│    ├── URL 输入 ──────────────┐                                  │
│    │                          │                                  │
│    ├── 粘贴文章 ──────────────┼──→ 文章预览 ──→ 确认导入         │
│    │                          │                                  │
│    └── 最近阅读 ───┐         │                                  │
│                    │         │                                  │
│                    ↓         ↓                                  │
│                阅读页 ◄────────┘                                  │
│                  │                                               │
│                  ├── 选择段落 ──→ 练习页                          │
│                  │                          │                    │
│                  │                          ↓                    │
│                  │                      提交翻译                │
│                  │                          │                    │
│                  │                          ↓                    │
│                  │                      诊断分析                  │
│                  │                          │                    │
│                  │                          ↓                    │
│                  │                      确认知识点                │
│                  │                          │                    │
│                  ↓                          ↓                    │
│              总结页 ◄─────────────────────────┘                  │
│                │                                                 │
│                ├── 查看统计                                       │
│                │                                                 │
│                └── 生成练习题 ──→ 练习答题                        │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 7.3 组件清单

| 组件名 | 说明 | 状态 |
|--------|------|------|
| ArticleInput | 文章输入组件（URL/粘贴） | 待开发 |
| ParagraphList | 段落列表组件 | 待开发 |
| ParagraphCard | 单个段落卡片 | 待开发 |
| DifficultyBadge | 难度标签组件 | 待开发 |
| TranslationInput | 翻译输入组件 | 待开发 |
| ReferenceTranslation | 参考翻译展示 | 待开发 |
| DifferenceAnalysis | 差异分析展示 | 待开发 |
| KnowledgeCard | 知识点卡片 | 待开发 |
| PracticeQuestion | 练习题组件 | 待开发 |
| SummaryReport | 总结报告组件 | 待开发 |
| StatsCard | 统计卡片组件 | 待开发 |

---

## 八、技术架构

### 8.1 技术栈选型

| 层级 | 技术 | 版本 | 说明 |
|------|------|------|------|
| 前端框架 | Next.js | 16.x | App Router |
| UI 组件库 | shadcn/ui | 3.x | 基于 Radix UI |
| 样式方案 | Tailwind CSS | 4.x | 现代 CSS |
| 状态管理 | Zustand | 5.x | 轻量状态管理 |
| 本地存储 | IndexedDB | - | 知识库持久化 |
| 后端 | Next.js API Routes | - | Serverless 函数 |
| LLM 调用 | coze-coding-dev-sdk | 0.7.x | 流式输出支持 |

### 8.2 项目目录结构

```
src/
├── app/
│   ├── page.tsx                      # 首页
│   ├── globals.css                   # 全局样式
│   ├── layout.tsx                    # 根布局
│   │
│   ├── reading/
│   │   └── [articleId]/
│   │       └── page.tsx             # 阅读页
│   │
│   ├── practice/
│   │   └── [paragraphId]/
│   │       └── page.tsx             # 练习页
│   │
│   ├── summary/
│   │   └── [articleId]/
│   │       └── page.tsx             # 总结页
│   │
│   └── api/
│       ├── article/parse/
│       │   └── route.ts             # 文章解析 API
│       ├── paragraph/analyze/
│       │   └── route.ts             # 段落分析 API
│       ├── diagnose/
│       │   └── route.ts             # 诊断 API
│       └── practice/generate/
│           └── route.ts             # 练习生成 API
│
├── components/
│   ├── ui/                          # shadcn/ui 组件
│   │   ├── button.tsx
│   │   ├── card.tsx
│   │   ├── input.tsx
│   │   ├── textarea.tsx
│   │   ├── badge.tsx
│   │   ├── progress.tsx
│   │   └── ...
│   │
│   ├── article-input.tsx            # 文章输入组件
│   ├── paragraph-list.tsx           # 段落列表
│   ├── paragraph-card.tsx            # 段落卡片
│   ├── difficulty-badge.tsx         # 难度标签
│   ├── translation-input.tsx        # 翻译输入
│   ├── reference-translation.tsx    # 参考翻译
│   ├── difference-analysis.tsx      # 差异分析
│   ├── knowledge-card.tsx           # 知识点卡片
│   ├── practice-question.tsx        # 练习题
│   ├── summary-report.tsx           # 总结报告
│   └── stats-overview.tsx           # 统计概览
│
├── lib/
│   ├── utils.ts                     # 工具函数 (cn)
│   ├── store.ts                     # Zustand store
│   ├── db.ts                        # IndexedDB 操作
│   ├── api.ts                       # API 调用封装
│   └── llm.ts                       # LLM 调用封装
│
├── types/
│   └── index.ts                     # 类型定义
│
└── hooks/
    ├── use-store.ts                 # Store hooks
    └── use-db.ts                    # DB hooks
```

### 8.3 LLM 集成方案

#### 8.3.1 流式输出实现

```
前端 (fetch + ReadableStream)
        │
        │  SSE 连接
        ↓
后端 API Route
        │
        │  coze-coding-dev-sdk.stream()
        ↓
LLM 服务
```

#### 8.3.2 Prompt 设计原则

**翻译 Prompt**
```
你是专业英文翻译，擅长将英文技术文章翻译成流畅的中文。
要求：
1. 准确传达原文含义
2. 符合中文表达习惯
3. 保留原文风格（技术感、专业感）
4. 对于多义词，选择语境最合适的含义
```

**诊断 Prompt**
```
你是一位英文学习教练，帮助用户分析翻译差异并识别薄弱点。
要求：
1. 先肯定用户理解正确的部分
2. 指出表达差异，给出更好的译法
3. 标注遗漏的重要信息
4. 识别并归类知识点（单词、词组、句式、理解难点）
```

### 8.4 本地存储方案

```typescript
// IndexedDB Schema
const DB_NAME = "english-reading-coach";
const DB_VERSION = 1;

const STORES = {
  articles: "articles",
  knowledgePoints: "knowledgePoints",
  practiceRecords: "practiceRecords",
  progress: "progress"
};
```

---

## 九、里程碑规划

### 9.1 MVP 开发计划

| 阶段 | 任务 | 优先级 | 预估工时 |
|------|------|--------|----------|
| **Phase 1: 基础框架** | | | **2h** |
| | 项目初始化 | P00 | 0.5h |
| | 类型定义 | P00 | 0.5h |
| | 状态管理 (Zustand) | P00 | 0.5h |
| | 本地存储 (IndexedDB) | P00 | 0.5h |
| **Phase 2: 文章导入** | | | **3h** |
| | URL 抓取 API | P00 | 1h |
| | 正文提取逻辑 | P00 | 1h |
| | 粘贴模式支持 | P00 | 0.5h |
| | 文章预览组件 | P00 | 0.5h |
| **Phase 3: 段落练习** | | | **6h** |
| | 难度评估 API | P00 | 1.5h |
| | 段落列表组件 | P00 | 1h |
| | 翻译输入组件 | P00 | 1h |
| | 参考翻译展示 | P00 | 1h |
| | 差异分析展示 | P00 | 1.5h |
| **Phase 4: 知识沉淀** | | | **4h** |
| | 知识点诊断 API | P00 | 1.5h |
| | 知识点卡片组件 | P00 | 1h |
| | 知识库存储 | P00 | 1h |
| | 知识点管理页 | P00 | 0.5h |
| **Phase 5: 练习巩固** | | | **3h** |
| | 练习题生成 API | P00 | 1.5h |
| | 练习答题组件 | P00 | 1h |
| | 答题反馈 | P00 | 0.5h |
| **Phase 6: 总结报告** | | | **2h** |
| | 总结页设计 | P00 | 1h |
| | 统计概览 | P00 | 0.5h |
| | 进度更新 | P00 | 0.5h |
| **Phase 7: 测试优化** | | | **2h** |
| | 功能测试 | P00 | 1h |
| | 体验优化 | P00 | 1h |
| **总计** | | | **22h** |

### 9.2 迭代计划

**Sprint 1 (Week 1)**
- Phase 1 + Phase 2
- 完成文章导入功能

**Sprint 2 (Week 2)**
- Phase 3 + Phase 4
- 完成核心练习流程

**Sprint 3 (Week 3)**
- Phase 5 + Phase 6
- 完成练习巩固和总结

**Sprint 4 (Week 4)**
- Phase 7 + P1 规划
- 测试上线 + 收集反馈

---

## 十、风险与对策

### 10.1 风险矩阵

| 风险项 | 可能性 | 影响 | 应对策略 |
|--------|--------|------|----------|
| URL 抓取失败 | 中 | 中 | 提供手动粘贴兜底；优化提取算法 |
| 复杂页面解析效果差 | 中 | 中 | 人工修正入口；多源验证 |
| LLM 输出不稳定 | 低 | 高 | 固定 Prompt 结构；结果校验；降级方案 |
| 用户翻译质量差异大 | 高 | 中 | 设计宽容度评估；分层次反馈 |
| 知识点沉淀门槛高 | 中 | 高 | 简化确认流程；自动沉淀默认开启 |
| 用户流失（步骤太多） | 高 | 高 | 最小闭环设计；进度保存；随时退出 |

### 10.2 核心应对原则

```
1. 兜底思维：每个功能都有备选方案
2. 最小闭环：核心路径越短越好
3. 正向激励：让用户感受到进步
4. 进度可见：每一步都有成就感
```

---

## 十一、后续迭代方向（P1）

### 11.1 知识库增强

| 功能 | 说明 | 优先级 |
|------|------|--------|
| 艾宾浩斯复习 | 基于遗忘曲线推送复习 | P1 |
| 每日推送 | 邮件/消息提醒学习 | P1 |
| 能力画像 | 识别用户薄弱领域 | P1 |
| 智能推荐 | 推荐适合当前水平的文章 | P1 |

### 11.2 内容生态

| 功能 | 说明 | 优先级 |
|------|------|--------|
| 精选文章库 | 编辑推荐优质英文文章 | P2 |
| 社区讨论 | 知识点讨论区 | P2 |
| 学习数据分享 | 分享学习进度/成就 | P2 |

### 11.3 个性化模型

| 功能 | 说明 | 优先级 |
|------|------|--------|
| 能力评估 | 测试用户当前水平 | P1 |
| 难度自适应 | 动态调整推荐难度 | P1 |
| 学习路径 | 推荐学习顺序 | P2 |

---

## 十二、附录

### 12.1 术语表

| 术语 | 说明 |
|------|------|
| MVP | Minimum Viable Product，最小可行产品 |
| P0/P1 | 优先级标识，P0 = 必须做，P1 = 建议做 |
| CET-4/6 | 大学英语四/六级 |
| TOEFL/IELTS | 托福/雅思考试 |
| IndexedDB | 浏览器本地数据库 |
| SSE | Server-Sent Events，服务器推送事件 |

### 12.2 参考资料

- Next.js 文档：https://nextjs.org/docs
- shadcn/ui 文档：https://ui.shadcn.com/
- LLM SDK 文档：coze-coding-dev-sdk

---

> 文档版本历史
> - v1.0 (2025) - 初始版本，完成 MVP 方案设计
