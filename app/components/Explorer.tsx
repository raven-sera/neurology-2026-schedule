'use client';

import { lazy, memo, Suspense, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useDialog } from '../lib/useDialog';
import { useLocalRecord } from '../lib/useLocalRecord';
import { downloadCalendar, nextScheduledReport, reportInterval, scheduleConflicts } from '../lib/scheduleTools';
import CalendarSchedule from './CalendarSchedule';
import MapPlaceholder from './MapPlaceholder';
const CheckInCard = lazy(() => import('./CheckInCard'));
const CheckInAtlas = lazy(() => import('./CheckInAtlas'));
import type { ExportMode } from './ExportCenter';
const ExportCenter = lazy(() => import('./ExportCenter'));
import { BrandLockup } from './BrandLockup';
const ReportNotes = lazy(() => import('./ReportNotes'));
const PersonalLibrary = lazy(() => import('./PersonalLibrary'));
import { NOTEBOOK_OPEN_EVENT, requestNotebook, type NotebookOpenOptions } from '../lib/libraryTypes';
import { LIBRARY_CHANGE_EVENT, readLibrarySummaries, type LibrarySummary } from '../lib/noteStorage';
import './library-shell.css';
import {
  contentKinds, fields, reportKindCounts, reports, searchScore,
  sortReportsByDateTime, type Report,
} from '../lib/reports';
import { CHECK_IN_PHRASES, createCheckInRecord, isCheckInRecord, type CheckInRecord } from '../lib/checkIn';

const PAGE_SIZE = 12;
const DEFAULT_FIELD = '全部主题';
const DEFAULT_DIRECTION = '全部类型';
const DEFAULT_TIME_SLOT = '全部时间';
const DEFAULT_VENUE = '全部场地';
const DEFAULT_UNIT_TYPE = '全部单位类型';
const UNIT_TYPES = ['医院', '高校', '科研院所', '企业'] as const;
const FAVORITES_KEY = 'neuro2026-favorite-reports';
const SCHEDULE_KEY = 'neuro2026-custom-schedule-reports';
const CHECK_IN_KEY = 'neuro2026-report-attendance-v1';

const NAV_ITEMS = [
  { id: 'reports', label: '报告看板', href: '/learning#reports' },
  { id: 'schedule', label: '我的日程', href: '/schedule' },
  { id: 'library', label: '个人图书馆', href: '/library' },
] as const;

const ACADEMIC_UNIT_PATTERN = /大学|学院|学校|研究生院|University|Univeristy|College|School of/i;
const ENTERPRISE_UNIT_PATTERN = /公司|集团|药业|制药|生物医药|生物科技|生物技术|医疗科技|医药科技|研发中心|Pharma|Biotech|Therapeutics|\bInc\.?\b|\bLtd\.?\b|\bLLC\b|\bCorp\.?\b|AstraZeneca|Pfizer|Roche|Novartis|Bayer|Merck|BeiGene|Janssen|Amgen|Sanofi|AbbVie|GlaxoSmithKline|Bristol.?Myers|Eli Lilly/i;
const HOSPITAL_UNIT_PATTERN = /医院|医疗中心|卫生院|Hospital|Medical Center|Clinic/i;
const RESEARCH_UNIT_PATTERN = /研究院|研究所|研究中心|科学院|疾控|Institute|Research Center|Research Centre/i;

function getTimeSlot(report: Report) {
  const match = report.dateTime.match(/^\d{4}-(\d{2})-(\d{2})\s+(上午|下午|晚上)/);
  return match ? `${Number(match[1])}.${Number(match[2])}${match[3]}` : '';
}

function timeSlotRank(slot: string) {
  const match = slot.match(/^(\d+)\.(\d+)(上午|下午|晚上)$/);
  if (!match) return Number.POSITIVE_INFINITY;
  const period = { 上午: 0, 下午: 1, 晚上: 2 }[match[3] as '上午' | '下午' | '晚上'];
  return Number(match[1]) * 1000 + Number(match[2]) * 10 + period;
}

function getUnitTypes(institution: string) {
  const types: (typeof UNIT_TYPES)[number][] = [];
  if (HOSPITAL_UNIT_PATTERN.test(institution)) types.push('医院');
  if (RESEARCH_UNIT_PATTERN.test(institution)) types.push('科研院所');
  if (ACADEMIC_UNIT_PATTERN.test(institution)) types.push('高校');
  if (ENTERPRISE_UNIT_PATTERN.test(institution)) types.push('企业');
  return types;
}

const TIME_SLOT_BY_REPORT_ID = new Map(reports.map((report) => [report.id, getTimeSlot(report)]));
const UNIT_TYPES_BY_REPORT_ID = new Map(reports.map((report) => [report.id, getUnitTypes(report.institution)]));
const TIME_SLOTS = Array.from(new Set(TIME_SLOT_BY_REPORT_ID.values())).filter(Boolean).sort(
  (left, right) => timeSlotRank(left) - timeSlotRank(right),
);
const VENUES = Array.from(new Set(reports.map((report) => report.location.trim())))
  .filter(Boolean)
  .sort((left, right) => left.localeCompare(right, 'zh-CN'));



const REPORT_BY_ID = new Map(reports.map((report) => [report.id, report]));
const HERO_METRICS = [
  { value: reports.length, label: '场日程内容' },
  { value: contentKinds.filter(Boolean).length, label: '种日程类型' },
  { value: VENUES.length, label: '个原表会场' },
] as const;

type ActivePage = (typeof NAV_ITEMS)[number]['id'];
type ExportRequest = {
  reports:Report[];
  initialMode?:ExportMode;
  clearFavoritesAfterExport:boolean;
};

function notebookHash(reportId: number, options: NotebookOpenOptions = {}) {
  const params = new URLSearchParams();
  if (options.section) params.set('section', options.section);
  if (options.mode) params.set('mode', options.mode);
  if (options.capture) params.set('capture', '1');
  if (options.slideId) params.set('slide', options.slideId);
  return `#neuro2026-report-${reportId}${params.size ? `?${params}` : ''}`;
}

function notebookOptions(hash: string): NotebookOpenOptions {
  const params = new URLSearchParams(hash.split('?')[1] || '');
  const section = params.get('section');
  const mode = params.get('mode');
  return {
    section: section === 'slides' || section === 'text' || section === 'audio' ? section : undefined,
    mode: mode === 'read' || mode === 'edit' ? mode : undefined,
    capture: params.get('capture') === '1',
    slideId: params.get('slide') || undefined,
  };
}

function useNextScheduledReport(input: readonly Report[]) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, []);
  const report = nextScheduledReport(input, now);
  return { report, ongoing: Boolean(report && reportInterval(report)!.start <= now) };
}

