import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 健康检查：给部署脚本 / 监控用。
 * 不读任何密钥、不返回任何配置，只证明进程在跑。
 */
export async function GET() {
  return NextResponse.json(
    {
      status: "ok",
      service: "readloop",
      time: new Date().toISOString(),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
