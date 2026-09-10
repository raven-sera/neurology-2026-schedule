import type { Metadata } from 'next';
import Explorer from '../components/Explorer';

export const metadata: Metadata = {
  title: '大会日程',
  description: '神经病学年会 2026 大会日程检索、个人听会安排、笔记记录与个人图书馆。',
};

export default function LearningPage() {
  return <Explorer />;
}
