// ============================================================
// LLM 调用封装
//
// 模型由用户自带（BYOK），每次调用显式传入 ModelConfig。
// 服务端不持有任何模型 Key，也不依赖特定厂商 SDK。
// 接口走 OpenAI 兼容的 /chat/completions。
// ============================================================

import type { ModelConfig } from "./model";
import type { DiagnosisAnalysis, KnowledgePoint } from "@/types";

interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMResponse {
  content: string;
}

const REQUEST_TIMEOUT_MS = 120_000;

/**
 * 调一次 OpenAI 兼容的 chat completions。
 * 失败时抛出带状态码的错误——调用方必须如实上报，不允许编造结果。
 */
export async function invokeLLM(
  messages: Message[],
  model: ModelConfig,
  temperature: number = 0.7
): Promise<LLMResponse> {
  const response = await fetch(`${model.base_url}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${model.api_key}`,
    },
    body: JSON.stringify({
      model: model.model,
      messages,
      temperature,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `模型调用失败：HTTP ${response.status}${detail ? ` - ${detail.slice(0, 200)}` : ""}`
    );
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  return {
    content: data.choices?.[0]?.message?.content?.toString() ?? "",
  };
}

// ============================================================
// Prompt 模板
// ============================================================
const SYSTEM_PROMPTS = {
  translateAndDiagnose: `你是一位专业的英文翻译专家和耐心的英文学习教练。

任务分两步：
第一步：翻译原文为中文
第二步：对比用户翻译与你的翻译，分析用户的理解情况

分析维度：
- correct（理解正确）：用户翻译准确表达了原意
- alternative（表达可优化）：意思正确但有更精准/更地道的表达
- missed（遗漏要点）：用户漏译或理解不到位的重要内容

反馈原则：
1. 先肯定：先列出用户理解正确的部分，给予正向反馈
2. 再建议：对差异和遗漏给出具体、可操作的改进建议
3. 不批评：语气温和，避免让用户产生挫败感
4. 讲道理：每个建议都要解释"为什么"

输出格式（JSON）：
{
  "aiTranslation": "你的参考翻译（中文）",
  "diagnosis": {
    "correct": [
      {"text": "原文片段", "feedback": "用户理解准确的说明"}
    ],
    "alternative": [
      {"original": "原文", "yourTranslation": "用户的翻译", "betterTranslation": "更好的翻译", "reason": "为什么更好的说明"}
    ],
    "missed": [
      {"text": "漏译的原文", "meaning": "含义解释", "reason": "为什么重要的说明"}
    ]
  }
}`,

  extractKnowledgeFromDiagnosis: `你是一位细心的英文学习分析师。

你将收到：
- 原文
- AI 参考翻译
- 用户翻译
- 诊断分析结果（包含正确、可优化、遗漏）

任务：
基于诊断分析中的"表达可优化"(alternative)和"遗漏要点"(missed)，
结合原文，提取**原子级别**的知识点。

【核心原则：知识点必须是独立的单词或固定搭配】

知识点分类：
- word：单词（如：interview, caveat, merit, subsequent）
- phrase：固定搭配/词组（如：in terms of, due to, take into account）
- pattern：句式/表达模式
- comprehension_point：理解难点

【提取规则 - 非常重要】

1. **词性还原**
   - 如果原文是可数名词复数，提取单数形式
   - 例如：interviews → interview, caveats → caveat, sections → section

2. **拆分组合表达**
   - 如果是可优化/遗漏的是一个组合（如"subsequent sections"）
   - 先判断是否是一个固定搭配
   - 如果不是固定搭配，提取其中关键的单词
   - 例如："subsequent sections" → subsequent（不是固定搭配时）

3. **提取单词，不是句子**
   - ❌ 错误：be adopted at an ever-larger scale
   - ✅ 正确：adopt（动词采纳）, ever-larger scale（固定表达）

4. **只提取有学习价值的词**
   - 常见词（如 more, their, whatever）如果只是指代问题，不要提取
   - 重点提取：
     - 用户不认识的单词
     - 一词多义中用户混淆的用法
     - 固定搭配或短语动词
     - 地道的表达方式

5. **每个知识点独立完整**
   - content 只包含单词或固定搭配
   - 不是整个句子片段

输出格式（JSON数组）：
[
  {
    "type": "word|phrase|pattern|comprehension_point",
    "content": "知识点原文（单词或固定搭配）",
    "meaning": "中文含义",
    "explanation": "解释说明",
    "difficulty": "cet4|cet6|toefl|ielts|advanced"
  }
]`,
};

// ============================================================
// 完整的诊断流程（翻译 + 诊断 + 知识点提取）
// ============================================================

export interface FullDiagnosisResult {
  aiTranslation: string;
  analysis: DiagnosisAnalysis;
  knowledgePoints: Omit<KnowledgePoint, "id" | "createdAt">[];
}

async function translateAndDiagnose(
  originalParagraph: string,
  userTranslation: string,
  model: ModelConfig
): Promise<{ aiTranslation: string; analysis: DiagnosisAnalysis }> {
  const response = await invokeLLM(
    [
      { role: "system", content: SYSTEM_PROMPTS.translateAndDiagnose },
      {
        role: "user",
        content: `请翻译原文并进行诊断分析：

原文：
---
${originalParagraph}
---

用户翻译：
---
${userTranslation}
---

请输出 JSON 格式的结果，包含 AI 翻译和诊断分析。`,
      },
    ],
    model,
    0.7
  );

  try {
    const jsonMatch = response.content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[0]);
      return {
        aiTranslation: result.aiTranslation || "",
        analysis: result.diagnosis || {
          correct: [],
          alternative: [],
          missed: [],
        },
      };
    }
  } catch {
    // 模型返回的不是合法 JSON：按空结果处理，由调用方决定如何提示
  }

  return {
    aiTranslation: "",
    analysis: { correct: [], alternative: [], missed: [] },
  };
}

