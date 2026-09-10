'use client';
import Link from 'next/link';
export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return <main className="entryLoading"><h1 style={{fontSize:28}}>页面暂时没能打开</h1><p>请检查网络，然后重新尝试。已保存的笔记和日程仍在当前浏览器。</p><button onClick={reset}>重新加载</button><Link href="/">返回大会日程 →</Link></main>;
}
