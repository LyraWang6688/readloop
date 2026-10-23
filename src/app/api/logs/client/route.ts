import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 前端日志接收端。
 *
 * 浏览器端（`src/lib/client-logger.ts`）会把未捕获错误批量发到这里。
 * MVP 只做「接收并返回 204」：服务端运行日志已经由 `src/lib/logger.ts` 落地，
 * 不再把用户浏览器的日志写进服务器磁盘（避免公开接口被当作日志注入通道）。
 * 保留路由是因为前端仍在调用；缺了它页面控制台会出现 404。
 */
export async function POST() {
  return new NextResponse(null, { status: 204 });
}
