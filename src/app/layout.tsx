import type { Metadata } from 'next';
import { ClientLayout } from '@/components/client-layout';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'ReadLoop | 读的时候暴露短板，AI 助手按时帮你复习',
    template: '%s | ReadLoop',
  },
  description:
    '在真实阅读中暴露薄弱点，沉淀成你自己的知识库，再由 AI 助手按记忆曲线每天陪你复习。',
  keywords: [
    '英文阅读',
    '间隔重复',
    '翻译诊断',
    '知识点',
    '复习',
  ],
  authors: [{ name: 'ReadLoop' }],
  robots: {
    index: true,
    follow: true,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className={`antialiased min-h-screen bg-[var(--background)]`} suppressHydrationWarning>
        <ClientLayout>{children}</ClientLayout>
      </body>
    </html>
  );
}