const ReportCard = memo(function ReportCard({
  report,
  order,
  onOpen,
  favorite,
  onToggleFavorite,
  scheduled,
  onToggleSchedule,
}: {
  report: Report;
  order: number;
  onOpen: (report: Report) => void;
  favorite: boolean;
  onToggleFavorite: (report: Report) => void;
  scheduled: boolean;
  onToggleSchedule: (report: Report) => void;
}) {
  return (
    <article className="reportCard" style={{ animationDelay: `${Math.min(order, 8) * 45}ms` }}>
      <button
        className="cardHit"
        onClick={() => onOpen(report)}
        aria-label={`查看报告：${report.sourceTitle}`}
      />
      <div className="cardTopline">
        <div className="cardTagGroup">
          <span className="contentTypeTag" data-kind={report.kind}>{report.kind || '日程未提供'}</span>
          <span className="cancerTag">{report.field}</span>
        </div>
      </div>
      <h3>{report.sourceTitle}</h3>
      <div className="programLine">
        <span>专场</span>
        <strong title={report.program}>{report.program}</strong>
        {report.session && <b>{report.session}</b>}
      </div>
      <dl>
        <div><dt>报告人</dt><dd>{report.speaker} · {report.institution}</dd></div>
        <div><dt>时间</dt><dd>{report.dateTime}</dd></div>
        <div><dt>地点</dt><dd>{report.location}</dd></div>
      </dl>
      <div className="cardActions">
        <button
          className={`mobileScheduleButton ${scheduled ? 'isScheduled' : ''}`}
          onClick={() => onToggleSchedule(report)}
          aria-label={`${scheduled ? '移出' : '加入'}我的日程：${report.sourceTitle}`}
          aria-pressed={scheduled}
        >
          <span aria-hidden>{scheduled ? '✓' : '＋'}</span>
          {scheduled ? '已加入日程' : '加入日程'}
        </button>
        <button
          className={`favoriteButton ${favorite ? 'isFavorite' : ''}`}
          onClick={() => onToggleFavorite(report)}
          aria-label={`${favorite ? '取消收藏' : '收藏'}：${report.sourceTitle}`}
          aria-pressed={favorite}
        >
          <span aria-hidden>{favorite ? '★' : '☆'}</span>
          {favorite ? '已收藏' : '收藏'}
        </button>
        <span className="openButton" aria-hidden>进入学习页 <b>↗</b></span>
      </div>
    </article>
  );
});


function DetailView({ report, onClose, onLocate, favorite, onToggleFavorite, scheduled, onToggleSchedule, options, returnLabel }:{
  report:Report; onClose:()=>void; onLocate:(report:Report)=>void; favorite:boolean;
  onToggleFavorite:(report:Report)=>void; scheduled:boolean; onToggleSchedule:(report:Report)=>void;
  options:NotebookOpenOptions; returnLabel:string;
}) {
  useDialog('.detailOverlay', onClose);
  return (
    <div className="detailOverlay notebookDetailOverlay" role="dialog" aria-modal="true" aria-labelledby="detail-title"><div className="detailShell notebookDetailShell">
      <header className="detailTopbar"><button onClick={onClose} className="backButton">← {returnLabel}</button>
        <div className="detailTopActions"><button className={`detailFavoriteButton ${favorite?'isFavorite':''}`} onClick={()=>onToggleFavorite(report)} aria-pressed={favorite}>{favorite?'已收藏':'收藏'}</button><Link href="/library">个人图书馆</Link></div>
      </header>
      <section className="notebookReportHeader">
        <p>{report.field} · {report.speaker}</p>
        <h1 id="detail-title">{report.sourceTitle}</h1>
        <div className="notebookReportLine"><span>{report.dateTime}</span><span>{report.location}</span></div>
        <details className="notebookReportDetails"><summary>完整报告信息与日程</summary>
          <dl>
            <div><dt>报告人</dt><dd>{report.speaker} · {report.institution}</dd></div>
            <div><dt>主题</dt><dd>{report.field}</dd></div>
            <div><dt>小节</dt><dd>{report.session || '日程未提供'}</dd></div>
            <div><dt>小节编号</dt><dd>{report.abstractNo || '日程未提供'}</dd></div>
            <div><dt>主持人</dt><dd>{report.chairman || '日程未提供'}</dd></div>
            <div><dt>小节时间</dt><dd>{report.sessionTime || '日程未提供'}</dd></div>
            <div><dt>类型</dt><dd>{report.kind || '日程未提供'}</dd></div>
            <div><dt>来源 Excel 行号</dt><dd>{report.sourceRow}</dd></div>
          </dl>
          <div><button className="venueLocateButton" onClick={() => onLocate(report)} aria-haspopup="dialog">会场地图</button><button onClick={() => onToggleSchedule(report)} aria-pressed={scheduled}>{scheduled ? '已加入日程' : '加入日程'}</button><a href={report.officialUrl} target="_blank" rel="noreferrer">原始日程表 ↗</a></div>
        </details>
        <nav className="notebookQuickActions" aria-label="本场笔记快捷操作">
          <button onClick={() => requestNotebook(report.id, { section:'slides', capture:true, mode:'edit' })}>拍 PPT</button>
          <button onClick={() => requestNotebook(report.id, { section:'text', mode:'edit' })}>写笔记</button>
          <button onClick={() => requestNotebook(report.id, { mode:'read' })}>阅读本场资料</button>
        </nav>
      </section>
      <div className="notebookDetailContent"><Suspense fallback={<p className="moduleLoading" role="status">正在载入本场资料…</p>}>
        <ReportNotes report={report} initialSection={options.section} initialMode={options.mode ?? 'read'} autoCapture={options.capture} initialSlideId={options.slideId} />
      </Suspense></div>
    </div></div>
  );
}
function useFavorites() {
  const [favoriteIds, setFavoriteIds] = useLocalRecord<number[]>(FAVORITES_KEY, [], (value: unknown) => Array.isArray(value) ? [...new Set(value.filter((id): id is number => Number.isInteger(id) && REPORT_BY_ID.has(id as number)))] : []);

  const favoriteSet = useMemo(() => new Set(favoriteIds), [favoriteIds]);
  const favoriteReports = useMemo(
    () => favoriteIds
      .map((id) => REPORT_BY_ID.get(id))
      .filter((report): report is Report => Boolean(report)),
    [favoriteIds],
  );
  const toggleFavorite = useCallback((report: Report) => {
    setFavoriteIds((current) => current.includes(report.id)
      ? current.filter((id) => id !== report.id)
      : [...current, report.id]);
  }, []);
  const setReportsFavorite = useCallback((selectedReports: Report[], favorite: boolean) => {
    const selectedIds = new Set(selectedReports.map((report) => report.id));
    setFavoriteIds((current) => favorite
      ? [...current, ...selectedReports.map((report) => report.id).filter((id) => !current.includes(id))]
      : current.filter((id) => !selectedIds.has(id)));
  }, []);
  const clearFavorites = useCallback(() => setFavoriteIds([]), []);

  return { favoriteSet, favoriteReports, toggleFavorite, setReportsFavorite, clearFavorites };
}

