import type { Report } from './reports';

export function reportInterval(report: Pick<Report, 'dateTime'>) {
  const match = report.dateTime.match(/^(\d{4}-\d{2}-\d{2}).*?(\d{2}):(\d{2})[-–—](\d{2}):(\d{2})/);
  if (!match) return null;
  const start = Date.parse(`${match[1]}T${match[2]}:${match[3]}:00+08:00`);
  const end = Date.parse(`${match[1]}T${match[4]}:${match[5]}:00+08:00`);
  return Number.isFinite(start) && end > start ? { start, end } : null;
}

export function scheduleConflicts(reports: readonly Report[]) {
  const conflicts = new Map<number, number[]>();
  const timed = reports.map(report => ({ report, interval: reportInterval(report) })).filter(item => item.interval !== null);
  timed.sort((a, b) => a.interval!.start - b.interval!.start);
  for (let i = 0; i < timed.length; i++) {
    for (let j = i + 1; j < timed.length && timed[j].interval!.start < timed[i].interval!.end; j++) {
      const a = timed[i].report.id, b = timed[j].report.id;
      conflicts.set(a, [...(conflicts.get(a) ?? []), b]);
      conflicts.set(b, [...(conflicts.get(b) ?? []), a]);
    }
  }
  return conflicts;
}

export function nextScheduledReport(reports: readonly Report[], now: number) {
  return [...reports].filter(report => { const interval = reportInterval(report); return interval && interval.end > now; })
    .sort((a, b) => reportInterval(a)!.start - reportInterval(b)!.start)[0] ?? null;
}

const escapeCalendar = (value: string) => value.replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll(',', '\\,').replaceAll(';', '\\;').replaceAll('\r', '');
const calendarDate = (value: number) => new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
function foldLine(line: string) {
  const encoder = new TextEncoder();
  let current = '', bytes = 0;
  const lines: string[] = [];
  for (const char of line) {
    const size = encoder.encode(char).length;
    if (bytes + size > 75) { lines.push(current); current = ' '; bytes = 1; }
    current += char; bytes += size;
  }
  return [...lines, current].join('\r\n');
}
export function createCalendarFile(reports: readonly Report[], now = Date.now()) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Huidu//CMANCN 2026//ZH', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  for (const report of reports) {
    const interval = reportInterval(report);
    if (!interval) continue;
    lines.push('BEGIN:VEVENT', `UID:neuro2026-${report.id}@huidu`, `DTSTAMP:${calendarDate(now)}`, `DTSTART:${calendarDate(interval.start)}`, `DTEND:${calendarDate(interval.end)}`, `SUMMARY:${escapeCalendar(report.sourceTitle)}`, `LOCATION:${escapeCalendar(report.location)}`, `DESCRIPTION:${escapeCalendar(report.speaker + ' · ' + report.institution + '\n' + report.program + '\n' + report.chairman)}`, 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}
export function downloadCalendar(reports: readonly Report[]) {
  const blob = new Blob([createCalendarFile(reports)], { type:'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = 'CMANCN 2026-我的日程.ics'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

