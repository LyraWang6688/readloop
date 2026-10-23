/**
 * POST /api/review/metrics
 *
 * 宿主把「答题记录 + 当前知识点」传上来，服务算出一组可复核的学习效果指标：
 * 间隔分档保持率、整体正确率是否在 70–85%、答错率、leech 占比、完成率、每题用时，
 * 以及确定性的改进建议（不调模型）。
 *
 * 服务端不存数据：算完即忘，响应里也没有任何知识点原文的额外暴露。
 * 契约见 docs/API_IMPLEMENTATION.md §6。
 */

import { internalError, jsonError, jsonOk, readJsonBody, requireHost } from "@/lib/http";
import { computeMetrics, MetricsInputError } from "@/lib/metrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const guard = requireHost(request);
    if (!guard.ok) return guard.response;

    const body = await readJsonBody<unknown>(request);
    if (!body) {
      return jsonError(400, "INVALID_PARAMS", "请求体必须是 JSON 对象");
    }

    try {
      const metrics = computeMetrics(body);
      return jsonOk(metrics);
    } catch (error) {
      if (error instanceof MetricsInputError) {
        return jsonError(400, "INVALID_PARAMS", error.message);
      }
      throw error;
    }
  } catch (error) {
    return internalError(error, "review/metrics");
  }
}
