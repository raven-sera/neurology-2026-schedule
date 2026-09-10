import Link from 'next/link';
export default function NotFound() {
  return <main className="entryLoading"><h1 style={{fontSize:28}}>这个页面暂不存在</h1><p>返回大会日程，继续浏览报告和安排听会计划。</p><Link href="/">返回大会日程 →</Link></main>;
}
