import { NextRequest, NextResponse } from "next/server";
import { performFullDiagnosis } from "@/lib/llm";
import { ModelConfigError, normalizeModelConfig } from "@/lib/model";
import { requireHost } from "@/lib/http";
import { logger } from "@/lib/logger";
import type { DiagnoseResponse, ApiResponse } from "@/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface DiagnoseBody {
  articleId?: string;
  paragraphId?: string;
  originalParagraph?: string;
  userTranslation?: string;
  /** 用户自带的模型配置（BYOK），见 docs/ARCHITECTURE.md §5.5 */
  model?: unknown;
}

// POST /api/diagnose
export async function POST(request: NextRequest) {
  try {
    // 插件 / 宿主都要先有 host_token（年度授权）；401 / 402 的语义与其它接口一致
    const guard = requireHost(request);
    if (!guard.ok) return guard.response;

    const body = (await request.json()) as DiagnoseBody;
    const { articleId, paragraphId, originalParagraph, userTranslation } = body;

    if (!originalParagraph || !userTranslation) {
      return NextResponse.json<ApiResponse<null>>(
        {
          success: false,
          error: { code: "INVALID_PARAMS", message: "请提供原文和翻译" },
        },
        { status: 400 }
      );
    }

    if (userTranslation.trim().length < 5) {
      return NextResponse.json<ApiResponse<null>>(
        {
          success: false,
          error: {
            code: "INVALID_PARAMS",
            message: "翻译内容太短，请输入更完整的翻译",
          },
        },
        { status: 400 }
      );
    }

    // 模型配置由调用方自带；服务端不保存，也不允许指向内网
    let model;
    try {
      model = normalizeModelConfig(body.model);
    } catch (error) {
      const message =
        error instanceof ModelConfigError ? error.message : "model 配置无效";
      return NextResponse.json<ApiResponse<null>>(
        {
          success: false,
          error: { code: "MODEL_CONFIG_INVALID", message },
        },
        { status: 400 }
      );
    }

    const result = await performFullDiagnosis(
      originalParagraph,
      userTranslation,
      paragraphId ?? "",
      articleId ?? "",
      model
    );

    const response: DiagnoseResponse = { ...result, paragraphId: paragraphId ?? "" };

    return NextResponse.json<ApiResponse<DiagnoseResponse>>({
      success: true,
      data: response,
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    const isTimeout =
      errorMsg.includes("timeout") || errorMsg.includes("aborted");

    logger.error("diagnose failed", {
      error: errorMsg,
      isTimeout,
      type: error instanceof Error ? error.constructor.name : "Unknown",
    });

    if (isTimeout) {
      return NextResponse.json<ApiResponse<null>>(
        {
          success: false,
          error: {
            code: "LLM_TIMEOUT",
            message: "AI 分析超时，请稍后重试",
          },
        },
        { status: 504 }
      );
    }

    return NextResponse.json<ApiResponse<null>>(
      {
        success: false,
        error: {
          code: "LLM_ERROR",
          message: "AI 服务暂时不可用，请稍后重试",
          details: errorMsg,
        },
      },
      { status: 503 }
    );
  }
}