async function extractKnowledgeFromDiagnosis(
  originalParagraph: string,
  userTranslation: string,
  aiTranslation: string,
  analysis: DiagnosisAnalysis,
  sourceParagraphId: string,
  sourceArticleId: string,
  model: ModelConfig
): Promise<Omit<KnowledgePoint, "id" | "createdAt">[]> {
  const response = await invokeLLM(
    [
      { role: "system", content: SYSTEM_PROMPTS.extractKnowledgeFromDiagnosis },
      {
        role: "user",
        content: `请基于诊断分析结果提取知识点：

原文：
---
${originalParagraph}
---

AI 参考翻译：
---
${aiTranslation}
---

用户翻译：
---
${userTranslation}
---

诊断分析结果：
${JSON.stringify(analysis, null, 2)}

请输出 JSON 数组格式的知识点。`,
      },
    ],
    model,
    0.5
  );

  try {
    const jsonMatch = response.content.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const points = JSON.parse(jsonMatch[0]);
      return points.map(
        (p: {
          type: string;
          content: string;
          meaning: string;
          explanation?: string;
          difficulty: string;
        }) => ({
          type: p.type as KnowledgePoint["type"],
          content: p.content,
          meaning: p.meaning,
          explanation: p.explanation || "",
          difficulty: p.difficulty as KnowledgePoint["difficulty"],
          example: originalParagraph,
          sourceParagraphId,
          sourceArticleId,
          sourceArticleTitle: "",
          masterStatus: "learning" as const,
          reviewCount: 0,
        })
      );
    }
  } catch {
    // 解析失败按无知识点处理
  }

  return [];
}

export async function performFullDiagnosis(
  originalParagraph: string,
  userTranslation: string,
  sourceParagraphId: string,
  sourceArticleId: string,
  model: ModelConfig
): Promise<FullDiagnosisResult> {
  // 步骤 1+2：翻译 + 诊断分析（一次调用）
  const { aiTranslation, analysis } = await translateAndDiagnose(
    originalParagraph,
    userTranslation,
    model
  );

  // 步骤 3：基于诊断结果提取原子级知识点
  const knowledgePoints = await extractKnowledgeFromDiagnosis(
    originalParagraph,
    userTranslation,
    aiTranslation,
    analysis,
    sourceParagraphId,
    sourceArticleId,
    model
  );

  return { aiTranslation, analysis, knowledgePoints };
}
