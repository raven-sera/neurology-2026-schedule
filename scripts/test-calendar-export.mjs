import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const file = new URL('../app/lib/scheduleTools.ts', import.meta.url);
const code = ts.transpileModule(readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const api = {};
vm.runInThisContext(`(function(exports){${code}\n})`, { filename: file.pathname })(api);

const reports = JSON.parse(readFileSync(new URL('../app/data/schedule.json', import.meta.url), 'utf8'));
const calendar = api.createCalendarFile(reports, Date.UTC(2026, 8, 10));
const lines = calendar.replace(/\r\n[ \t]/g, '').split('\r\n');
assert.equal(lines[0], 'BEGIN:VCALENDAR', 'Calendar import requires the outer VCALENDAR envelope');
assert.equal(lines.at(-2), 'END:VCALENDAR', 'The complete event set must remain inside VCALENDAR');
const events = calendar.replace(/\r\n[ \t]/g, '').split('BEGIN:VEVENT\r\n').slice(1).map(block => block.split('\r\nEND:VEVENT')[0].split('\r\n'));
assert.equal(events.length, reports.length, 'Exporting the complete schedule must not lose ceremonies or late sessions');
const eventById = new Map(events.map(event => [event.find(line => line.startsWith('UID:')), event]));
assert.equal(eventById.size, reports.length, 'Every imported schedule row needs a distinct calendar identity');

const opening = reports.find(report => report.sourceTitle === '开幕式');
const closing = reports.find(report => report.sourceTitle === '闭幕式');
const late = reports.find(report => report.dateTime === '2026-09-11 晚上 21:40-22:00');
assert.ok(opening && closing && late, 'Source schedule must retain both ceremonies and the 22:00 night session');
const openingEvent = eventById.get(`UID:neuro2026-${opening.id}@huidu`);
const closingEvent = eventById.get(`UID:neuro2026-${closing.id}@huidu`);
const lateEvent = eventById.get(`UID:neuro2026-${late.id}@huidu`);
assert.ok(openingEvent.includes('DTSTART:20260911T003000Z'), 'Opening ceremony inherits its 08:30 session start in China');
assert.ok(openingEvent.includes('DTEND:20260911T010000Z'), 'Opening ceremony retains the full session duration');
assert.ok(closingEvent.includes('DTSTART:20260913T034000Z'), 'Closing ceremony remains on the final conference date');
assert.ok(closingEvent.includes('DTEND:20260913T035000Z'), 'Closing ceremony inherits its 11:50 session end');
assert.ok(lateEvent.includes('DTSTART:20260911T134000Z'), '21:40 China time must import as 13:40 UTC');
assert.ok(lateEvent.includes('DTEND:20260911T140000Z'), 'Calendar export must not truncate the 22:00 night session');
console.log('PASS: complete source schedule, ceremony fallback times, and late-night ICS import times.');
