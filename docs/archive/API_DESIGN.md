# API 接口设计文档

> 版本：v1.0
> 状态：历史方案参考
>
> 当前知识库已切换为 PostgreSQL + Drizzle 路线，`/api/knowledge`
> 已承担知识点入库、去重累加和事件记录职责。本文中的段落难度分析、
> 推荐机制和旧同步接口设计仅作早期参考，当前源码不再提供
> `/api/paragraph/analyze` 路由。当前产品定位请见
> [PRODUCT_POSITIONING.md](./PRODUCT_POSITIONING.md)。

---

## 一、接口概述

### 1.1 接口环境

| 环境 | 基础 URL |
|------|----------|
| 开发环境 | `http://localhost:3000` |
| 生产环境 | `https://{COZE_PROJECT_DOMAIN_DEFAULT}` |

### 1.2 通用说明

**请求格式**
- Content-Type: `application/json`
- 字符编码: UTF-8

**响应格式**
```typescript
interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
}
```

**通用错误码**
| 错误码 | 说明 |
|--------|------|
| `INVALID_PARAMS` | 参数错误 |
| `PARSE_FAILED` | 文章解析失败 |
| `LLM_ERROR` | LLM 服务调用失败 |
| `INTERNAL_ERROR` | 内部错误 |

---

## 二、接口详情

### 2.1 文章解析接口

**端点**: `POST /api/article/parse`

**功能**: 解析用户输入的 URL 或粘贴的文章内容

**请求体**:
```typescript
// 方式1：URL 抓取
{
  "type": "url",
  "url": "https://example.com/article"
}

// 方式2：手动粘贴
{
  "type": "paste",
  "title": "文章标题（可选）",
  "content": "文章正文内容..."
}
```

**响应**:
```typescript
{
  "success": true,
  "data": {
    "id": "art_abc123",
    "title": "The Future of AI",
    "url": "https://example.com/article",
    "paragraphs": [
      {
        "id": "p_001",
        "index": 0,
        "content": "The fundamental limitation of...",
        "status": "unread"
      }
    ],
    "wordCount": 1250,
    "readingTime": 5,
    "recommendedParagraphs": ["p_003", "p_005"]  // 推荐练习的段落ID
  }
}
```

**错误响应**:
```typescript
{
  "success": false,
  "error": {
    "code": "PARSE_FAILED",
    "message": "无法提取文章内容，请尝试手动粘贴"
  }
}
```

---

### 2.2 翻译诊断接口

**端点**: `POST /api/diagnose`

**功能**: 对比用户翻译与 AI 参考翻译，诊断薄弱点

**请求体**:
```typescript
{
  "articleId": "art_abc123",
  "paragraphId": "p_001",
  "originalParagraph": "The fundamental limitation of traditional machine learning is its dependency on manual feature engineering.",
  "userTranslation": "传统机器学习有一个根本的限制，即对手工特征工程的依赖。"
}
```

**响应**:
```typescript
{
  "success": true,
  "data": {
    "aiTranslation": "传统机器学习的根本局限在于其对人工特征工程的依赖。",
    "analysis": {
      "correct": [
        {
          "text": "fundamental limitation",
          "feedback": "理解准确：根本限制"
        },
        {
          "text": "dependency on",
          "feedback": "翻译正确：...的依赖"
        }
      ],
      "missed": [
        {
          "text": "manual",
          "meaning": "人工的（非手工的）",
          "reason": "漏译了这个词修饰特征的含义"
        }
      ],
      "alternative": [
        {
          "original": "limitation",
          "yourTranslation": "限制",
          "betterTranslation": "局限",
          "reason": "在技术语境中，"局限"更准确"
        }
      ]
    },
    "knowledgePoints": [
      {
        "id": "kp_new_001",
        "type": "word",
        "content": "manual",
        "meaning": "人工的，手动的（非自动的）",
        "explanation": "这里指人工特征工程，强调非自动化",
        "difficulty": "cet4",
        "example": "manual feature engineering（人工特征工程）"
      },
      {
        "id": "kp_new_002",
        "type": "phrase",
        "content": "be dependent on",
        "meaning": "取决于，依赖于",
        "explanation": "表示因果关系或条件依赖",
        "difficulty": "cet6",
        "example": "Success is dependent on effort.（成功取决于努力）"
      },
      {
        "id": "kp_new_003",
        "type": "pattern",
        "content": "Unlike X, Y...",
        "meaning": "与X不同，Y...",
        "explanation": "用于对比说明",
        "difficulty": "cet6",
        "example": "Unlike humans, machines need data.（与人类不同，机器需要数据）"
      }
    ],
    "qualityScore": 75
  }
}
```

---

### 2.4 知识点入库接口

**端点**: `POST /api/knowledge`

**功能**: 将用户翻译诊断产生的知识点写入 PostgreSQL。相同用户下相同 `type + normalizedContent` 的知识点不会重复新增，而是累加暴露次数和练习需求。

