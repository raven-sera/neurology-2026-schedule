import rawSchedule from '../data/schedule.json';
import { publicPath } from './sitePaths';

export type ReportKind = string;
export type Report = {
  id:number; kind:ReportKind; scheduleCategory:'主日程'|'专题会'; program:string; session:string;
  abstractNo:string; sourceTitle:string;
  speaker:string; institution:string; dateTime:string; location:string; field:string; directions:string[];
  officialUrl:string; searchAliases:string; chairman:string; sourceRow:number; sessionTime:string;
};

const officialUrl = publicPath('/data/2026神经病学年会日程.xlsx');
export const reports:Report[] = rawSchedule.map((row) => ({
  ...row,
  scheduleCategory: row.scheduleCategory as Report['scheduleCategory'],
  officialUrl,
  searchAliases: '',
}));
export const reportKindCounts:Record<ReportKind,number> = {};
for (const report of reports) reportKindCounts[report.kind] = (reportKindCounts[report.kind] ?? 0) + 1;
export const contentKinds = Object.keys(reportKindCounts);
export const fields = Array.from(new Set(reports.map((report) => report.field)));
export const directions = Array.from(new Set(reports.flatMap((report) => report.directions)));

const timing = new WeakMap<Report, { day:string; start:number; end:number; timestamp:number }>();
for (const report of reports) {
  const match = report.dateTime.match(/^(\d{4}-\d{2}-\d{2}).*?(\d{2}):(\d{2})-(\d{2}):(\d{2})$/);
  if (!match) throw new Error(`Invalid imported schedule time at source row ${report.sourceRow}`);
  timing.set(report, {
    day: match[1],
    start: Number(match[2]) * 60 + Number(match[3]),
    end: Number(match[4]) * 60 + Number(match[5]),
    timestamp: Date.parse(`${match[1]}T${match[2]}:${match[3]}:00+08:00`),
  });
}
export const CONFERENCE_DAYS = Array.from(new Set(reports.map((report) => timing.get(report)!.day))).sort().map((date) => {
  const [, month, day] = date.split('-').map(Number);
  return { date, monthDay: `${month}.${day}`, weekday: `周${'日一二三四五六'[new Date(`${date}T00:00:00Z`).getUTCDay()]}` };
});
export const CONFERENCE_FIRST_MINUTE = Math.min(...reports.map((report) => timing.get(report)!.start));
export const CONFERENCE_LAST_MINUTE = Math.max(...reports.map((report) => timing.get(report)!.end));

function reportTimestamp(report:Report) {
  const cached = timing.get(report);
  if (cached) return cached.timestamp;
  const match = report.dateTime.match(/^(\d{4}-\d{2}-\d{2}).*?(\d{2}:\d{2})/);
  return match ? Date.parse(`${match[1]}T${match[2]}:00+08:00`) : Number.POSITIVE_INFINITY;
}
export function sortReportsByDateTime(input:readonly Report[]) {
  return [...input].sort((a,b) => reportTimestamp(a) - reportTimestamp(b) || a.id - b.id);
}

const norm = (value:string) => value.toLocaleLowerCase().normalize('NFKC').replace(/[^a-z0-9\u3400-\u9fff]+/g,'');
function levenshtein(a:string,b:string) {
  if (!a.length) return b.length; if (!b.length) return a.length;
  const row = Array.from({length:b.length+1},(_,i)=>i);
  for (let i=1;i<=a.length;i++) { let prev=row[0]; row[0]=i; for(let j=1;j<=b.length;j++){ const old=row[j]; row[j]=Math.min(row[j]+1,row[j-1]+1,prev+(a[i-1]===b[j-1]?0:1)); prev=old; } }
  return row[b.length];
}
const searchIndex = new WeakMap<Report, { hay:string; tokens:string[] }>();
let previousQuery = '', normalizedQuery = '';
export function searchScore(report:Report, query:string) {
  if (query !== previousQuery) { previousQuery = query; normalizedQuery = norm(query); }
  const q = normalizedQuery;
  if (!q) return 1;
  let index = searchIndex.get(report);
  if (!index) {
    const source = [report.sourceTitle,report.speaker,report.institution,report.chairman,report.program,report.session,report.location,report.kind,report.field,report.directions.join(' '),report.abstractNo,report.dateTime,report.sessionTime].join(' ');
    index = {
      hay: norm(source),
      tokens: Array.from(new Set(source.toLowerCase().split(/[^a-z0-9\u3400-\u9fff]+/).map(norm).filter(Boolean))),
    };
    searchIndex.set(report,index);
  }
  const position = index.hay.indexOf(q);
  if (position >= 0) return 100 - position / 1000;
  if (q.length > 32 || q.length < 2) return 0;
  const threshold = q.length <= 4 ? 1 : q.length <= 8 ? 2 : 3;
  let best = threshold + 1;
  for (const token of index.tokens) {
    if (Math.abs(token.length - q.length) > threshold) continue;
    best = Math.min(best,levenshtein(token,q));
    if (best === 0) break;
  }
  return best <= threshold ? 60 - best : 0;
}
