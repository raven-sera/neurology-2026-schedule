import type { Metadata, Viewport } from 'next';
import './globals.css';
import './upgrade.css';
import { publicPath } from './lib/sitePaths';

export const viewport: Viewport = { width:'device-width', initialScale:1, viewportFit:'cover', themeColor:'#002FA7' };

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_ORIGIN || 'https://raven-sera.github.io'),
  title: { default: '神经病学年会 2026｜日程管理', template: '%s｜神经病学年会 2026' },
  description: '2026 年 9 月 11—13 日神经病学年会：检索大会日程、安排个人听会计划、收藏报告、记录笔记与 PPT。',
  icons: { icon: publicPath('/favicon.svg') },
  openGraph: {
    title: '神经病学年会 2026｜日程管理',
    description: '9.11—9.13 · 让每一场相遇，都有所收获。',
    images: [{ url: publicPath('/og.svg'), width: 1200, height: 630, alt: '神经病学年会 2026' }],
    locale: 'zh_CN',
    type: 'website',
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