**请求体**:
```typescript
{
  "articleId": "art_abc123",
  "articleTitle": "The Future of AI",
  "paragraphId": "p_001",
  "points": [
    {
      "type": "phrase",
      "content": "be dependent on",
      "meaning": "依赖于",
      "explanation": "表示依赖关系",
      "difficulty": "cet6",
      "example": "The system is dependent on manual feature engineering."
    }
  ]
}
```

**响应**:
```typescript
{
  "success": true,
  "data": {
    "count": 1,
    "points": []
  }
}
```

---

### 2.5 练习题生成接口

**端点**: `POST /api/practice/generate`

**功能**: 基于知识点生成即时练习题

**请求体**:
```typescript
{
  "knowledgePoints": [
    {
      "id": "kp_001",
      "type": "word",
      "content": "manual",
      "meaning": "人工的",
      "example": "manual feature engineering"
    },
    {
      "id": "kp_002",
      "type": "phrase",
      "content": "be dependent on",
      "meaning": "取决于"
    }
  ],
  "count": 5,
  "articleContext": "The fundamental limitation of traditional ML is its dependency on manual feature engineering."
}
```

**响应**:
```typescript
{
  "success": true,
  "data": {
    "questions": [
      {
        "id": "q_001",
        "type": "fill_blank",
        "question": "The experts must _____ extract and format data features before training.",
        "options": ["automatically", "painstakingly", "quickly", "easily"],
        "correctAnswer": "painstakingly",
        "explanation": "painstakingly 表示煞费苦心地，符合文中描述人工特征工程费力的语境",
        "relatedPointId": "kp_xxx"
      },
      {
        "id": "q_002",
        "type": "match",
        "question": "请将下列短语与其含义匹配",
        "pairs": [
          {"phrase": "be dependent on", "meaning": "取决于"},
          {"phrase": "feature engineering", "meaning": "特征工程"},
          {"phrase": "manual work", "meaning": "手工工作"}
        ],
        "correctAnswers": {"be dependent on": "取决于", "feature engineering": "特征工程"},
        "explanation": "be dependent on 表示依赖关系，feature engineering 是机器学习术语",
        "relatedPointId": "kp_xxx"
      },
      {
        "id": "q_003",
        "type": "judge",
        "question": "判断理解正误：Unlike humans, machines can automatically identify relevant patterns.",
        "correctAnswer": false,
        "explanation": "原文说的是 unlike humans, machines CANNOT automatically...（与人类不同，机器不能自动识别），这句话的意思与原文相反",
        "relatedPointId": "kp_xxx"
      }
    ]
  }
}
```

---

## 三、接口调用流程

### 3.1 完整学习流程

```
1. 用户输入文章
   → POST /api/article/parse
   → 返回文章结构 + 段落列表

2. 用户选择段落练习
   → POST /api/diagnose (首次翻译后自动分析)
   → 返回 AI 翻译 + 差异分析 + 知识点

3. 用户确认知识点
   → POST /api/knowledge
   → 写入 PostgreSQL 知识库

4. 用户完成所有段落
   → 本地记录练习状态
   → 后续版本将文章、段落、练习记录服务端化

5. 用户请求练习
  → POST /api/practice/generate
  → 返回练习题
```

### 3.2 数据流向图

```
前端 (用户操作)
    │
    ├──────────────────────┐
    │                      │
    ↓                      ↓
Next.js API Routes    本地存储
    │                  (Zustand Persist)
    │                      │
    ├──────────────────────┤
    │                      │
    ↓                      ↓
LLM 服务               PostgreSQL
(豆包 2.0)            (知识库持久化)
```

---

## 四、LLM 调用配置

### 4.1 配置参数

| 参数 | 值 | 说明 |
|------|-----|------|
| API Base URL | `{需要用户提供}` | 豆包 API 端点 |
| API Key | `{需要用户提供}` | 豆包 API Key |
| Model | `doubao-seed-2-0-pro-260215` | 豆包 2.0 旗舰模型 |
| Temperature | 0.7 | 平衡准确性与创造性 |
| Max Tokens | 2000 | 单次响应最大 Token 数 |

### 4.2 流式输出

所有 LLM 调用均采用流式输出（SSE），提升用户体验。

**实现方式**:
- 后端: `ReadableStream` + SSE
- 前端: `fetch` + `body.getReader()`

---

## 五、错误处理

### 5.1 错误响应格式

```typescript
{
  "success": false,
  "error": {
    "code": "LLM_ERROR",
    "message": "模型服务暂时不可用，请稍后重试",
    "details": "Connection timeout"
  }
}
```

### 5.2 重试策略

| 错误类型 | 重试次数 | 重试间隔 |
|----------|----------|----------|
| 网络错误 | 3 | 1s, 2s, 4s |
| 限流 (429) | 3 | 5s, 10s, 30s |
| 服务不可用 (503) | 3 | 2s, 4s, 8s |

---

## 六、注意事项

1. **URL 解析失败**: 返回友好提示，引导用户手动粘贴
2. **LLM 超时**: 设置 30s 超时，超时后返回部分结果 + 错误提示
3. **知识库写入失败**: 返回错误提示；不影响用户继续阅读
4. **敏感信息**: 不在前端日志中输出用户翻译内容