function useCustomSchedule() {
  const [scheduleIds, setScheduleIds] = useLocalRecord<number[]>(SCHEDULE_KEY, [], (value: unknown) => Array.isArray(value) ? [...new Set(value.filter((id): id is number => Number.isInteger(id) && REPORT_BY_ID.has(id as number)))] : []);

  const scheduleSet = useMemo(() => new Set(scheduleIds), [scheduleIds]);
  const scheduledReports = useMemo(
    () => sortReportsByDateTime(
      scheduleIds
        .map((id) => REPORT_BY_ID.get(id))
        .filter((report): report is Report => Boolean(report)),
    ),
    [scheduleIds],
  );
  const addReports = useCallback((selectedReports: Report[]) => {
    setScheduleIds((current) => [
      ...current,
      ...selectedReports.map((report) => report.id).filter((id) => !current.includes(id)),
    ]);
  }, []);
  const removeReport = useCallback((report: Report) => {
    setScheduleIds((current) => current.filter((id) => id !== report.id));
  }, []);
  const clearSchedule = useCallback(() => setScheduleIds([]), []);

  return { scheduleSet, scheduledReports, addReports, removeReport, clearSchedule };
}

function useAttendance() {
  const [records, setRecords] = useLocalRecord<Record<number, CheckInRecord>>(CHECK_IN_KEY, {}, (value) => {
    const items = Array.isArray(value) ? value : value && typeof value === 'object' ? Object.values(value) : [];
    return Object.fromEntries(items.filter((record) => isCheckInRecord(record) && REPORT_BY_ID.has(record.reportId)).map(record => [record.reportId, record]));
  });

  const attendedIds = useMemo(
    () => new Set(Object.values(records).map((record) => record.reportId)),
    [records],
  );
  const markAttended = useCallback((report: Report) => {
    const existing = records[report.id];
    if (existing) return { record: existing, isFresh: false };
    const record = createCheckInRecord(report.id);
    setRecords((current) => current[report.id] ? current : { ...current, [report.id]: record });
    return { record, isFresh: true };
  }, [records]);

  return { records, attendedIds, markAttended };
}


function SiteHeader({ activePage }: { activePage: ActivePage }) {
  return (
    <header className="topbar">
      <Link className="brand" href="/" aria-label="返回日程总览">
        <BrandLockup compact />
      </Link>
      <nav aria-label="页面导航">
        {NAV_ITEMS.map((item) => (
          <Link
            className={activePage === item.id ? 'active' : ''}
            href={item.href}
            key={item.id}
            aria-current={activePage === item.id ? 'page' : undefined}
          >
            {item.label}
          </Link>
        ))}
      </nav>
      <span className="edition">NEURO 2026</span>
    </header>
  );
}

function Hero({ entries }: { entries: LibrarySummary[] }) {
  return <section className="workspaceHero" id="top">
    <div><p className="workspaceEyebrow">NEURO 2026 · 9.11—9.13</p><h1>神经病学年会<em>2026</em></h1>
      <p>9.11—9.13 三日日程，检索 {reports.length} 条会议内容，收藏、排期与听会记录一处管理。</p>
      <dl>{HERO_METRICS.map(metric => <div key={metric.label}><dt>{metric.value}</dt><dd>{metric.label}</dd></div>)}</dl>
    </div>
    <div className="workspaceShortcuts"><Link href="/schedule"><span>▦</span><div><strong>我的日程</strong><small>三日听会安排</small></div><b>→</b></Link><Link href="/library"><span>▤</span><div><strong>个人图书馆</strong><small>{entries.length ? `${entries.length} 场资料 · 随时继续阅读` : '笔记 · PPT · 录音归档'}</small></div><b>→</b></Link></div>
  </section>;
}

function MobileActionHub({ scheduledReports, onOpen, onLocate }:{scheduledReports:Report[];onOpen:(report:Report)=>void;onLocate:(report:Report)=>void}) {
  const { report: nextReport, ongoing } = useNextScheduledReport(scheduledReports);
  return (
    <section className="mobileActionHub" aria-label="手机端重点功能">
      <article className="mobileNextReport">
        <header><span>{ongoing ? '正在进行' : scheduledReports.length && !nextReport ? '已安排的报告均已结束' : '我的下一场'}</span><Link href="/schedule">{scheduledReports.length} 场日程 ↗</Link></header>
        {nextReport ? <>
          <small>{nextReport.dateTime.replace('2026-', '')}</small>
          <h2>{nextReport.sourceTitle}</h2>
          <p>{nextReport.speaker} · {nextReport.location}</p>
          <div><button onClick={() => onOpen(nextReport)}>查看详情</button><button onClick={() => onLocate(nextReport)} aria-haspopup="dialog">会场地图</button><button onClick={() => requestNotebook(nextReport.id, {section:'slides', mode:'edit', capture:true})}>拍 PPT</button><button onClick={() => requestNotebook(nextReport.id, {section:'text', mode:'edit'})}>写笔记</button></div>
        </> : <>
          <h2>{scheduledReports.length ? '听会结束，回看你的收获' : '先挑选你准备参加的报告'}</h2>
          <p>在报告卡片点击“加入日程”，这里会直接显示下一场。</p>
          <Link className="mobileNextEmptyAction" href="/learning#reports">浏览会议内容 →</Link>
        </>}
      </article>
      <Link className="librarySpotlight" href="/library">
        <span>PERSONAL LIBRARY</span><strong>回看我的听会资料</strong>
        <p>文字、PPT 与录音按报告自动归档。</p><b>打开个人图书馆 →</b>
      </Link>
    </section>
  );
}

function MobileBottomNav({activePage,scheduleCount}:{activePage:ActivePage;scheduleCount:number}) {
  return (
    <nav className="mobileBottomNav" aria-label="手机端主要导航">
      <Link className={activePage === 'reports' ? 'isActive' : ''} href="/learning#reports" aria-current={activePage === 'reports' ? 'page' : undefined}><span>⌕</span><b>报告看板</b></Link>
      <Link className={activePage === 'schedule' ? 'isActive' : ''} href="/schedule" aria-current={activePage === 'schedule' ? 'page' : undefined}><span>▣<i>{scheduleCount}</i></span><b>我的日程</b></Link>
      <Link className={activePage === 'library' ? 'isActive' : ''} href="/library" aria-current={activePage === 'library' ? 'page' : undefined}><span>▤</span><b>个人图书馆</b></Link>
    </nav>
  );
}

