import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "ReadLoop 服务",
  description: "ReadLoop 后端服务：授权、今日题目、判分与一键创建飞书写入应用。",
};

/**
 * 极简服务首页。
 *
 * 这个仓库只提供后端接口与 Chrome 插件，不是用户产品页面；
 * 放一个可访问的首页，方便用户 / 部署者确认服务在线，并指向隐私政策。
 */
export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-8 px-6 py-16">
      <header className="space-y-3">
        <p className="text-sm tracking-wide text-neutral-500">ReadLoop</p>
        <h1 className="text-3xl font-semibold">后端服务运行中</h1>
        <p className="text-neutral-600">
          读的时候暴露短板，AI 助手按时帮你复习。这个域名只提供接口服务与 Chrome 插件所需的
          HTTP API，没有面向浏览器的练习界面。
        </p>
      </header>

      <section className="space-y-2 text-sm text-neutral-600">
        <p className="font-medium text-neutral-800">接口</p>
        <ul className="space-y-1 font-mono text-xs">
          <li>POST /api/license/activate</li>
          <li>POST /api/review/today</li>
          <li>POST /api/review/submit</li>
          <li>POST /api/setup/app/start · GET /api/setup/app/status · POST/GET /api/setup/app/pair</li>
          <li>POST /api/diagnose</li>
          <li>GET /api/health</li>
        </ul>
        <p>
          除激活与配对取凭证外，所有接口都需要{" "}
          <code className="rounded bg-neutral-100 px-1">Authorization: Bearer &lt;host_token&gt;</code>。
        </p>
      </section>

      <footer className="flex flex-wrap items-center gap-4 border-t border-neutral-200 pt-6 text-sm">
        <Link className="underline underline-offset-4" href="/privacy">
          隐私政策
        </Link>
        <a
          className="underline underline-offset-4"
          href="https://github.com/LyraWang6688/readloop"
          rel="noreferrer"
          target="_blank"
        >
          GitHub
        </a>
        <span className="text-neutral-400">服务状态可查 /api/health</span>
      </footer>
    </main>
  );
}
