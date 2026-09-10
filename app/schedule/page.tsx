import Explorer from '../components/Explorer';
export const metadata = { title:'我的日程', description:'查看神经病学年会个人听会安排、时间冲突、会议笔记与打卡记录。' };

export default function SchedulePage() {
  return <Explorer initialPage="schedule" />;
}