function SearchPanel({
  query,
  timeSlot,
  venue,
  unitType,
  field,
  direction,
  resultCount,
  updating,
  onQueryChange,
  onTimeSlotChange,
  onVenueChange,
  onUnitTypeChange,
  onFieldChange,
  onDirectionChange,
  onReset,
}: {
  query: string;
  timeSlot: string;
  venue: string;
  unitType: string;
  field: string;
  direction: string;
  resultCount: number;
  updating: boolean;
  onQueryChange: (value: string) => void;
  onTimeSlotChange: (value: string) => void;
  onVenueChange: (value: string) => void;
  onUnitTypeChange: (value: string) => void;
  onFieldChange: (value: string) => void;
  onDirectionChange: (value: string) => void;
  onReset: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const activeFilterCount = [timeSlot !== DEFAULT_TIME_SLOT, venue !== DEFAULT_VENUE, unitType !== DEFAULT_UNIT_TYPE, field !== DEFAULT_FIELD, direction !== DEFAULT_DIRECTION].filter(Boolean).length;
  const hasFilters = Boolean(
    query
      || timeSlot !== DEFAULT_TIME_SLOT
      || venue !== DEFAULT_VENUE
      || unitType !== DEFAULT_UNIT_TYPE
      || field !== DEFAULT_FIELD
      || direction !== DEFAULT_DIRECTION,
  );

  return (
    <section
      className={`searchDock ${updating ? 'isUpdating' : ''}`}
      aria-label="报告检索"
      aria-busy={updating}
    >
      <div className="searchIntro">
        <span>DISCOVER</span>
        <label htmlFor="report-search">检索报告</label>
      </div>
      <div className="searchField">
        <span aria-hidden>⌕</span>
        <input
          id="report-search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="搜索题目、报告人、主持人、单位或主题…"
          autoComplete="off"
        />
        {query && (
          <button onClick={() => onQueryChange('')} aria-label="清空搜索">×</button>
        )}
      </div>
      <div className="searchMeta" aria-live="polite">
        <strong>{resultCount}</strong>
        <span>{updating ? '正在筛选' : '场匹配'}</span>
      </div>
      <button className="filterToggle" onClick={() => setExpanded(!expanded)} aria-expanded={expanded} aria-controls="advanced-filters">{expanded ? '收起筛选' : '更多筛选'}{activeFilterCount > 0 ? ` · ${activeFilterCount} 项已选` : ''}<span>{expanded ? '−' : '＋'}</span></button>
      <div className={`filterRow ${expanded ? 'isExpanded' : ''}`} id="advanced-filters">
        <label>
          <span>时间</span>
          <select value={timeSlot} onChange={(event) => onTimeSlotChange(event.target.value)}>
            <option value={DEFAULT_TIME_SLOT}>{DEFAULT_TIME_SLOT}</option>
            {TIME_SLOTS.map((item) => <option key={item}>{item}</option>)}
          </select>
        </label>
        <label>
          <span>会议场地</span>
          <select value={venue} onChange={(event) => onVenueChange(event.target.value)}>
            <option value={DEFAULT_VENUE}>{DEFAULT_VENUE}</option>
            {VENUES.map((item) => <option key={item}>{item}</option>)}
          </select>
        </label>
        <label>
          <span>单位类型</span>
          <select value={unitType} onChange={(event) => onUnitTypeChange(event.target.value)}>
            <option value={DEFAULT_UNIT_TYPE}>{DEFAULT_UNIT_TYPE}</option>
            {UNIT_TYPES.map((item) => <option key={item}>{item}</option>)}
          </select>
        </label>
        <label>
          <span>主题</span>
          <select value={field} onChange={(event) => onFieldChange(event.target.value)}>
            <option value={DEFAULT_FIELD}>{DEFAULT_FIELD}</option>
            {fields.map((item) => <option key={item}>{item}</option>)}
          </select>
        </label>
        <label>
          <span>日程类型</span>
          <select
            value={direction}
            onChange={(event) => onDirectionChange(event.target.value)}
          >
            <option value={DEFAULT_DIRECTION}>{DEFAULT_DIRECTION}</option>
            {contentKinds.map((item) => <option key={item} value={item}>{item || '日程未提供'} · {reportKindCounts[item] ?? 0}</option>)}
          </select>
        </label>
        {hasFilters && <button className="clearFilters" onClick={onReset}>重置全部筛选</button>}
      </div>
    </section>
  );
}

function Pagination({
  page,
  totalPages,
  onChange,
}: {
  page: number;
  totalPages: number;
  onChange: (page: number) => void;
}) {
  const pages = Array.from({ length: totalPages }, (_, index) => index + 1)
    .filter((item) => item === 1 || item === totalPages || Math.abs(item - page) <= 1);

  return (
    <nav className="pagination" aria-label="报告分页">
      <button disabled={page === 1} onClick={() => onChange(page - 1)}>← 上一页</button>
      <div>
        {pages.map((item, index) => (
          <span key={item}>
            {index > 0 && item - pages[index - 1] > 1 && <i>…</i>}
            <button
              className={item === page ? 'current' : ''}
              onClick={() => onChange(item)}
              aria-current={item === page ? 'page' : undefined}
              aria-label={`第 ${item} 页`}
            >
              {item}
            </button>
          </span>
        ))}
      </div>
      <button disabled={page === totalPages} onClick={() => onChange(page + 1)}>下一页 →</button>
    </nav>
  );
}

function MySchedule({
  scheduledReports,
  attendedIds,
  celebratingReportId,
  unlockedPhraseCount,
  onOpen,
  onLocate,
  onCheckIn,
  onOpenAtlas,
  onRemove,
  onClear,
  onExportNotes,
  onExportSchedule,
  noteIds,
}: {
  scheduledReports: Report[];
  attendedIds: ReadonlySet<number>;
  celebratingReportId: number | null;
  unlockedPhraseCount: number;
  onOpen: (report: Report) => void;
  onLocate: (report?: Report) => void;
  onCheckIn: (report: Report) => void;
  onOpenAtlas: () => void;
  onRemove: (report: Report) => void;
  onClear: () => void;
  onExportNotes: () => void;
  onExportSchedule: () => void;
  noteIds: ReadonlySet<number>;
}) {
  const [scheduleView, setScheduleView] = useState<'calendar' | 'list'>('list');
  const conflicts = useMemo(() => scheduleConflicts(scheduledReports), [scheduledReports]);
  const groups = scheduledReports.reduce((result, report) => {
    const day = report.dateTime.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? '日期待确认';
    result.set(day, [...(result.get(day) ?? []), report]);
    return result;
  }, new Map<string, Report[]>());
  const { report: nextReport } = useNextScheduledReport(scheduledReports);
  const attendedCount = scheduledReports.reduce(
    (count, report) => count + Number(attendedIds.has(report.id)),
    0,
  );

  return (
    <section className="mySchedule" id="schedule" aria-labelledby="my-schedule-title">
      <div className="scheduleSummary">
        <span className="sectionNo">B.</span>
        <p>MY CUSTOM ITINERARY</p>
        <h2 id="my-schedule-title">我的自定义日程</h2>
        <p className="scheduleDescription desktopScheduleCopy">把想听的报告放进 9.11—9.13 三天会议日历。到场后点击“打卡”，日程颜色会同步点亮，并生成一张可保存的专属卡片。</p>
        <p className="scheduleDescription mobileScheduleCopy">到场后点击报告旁的“打卡”，点亮日程并保存你的神经病学年会现场卡片。</p>
        <dl>
          <div><dt>{scheduledReports.length}</dt><dd>场已加入</dd></div>
          <div><dt>{groups.size}</dt><dd>个会议日</dd></div>
          <div><dt>{attendedCount}</dt><dd>场已打卡</dd></div>
        </dl>
        <div className="scheduleActions" aria-label="我的日程操作">
          <button className="scheduleClearButton" type="button" disabled={!scheduledReports.length} onClick={onClear}>一键清空 <b>×</b></button>
          <button className="scheduleNotesExportButton" type="button" disabled={!scheduledReports.length} onClick={onExportNotes}>笔记批量导出 <b>PDF ↗</b></button>
          <button className="scheduleItineraryExportButton" type="button" disabled={!scheduledReports.length} onClick={onExportSchedule}>日程导出（表格 / 日历） <b>PDF ↗</b></button>
          <button className="calendarImportButton" type="button" disabled={!scheduledReports.some(report => reportInterval(report))} onClick={() => downloadCalendar(scheduledReports)}>导入系统日历 <b>ICS ↓</b></button>
          <button className="scheduleAtlasButton" type="button" onClick={onOpenAtlas}>打卡语图鉴 <b>{unlockedPhraseCount}/{CHECK_IN_PHRASES.length} ↗</b></button>
        </div>
      </div>
      <div className="scheduleCart">
        {conflicts.size > 0 && <details className="scheduleConflict"><summary>{conflicts.size} 场报告存在时间重叠，查看冲突</summary><p>这些报告的时间有交集，请根据会场和优先级取舍。</p>{scheduledReports.filter(report => conflicts.has(report.id)).map(report => <button key={report.id} onClick={() => onOpen(report)}>{report.dateTime.replace('2026-', '')} · {report.sourceTitle}</button>)}</details>}
        <header>
          <div>
            <span>MY SCHEDULE</span>
            <strong>{scheduleView === 'calendar' ? '三日听会日历' : '会议时间清单'}</strong>
          </div>
          <div className="scheduleCartTools">
            <b>{scheduleView === 'calendar' ? '9.11—9.13 · 内容自适应' : '已自动按会议时间排序'}</b>
            <div className="scheduleViewSwitch" role="group" aria-label="日程呈现方式">
              <button type="button" aria-pressed={scheduleView === 'calendar'} onClick={() => setScheduleView('calendar')}>日历视图</button>
              <button type="button" aria-pressed={scheduleView === 'list'} onClick={() => setScheduleView('list')}>清单视图</button>
              <button type="button" onClick={() => onLocate()} aria-haspopup="dialog">会场地图</button>
            </div>
          </div>
        </header>
        {scheduledReports.length === 0 ? (
          <div className="scheduleEmpty"><Link className="emptyScheduleLink" href="/learning#reports">去挑选报告 →</Link>
            <span aria-hidden>＋</span>
            <strong>日程里还没有报告</strong>
            <p className="desktopScheduleCopy">在报告看板点击“加入日程”，或将收藏批量加入。</p>
            <p className="mobileScheduleCopy">在报告列表点击“加入日程”，这里会自动生成你的三天听会日历。</p>
          </div>
        ) : scheduleView === 'calendar' ? (
          <CalendarSchedule
            reports={scheduledReports}
            onOpen={onOpen}
            onLocate={onLocate}
            onCheckIn={onCheckIn}
            attendedIds={attendedIds}
            celebratingReportId={celebratingReportId}
          />
        ) : (
          <div className="scheduleDays">
            {Array.from(groups).map(([day, dayReports]) => (
              <section className="scheduleDayGroup" key={day}>
                <header><time>{day === '日期待确认' ? day : day.replaceAll('-', '.')}</time><span>{dayReports.length} 场</span></header>
                <div>
                  {dayReports.map((report) => (
                    <article className={`scheduleItem ${report.id === nextReport?.id ? 'isNext' : ''} ${attendedIds.has(report.id) ? 'isAttended' : ''} ${celebratingReportId === report.id ? 'isCelebrating' : ''}`} key={report.id}>
                      <time>{report.dateTime.replace(`${day} `, '')}</time>
                      <button className="scheduleItemOpen" type="button" onClick={() => onOpen(report)}>
                        <small>{report.kind || '日程未提供'}{report.session ? ` · ${report.session}` : ''}</small>
                        <strong>{report.sourceTitle}</strong>
                        <span>{report.speaker} · {report.institution}</span>
                        <span className="scheduleItemVenue">{report.location}</span>
                      </button>
                      <div className="scheduleItemActions">
                        <button className="venueLocateButton" type="button" onClick={() => onLocate(report)} aria-label={`打开会场地图：${report.location}`} aria-haspopup="dialog">会场地图</button>
                        <button className="scheduleItemCheckIn" type="button" aria-pressed={attendedIds.has(report.id)} onClick={() => onCheckIn(report)}>{attendedIds.has(report.id) ? '✓ 已打卡' : '✦ 现场打卡'}</button>
                        <button className="scheduleItemNotes" type="button" onClick={() => requestNotebook(report.id, {section:'text',mode:'edit'})} aria-label={`写笔记：${report.sourceTitle}`}>{noteIds.has(report.id) ? '继续记录' : '记笔记'}</button>
                        <button className="scheduleItemNotes" type="button" onClick={() => requestNotebook(report.id, {section:'slides',mode:'edit',capture:true})} aria-label={`拍摄PPT：${report.sourceTitle}`}>拍 PPT</button>
                        <button className="scheduleItemRemove" type="button" onClick={() => onRemove(report)} aria-label={`从我的日程移除：${report.sourceTitle}`}>移除</button>
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

export default function Explorer({ initialPage = 'reports' }: { initialPage?: ActivePage }) {
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<'all' | 'favorites' | 'scheduled'>('all');
  const [sortOrder, setSortOrder] = useState<'relevance' | 'time'>('time');
  const deferredQuery = useDeferredValue(query);
  const [timeSlot, setTimeSlot] = useState(DEFAULT_TIME_SLOT);
  const [venue, setVenue] = useState(DEFAULT_VENUE);
  const [unitType, setUnitType] = useState(DEFAULT_UNIT_TYPE);
  const [field, setField] = useState(DEFAULT_FIELD);
  const [direction, setDirection] = useState(DEFAULT_DIRECTION);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Report | null>(null);
  const [noteOptions, setNoteOptions] = useState<NotebookOpenOptions>({});
  const [libraryEntries, setLibraryEntries] = useState<LibrarySummary[]>([]);
  const [storageWarning, setStorageWarning] = useState(false);
  useEffect(() => {
    const warn = () => setStorageWarning(true);
    window.addEventListener('neuro2026:storage-warning', warn);
    return () => window.removeEventListener('neuro2026:storage-warning', warn);
  }, []);
  const noteIds = useMemo(() => new Set(libraryEntries.map(entry => entry.reportId)), [libraryEntries]);
  const recordingActive = useRef(false);
  const selectionRef = useRef<Report | null>(null);
  const navigationRequest = useRef(0);
  useEffect(() => { selectionRef.current = selected; }, [selected]);
  const [mapReport, setMapReport] = useState<Report | null | undefined>(undefined);
  const [exportRequest, setExportRequest] = useState<ExportRequest | null>(null);
  const {
    favoriteSet,
    favoriteReports,
    toggleFavorite,
    setReportsFavorite,
    clearFavorites,
  } = useFavorites();
  const {
    scheduleSet,
    scheduledReports,
    addReports: addScheduleReports,
    removeReport: removeScheduledReport,
    clearSchedule,
  } = useCustomSchedule();
  const { records, attendedIds, markAttended } = useAttendance();
  const [checkInCard, setCheckInCard] = useState<{
    report: Report;
    record: CheckInRecord;
    isFresh: boolean;
  } | null>(null);
  const [checkInAtlasOpen, setCheckInAtlasOpen] = useState(false);
  const [celebratingReportId, setCelebratingReportId] = useState<number | null>(null);
  const checkInAnimationTimerRef = useRef<number | null>(null);
  const [scheduleUploadFeedback, setScheduleUploadFeedback] = useState('');
  const scheduleUploadTimerRef = useRef<number | null>(null);
  const unlockedPhraseCount = useMemo(
    () => new Set(Object.values(records)
      .map((record) => record.phrase)
      .filter((phrase) => CHECK_IN_PHRASES.includes(phrase))).size,
    [records],
  );

  useEffect(() => () => {
    if (scheduleUploadTimerRef.current !== null) window.clearTimeout(scheduleUploadTimerRef.current);
    if (checkInAnimationTimerRef.current !== null) window.clearTimeout(checkInAnimationTimerRef.current);
  }, []);

  const uploadFavoritesToSchedule = useCallback(() => {
    const addedCount = favoriteReports.reduce(
      (count, report) => count + Number(!scheduleSet.has(report.id)),
      0,
    );
    addScheduleReports(favoriteReports);
    setScheduleUploadFeedback(addedCount ? `已加入 ${addedCount} 场` : '都在日程中');
    if (scheduleUploadTimerRef.current !== null) window.clearTimeout(scheduleUploadTimerRef.current);
    scheduleUploadTimerRef.current = window.setTimeout(() => {
      setScheduleUploadFeedback('');
      scheduleUploadTimerRef.current = null;
    }, 2400);
  }, [addScheduleReports, favoriteReports, scheduleSet]);

  const toggleScheduledReport = useCallback((report: Report) => {
    if (scheduleSet.has(report.id)) removeScheduledReport(report);
    else addScheduleReports([report]);
  }, [addScheduleReports, removeScheduledReport, scheduleSet]);

  const openCheckInCard = useCallback((report: Report) => {
    const result = markAttended(report);
    setCheckInCard({ report, ...result });
    if (!result.isFresh) return;
    setCelebratingReportId(report.id);
    if (checkInAnimationTimerRef.current !== null) {
      window.clearTimeout(checkInAnimationTimerRef.current);
    }
    checkInAnimationTimerRef.current = window.setTimeout(() => {
      setCelebratingReportId(null);
      checkInAnimationTimerRef.current = null;
    }, 1400);
  }, [markAttended]);

  const clearCustomSchedule = useCallback(() => {
    if (!scheduledReports.length) return;
    if (!window.confirm(`确定清空我的日程中的 ${scheduledReports.length} 场报告吗？`)) return;
    clearSchedule();
  }, [clearSchedule, scheduledReports.length]);

  const filtered = useMemo(() => {
    if (initialPage !== 'reports') return [];
    const ranked: { report: Report; score: number }[] = [];
    const hasQuery = Boolean(deferredQuery.trim());

    for (const report of reports) {
      if (scope === 'favorites' && !favoriteSet.has(report.id)) continue;
      if (scope === 'scheduled' && !scheduleSet.has(report.id)) continue;
      if (timeSlot !== DEFAULT_TIME_SLOT && TIME_SLOT_BY_REPORT_ID.get(report.id) !== timeSlot) continue;
      if (venue !== DEFAULT_VENUE && report.location !== venue) continue;
      if (unitType !== DEFAULT_UNIT_TYPE && !UNIT_TYPES_BY_REPORT_ID.get(report.id)?.includes(unitType as (typeof UNIT_TYPES)[number])) continue;
      if (field !== DEFAULT_FIELD && report.field !== field) continue;
      if (direction !== DEFAULT_DIRECTION && report.kind !== direction) continue;
      const score = hasQuery ? searchScore(report, deferredQuery) : 1;
      if (score > 0) ranked.push({ report, score });
    }

    ranked.sort((a, b) => hasQuery ? b.score - a.score || a.report.sourceRow - b.report.sourceRow : a.report.sourceRow - b.report.sourceRow);
    const result = ranked.map(({ report }) => report);
    return sortOrder === 'time' ? sortReportsByDateTime(result) : result;
  }, [initialPage, deferredQuery, timeSlot, venue, unitType, field, direction, scope, sortOrder, favoriteSet, scheduleSet]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const visible = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const latestFavorite = favoriteReports.at(-1);
  const updating = query !== deferredQuery;
  const visibleFavoriteCount = visible.reduce(
    (count, report) => count + Number(favoriteSet.has(report.id)),
    0,
  );
  const allVisibleFavorited = visible.length > 0 && visibleFavoriteCount === visible.length;

  const resetFilters = useCallback(() => {
    setQuery('');
    setScope('all');
    setTimeSlot(DEFAULT_TIME_SLOT);
    setVenue(DEFAULT_VENUE);
    setUnitType(DEFAULT_UNIT_TYPE);
    setField(DEFAULT_FIELD);
    setDirection(DEFAULT_DIRECTION);
    setPage(1);
  }, []);

  const changePage = useCallback((nextPage: number) => {
    setPage(Math.min(Math.max(nextPage, 1), totalPages));
    requestAnimationFrame(() => {
      document.getElementById('reports')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }, [totalPages]);

  const mayLeaveNotebook = useCallback(() => {
    if (!recordingActive.current) return true;
    window.alert('录音正在进行或保存中，请先在笔记中停止并保存录音，再离开本场报告。');
    return false;
  }, []);

  const flushNotebook = useCallback(async () => {
    if (!mayLeaveNotebook()) return false;
    const promises: Promise<unknown>[] = [];
    window.dispatchEvent(new CustomEvent('neuro2026:flush-notebook', { detail: { promises } }));
    try { await Promise.all(promises); return true; }
    catch (error) {
      window.alert(error instanceof Error ? `资料尚未全部保存：${error.message}` : '资料尚未全部保存，请保留当前页面并重试。');
      return false;
    }
  }, [mayLeaveNotebook]);

  const openReport = useCallback(async (report: Report, options: NotebookOpenOptions = {}) => {
    const request = ++navigationRequest.current;
    if (selectionRef.current && selectionRef.current.id !== report.id && !await flushNotebook()) return;
    if (request !== navigationRequest.current) return;
    setNoteOptions(options);
    setSelected(report);
    const nextHash = notebookHash(report.id, options);
    if (location.hash !== nextHash) history.pushState({ ...history.state, reportId: report.id }, '', nextHash);
  }, [flushNotebook]);

  const closeReport = useCallback(async () => {
    const request = ++navigationRequest.current;
    if (!await flushNotebook() || request !== navigationRequest.current) return;
    setSelected(null);
    if (location.hash.startsWith('#neuro2026-report-')) {
      history.replaceState(history.state, '', location.pathname + location.search);
    }
  }, [flushNotebook]);

  const openVenueMap = useCallback((report?: Report) => {
    setMapReport(report ?? null);
    const url = new URL(location.href);
    url.searchParams.set('neuro2026VenueReport', report ? String(report.id) : 'overview');
    history.pushState({ ...history.state, neuro2026Venue: true }, '', url.pathname + url.search + url.hash);
  }, []);

  const closeVenueMap = useCallback(() => {
    setMapReport(undefined);
    if (history.state?.neuro2026Venue) {
      history.back();
    } else {
      const url = new URL(location.href);
      url.searchParams.delete('neuro2026VenueReport');
      history.replaceState(history.state, '', url.pathname + url.search + url.hash);
    }
  }, []);


  useEffect(() => {
    let cancelled = false;
    const loadLibrary = () => {
      void readLibrarySummaries().then(entries => { if (!cancelled) setLibraryEntries(entries); })
        .catch(() => { /* Library page provides explicit recovery UI; navigation remains usable. */ });
    };
    const libraryChanged = (event: Event) => {
      if ((event as CustomEvent).detail?.kind !== 'reading') loadLibrary();
    };
    const notebookRequested = (event: Event) => {
      const detail = (event as CustomEvent<{reportId:number;options:NotebookOpenOptions}>).detail;
      const report = REPORT_BY_ID.get(detail?.reportId);
      if (report) openReport(report, detail.options);
    };
    const recordingChanged = (event: Event) => { recordingActive.current = !!(event as CustomEvent).detail?.active; };
    let replayingNavigation = false;
    const guardNavigation = (event: MouseEvent) => {
      const anchor = (event.target as Element)?.closest?.<HTMLAnchorElement>('a[href]');
      if (!anchor || replayingNavigation || !selectionRef.current || anchor.target === '_blank' || anchor.hasAttribute('download')) return;
      const href = anchor.getAttribute('href') || '';
      if (href.startsWith('#neuro2026-slide=')) return;
      event.preventDefault(); event.stopPropagation();
      void flushNotebook().then(saved => {
        if (!saved || cancelled) return;
        replayingNavigation = true;
        try { anchor.click(); } finally { replayingNavigation = false; }
      });
    };
    loadLibrary();
    window.addEventListener(LIBRARY_CHANGE_EVENT, libraryChanged);
    window.addEventListener(NOTEBOOK_OPEN_EVENT, notebookRequested);
    window.addEventListener('neuro2026:recording-state', recordingChanged);
    document.addEventListener('click', guardNavigation, true);
    return () => {
      cancelled = true;
      window.removeEventListener(LIBRARY_CHANGE_EVENT, libraryChanged);
      window.removeEventListener(NOTEBOOK_OPEN_EVENT, notebookRequested);
      window.removeEventListener('neuro2026:recording-state', recordingChanged);
      document.removeEventListener('click', guardNavigation, true);
    };
  }, [openReport, flushNotebook]);

  useEffect(() => {
    const syncSelectionFromHash = async () => {
      const hash = location.hash;
      const id = Number(hash.match(/^#neuro2026-report-(\d+)(?:\?|$)/)?.[1]);
      if (selectionRef.current && id !== selectionRef.current.id && !await flushNotebook()) {
        history.pushState(history.state, '', notebookHash(selectionRef.current.id));
        return;
      }
      if (hash !== location.hash) return;
      setNoteOptions(notebookOptions(location.hash));
      setSelected(id ? REPORT_BY_ID.get(id) ?? null : null);
      const venueReport = new URLSearchParams(location.search).get('neuro2026VenueReport');
      setMapReport(venueReport === 'overview' ? null : venueReport ? REPORT_BY_ID.get(Number(venueReport)) : undefined);
    };
    queueMicrotask(syncSelectionFromHash);
    window.addEventListener('popstate', syncSelectionFromHash);
    window.addEventListener('hashchange', syncSelectionFromHash);
    return () => {
      window.removeEventListener('popstate', syncSelectionFromHash);
      window.removeEventListener('hashchange', syncSelectionFromHash);
    };
  }, [flushNotebook]);

  return (
    <main className={initialPage === 'schedule' ? 'schedulePage' : initialPage === 'library' ? 'libraryPage' : 'reportsPage'}>
      <SiteHeader activePage={initialPage} />
      {storageWarning && <div className="storageWarning" role="alert"><span>浏览器未能保存这次更改，请保留当前页面并及时导出。</span><button type="button" onClick={() => setStorageWarning(false)} aria-label="关闭保存提示">×</button></div>}
      {initialPage === 'reports' && <>
      {favoriteReports.length > 0 && (
        <aside className="dynamicIsland" aria-live="polite">
          <div className="islandPulse"><span aria-hidden>★</span></div>
          <div className="islandLatest">
            <small>最新收藏</small>
            <strong>{latestFavorite?.speaker}</strong>
          </div>
          <div className="islandCount"><b>{favoriteReports.length}</b><span>场已收藏</span></div>
          <button className="islandUploadButton" data-status={scheduleUploadFeedback ? 'confirmed' : 'idle'} onClick={uploadFavoritesToSchedule} aria-label="上传收藏到我的日程">{scheduleUploadFeedback || '上传日程'} <b>{scheduleUploadFeedback ? '✓' : '＋'}</b></button>
          <button className="islandExportButton" onClick={() => setExportRequest({reports:[...favoriteReports],clearFavoritesAfterExport:false})}>导出 <b>↗</b></button>
        </aside>
      )}

      <Hero entries={libraryEntries} />

      <SearchPanel
        query={query}
        timeSlot={timeSlot}
        venue={venue}
        unitType={unitType}
        field={field}
        direction={direction}
        resultCount={filtered.length}
        updating={updating}
        onQueryChange={(value) => { setQuery(value); setPage(1); }}
        onTimeSlotChange={(value) => { setTimeSlot(value); setPage(1); }}
        onVenueChange={(value) => { setVenue(value); setPage(1); }}
        onUnitTypeChange={(value) => { setUnitType(value); setPage(1); }}
        onFieldChange={(value) => { setField(value); setPage(1); }}
        onDirectionChange={(value) => { setDirection(value); setPage(1); }}
        onReset={resetFilters}
      />

      <div className="collectionToolbar">
        <div role="group" aria-label="会议内容范围">{([{id:'all',label:'全部内容',count:reports.length},{id:'favorites',label:'我的收藏',count:favoriteReports.length},{id:'scheduled',label:'已排日程',count:scheduledReports.length}] as const).map(item => <button key={item.id} aria-pressed={scope === item.id} onClick={() => { setScope(item.id); setPage(1); }}>{item.label}<b>{item.count}</b></button>)}</div>
        <label className="sortSelect">排序<select aria-label="报告排序" value={sortOrder} onChange={event => { setSortOrder(event.target.value as 'relevance' | 'time'); setPage(1); }}><option value="relevance">相关优先</option><option value="time">会议时间</option></select></label>
        {scope === 'favorites' && favoriteReports.length > 0 && <div className="collectionActions"><button onClick={uploadFavoritesToSchedule}>全部加入日程</button><button onClick={() => setExportRequest({reports:[...favoriteReports],clearFavoritesAfterExport:false})}>导出收藏</button></div>}
      </div>
      <section className="fieldRail" aria-label="日程类型快捷筛选">
        <span>日程类型</span>
        <button className={direction === DEFAULT_DIRECTION ? 'selected' : ''} aria-pressed={direction === DEFAULT_DIRECTION} onClick={() => { setDirection(DEFAULT_DIRECTION); setPage(1); }}>全部类型<b>{reports.length}</b></button>
        {contentKinds.map((kind) => (
          <button
            className={direction === kind ? 'selected' : ''}
            key={kind}
            onClick={() => {
              setDirection(direction === kind ? DEFAULT_DIRECTION : kind);
              setPage(1);
            }}
            aria-pressed={direction === kind}
          >
            {kind || '日程未提供'}<b>{reportKindCounts[kind]}</b>
          </button>
        ))}
      </section>

      <section className="reportSection" id="reports" aria-busy={updating}>
        <div className="sectionHeading">
          <div><span className="sectionNo">A.</span><h2>会议内容看板</h2></div>
          <div className="sectionHeadingActions">
            <p>第 {currentPage} / {totalPages} 页 · 每页 {PAGE_SIZE} 场</p>
            {visible.length > 0 && (
              <button
                className={`favoritePageButton ${allVisibleFavorited ? 'isComplete' : ''}`}
                onClick={() => setReportsFavorite(visible, !allVisibleFavorited)}
                aria-pressed={allVisibleFavorited}
              >
                <span aria-hidden>{allVisibleFavorited ? '★' : '☆'}</span>
                {allVisibleFavorited
                  ? `取消本页收藏`
                  : `收藏本页 ${visible.length} 场`}
              </button>
            )}
          </div>
        </div>
        {visible.length ? (
          <div className="cardGrid">
            {visible.map((report, index) => (
              <ReportCard
                key={report.id}
                report={report}
                order={index}
                onOpen={openReport}
                favorite={favoriteSet.has(report.id)}
                onToggleFavorite={toggleFavorite}
                scheduled={scheduleSet.has(report.id)}
                onToggleSchedule={toggleScheduledReport}
              />
            ))}
          </div>
        ) : (
          <div className="emptyState">
            <b>没有找到完全匹配的会议内容</b>
            <p>可以缩短关键词，或尝试主题、小节、报告人、主持人和单位名称。</p>
            <button onClick={resetFilters}>查看全部内容</button>
          </div>
        )}
        {totalPages > 1 && (
          <Pagination page={currentPage} totalPages={totalPages} onChange={changePage} />
        )}
      </section>
      </>}

      {initialPage === 'library' && <Suspense fallback={<p className="moduleLoading" role="status">正在打开个人图书馆…</p>}><PersonalLibrary onOpen={openReport} /></Suspense>}
      {initialPage === 'schedule' && (
        <MySchedule
          scheduledReports={scheduledReports}
          attendedIds={attendedIds}
          celebratingReportId={celebratingReportId}
          unlockedPhraseCount={unlockedPhraseCount}
          onCheckIn={openCheckInCard}
          onOpenAtlas={() => setCheckInAtlasOpen(true)}
          onOpen={openReport}
          onLocate={openVenueMap}
          onRemove={removeScheduledReport}
          onClear={clearCustomSchedule}
          onExportNotes={() => setExportRequest({reports:[...scheduledReports],initialMode:'notes',clearFavoritesAfterExport:false})}
          onExportSchedule={() => setExportRequest({reports:[...scheduledReports],initialMode:'schedule',clearFavoritesAfterExport:false})}
          noteIds={noteIds}
        />
      )}
      <footer className="siteFooter">
        <BrandLockup />
        <p>本工具用于会议日程管理与听会记录，不构成医疗建议。题目、人员、时间与会场仅取自《2026神经病学年会日程.xlsx》原始日程表；原表未提供的信息明确标注，不作推断。</p>
        <Link href={initialPage === 'reports' ? '#top' : '/learning#reports'}>{initialPage === 'reports' ? '回到顶部 ↑' : '返回报告看板 ←'}</Link>
      </footer>
      {initialPage === 'schedule' && <MobileActionHub scheduledReports={scheduledReports} onOpen={openReport} onLocate={openVenueMap} />}
      <MobileBottomNav activePage={initialPage} scheduleCount={scheduledReports.length} />

      {selected && (
        <DetailView
          key={selected.id}
          report={selected}
          onLocate={openVenueMap}
          onClose={closeReport}
          favorite={favoriteSet.has(selected.id)}
          onToggleFavorite={toggleFavorite}
          scheduled={scheduleSet.has(selected.id)}
          onToggleSchedule={toggleScheduledReport}
          options={noteOptions}
          returnLabel={initialPage === 'library' ? '返回图书馆' : initialPage === 'schedule' ? '返回日程' : '返回报告看板'}
        />
      )}
      {mapReport !== undefined && <MapPlaceholder location={mapReport?.location} onClose={closeVenueMap} />}
      <Suspense fallback={<div className="moduleLoading moduleLoadingFixed" role="status">正在准备工具…</div>}>
      {exportRequest && (
        <ExportCenter
          reports={exportRequest.reports}
          initialMode={exportRequest.initialMode}
          clearAfterExport={exportRequest.clearFavoritesAfterExport}
          onClose={() => setExportRequest(null)}
          onExported={exportRequest.clearFavoritesAfterExport ? clearFavorites : undefined}
        />
      )}
      {checkInCard && <CheckInCard
        key={`${checkInCard.report.id}-${checkInCard.record.checkedAt}`}
        location={checkInCard.report.location}
        record={checkInCard.record}
        isFresh={checkInCard.isFresh}
        onClose={() => setCheckInCard(null)}
      />}
      {checkInAtlasOpen && <CheckInAtlas records={Object.values(records)} onClose={() => setCheckInAtlasOpen(false)} />}
      </Suspense>
    </main>
  );
}
