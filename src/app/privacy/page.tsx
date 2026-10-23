import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "隐私政策",
  description: "ReadLoop 隐私政策与 Chrome 插件数据处理说明。",
};

const sections = [
  {
    title: "我们处理哪些信息",
    items: [
      "你主动选中的网页英文文本，以及你为这段文字输入的中文翻译。",
      "由翻译对比诊断生成的知识点，包括知识点内容、释义、解释、来源链接和复习状态。",
      "用于排障的基础日志，例如接口请求状态和错误信息；日志不记录你的模型 API Key。",
    ],
  },
  {
    title: "我们如何使用这些信息",
    items: [
      "生成参考翻译、翻译对比诊断和原子级知识点。",
      "把你的薄弱点写入你自己的知识库，用于后续复习调度。",
      "定位服务异常、修复缺陷。",
    ],
  },
  {
    title: "Chrome 插件说明",
    items: [
      "插件只会在你主动选中文本、点击插件按钮或右键菜单时读取当前网页选区。",
      "插件会把选中文本和你的翻译发送到 ReadLoop 服务，用于生成诊断结果。",
      "插件不包含数据库密码，也不包含任何 AI Key 或密钥。",
      "插件不会读取与你划词无关的页面内容。",
    ],
  },
  {
    title: "数据存在哪里",
    items: [
      "知识库存在你自己的飞书多维表格里，由你的账号持有；我们不托管、不汇总用户数据。",
      "插件本地只保存连接配置：服务地址、你的表格标识，以及你自己配置的大模型 API 信息。",
      "生成题目时，相关文本会发送给你自行配置的大模型服务商，其处理方式遵循该服务商的隐私政策。",
      "我们不会出售用户数据，也不会把数据用于与阅读练习无关的广告用途。",
    ],
  },
  {
    title: "你的控制权",
    items: [
      "是否把 AI 诊断生成的知识点存入知识库，由你决定。",
      "删除你自己的多维表格，即删除全部知识库数据。",
      "卸载插件会清除本机保存的连接配置。",
    ],
  },
];

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-50 via-indigo-50 to-white px-6 py-12 text-slate-900">
      <article className="mx-auto max-w-4xl rounded-[2rem] border border-white/80 bg-white/88 p-8 shadow-2xl shadow-indigo-100 backdrop-blur md:p-12">
        <p className="mb-3 text-sm font-semibold uppercase tracking-[0.24em] text-indigo-500">
          ReadLoop
        </p>
        <h1 className="text-3xl font-bold tracking-tight md:text-5xl">
          隐私政策
        </h1>
        <p className="mt-5 text-lg leading-8 text-slate-600">
          ReadLoop 是一个英文阅读练习工具。我们只围绕“阅读、翻译诊断、知识点沉淀和复习”处理必要数据，并尽量避免收集与产品目标无关的信息。
        </p>
        <p className="mt-4 text-sm text-slate-500">
          更新日期：2026 年 10 月 23 日
        </p>

        <div className="mt-10 grid gap-6">
          {sections.map((section) => (
            <section key={section.title} className="rounded-3xl border border-slate-100 bg-slate-50/70 p-6">
              <h2 className="text-xl font-semibold text-slate-900">{section.title}</h2>
              <ul className="mt-4 space-y-3 text-slate-600">
                {section.items.map((item) => (
                  <li key={item} className="flex gap-3 leading-7 text-slate-600">
                    <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-indigo-500" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        <section className="mt-8 rounded-3xl bg-indigo-600 p-6 text-white">
          <h2 className="text-xl font-semibold">联系我们</h2>
          <p className="mt-3 leading-7 text-indigo-50">
            如你对隐私政策、数据删除或 Chrome 插件数据处理有疑问，请通过产品管理员渠道联系 ReadLoop 团队。
          </p>
        </section>
      </article>
    </main>
  );
}
