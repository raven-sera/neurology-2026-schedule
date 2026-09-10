'use client';

import { useMemo, useRef, useState } from 'react';
import { CONFERENCE_DAYS, reports, sortReportsByDateTime, type Report } from '../lib/reports';
import { nextScheduledReport, scheduleConflicts } from '../lib/scheduleTools';
import { useDialog } from '../lib/useDialog';
import { MAP_FLOORS, MAP_REGIONS, REGION_BY_ID, VENUES, VENUE_BY_LOCATION, type Floor, type VenueLocation } from '../lib/venueLocations';
import VenueMap from './VenueMap';
import './venue-navigator.css';

const PAGE_SIZE = 12;
const EMPTY_REPORTS: readonly Report[] = [];
const reportsByLocation = new Map<string, Map<string, Report[]>>();
for (const report of sortReportsByDateTime(reports)) {
  let days = reportsByLocation.get(report.location);
  if (!days) { days = new Map(); reportsByLocation.set(report.location, days); }
  const date = report.dateTime.slice(0, 10);
  const dayReports = days.get(date);
  if (dayReports) dayReports.push(report);
  else days.set(date, [report]);
}
const venueReports = (venue: VenueLocation, date: string): readonly Report[] => reportsByLocation.get(venue.sourceLocation)?.get(date) ?? EMPTY_REPORTS;
const normalizeSearch = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[\s·（）()]/g, '');
const statusLabel = (venue: VenueLocation) => venue.status === 'unresolved' ? '位置待核对' : venue.status === 'area' ? '编号区域示意 · 分区待核' : '楼层 / 编号一致 · 示意点';

type MobilePanel = 'map' | 'venues' | 'schedule';
type VenueNavigatorProps = {
  initialReport?: Report | null;
  scheduledReports: Report[];
  onToggleSchedule: (report: Report) => void;
  onOpenReport: (report: Report) => Promise<boolean>;
  onClose: () => void;
};

export default function VenueNavigator({ initialReport, scheduledReports, onToggleSchedule, onOpenReport, onClose }: VenueNavigatorProps) {
  const [initial] = useState(() => {
    const report = initialReport ?? nextScheduledReport(scheduledReports, Date.now()) ?? scheduledReports[0];
    const venue = report ? VENUE_BY_LOCATION[report.location] : undefined;
    return { venue, date: report?.dateTime.slice(0, 10) ?? CONFERENCE_DAYS[0].date };
  });
  const [floor, setFloor] = useState<Floor>(initial.venue?.floor ?? 1);
  const [date, setDate] = useState(initial.date);
  const [venueId, setVenueId] = useState<string | null>(initial.venue?.id ?? null);
  const [regionId, setRegionId] = useState<string | null>(initial.venue?.regionId ?? null);
  const [query, setQuery] = useState('');
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>('map');
  const [scheduleMode, setScheduleMode] = useState<'venue' | 'mine'>('venue');
  const [page, setPage] = useState(1);
  const [openingId, setOpeningId] = useState<number | null>(null);
  const [openError, setOpenError] = useState('');
  const opening = useRef(false);
  const mapHeading = useRef<HTMLHeadingElement>(null);
  const scheduleHeading = useRef<HTMLHeadingElement>(null);
  useDialog('.venueNavigatorOverlay', onClose);

  const selectedVenue = VENUES.find(venue => venue.id === venueId);
  const selectedRegion = regionId ? REGION_BY_ID[regionId] : undefined;
  const regionVenues = useMemo(() => regionId ? VENUES.filter(venue => venue.regionId === regionId) : [], [regionId]);
  const daySchedule = useMemo(() => sortReportsByDateTime(scheduledReports.filter(report => report.dateTime.startsWith(date))), [scheduledReports, date]);
  const scheduledIds = useMemo(() => new Set(scheduledReports.map(report => report.id)), [scheduledReports]);
  const conflicts = useMemo(() => scheduleConflicts(daySchedule), [daySchedule]);
  const scheduledById = useMemo(() => new Map(daySchedule.map(report => [report.id, report])), [daySchedule]);
  const normalizedQuery = normalizeSearch(query);
  const visibleVenues = VENUES.filter(venue => normalizedQuery ? normalizeSearch(venue.sourceLocation + venue.label).includes(normalizedQuery) : venue.floor === floor);
  const visibleRegions = MAP_REGIONS.filter(region => normalizedQuery ? normalizeSearch(region.label).includes(normalizedQuery) : region.floor === floor);
  const selectedReports = useMemo(() => {
    if (selectedVenue) return venueReports(selectedVenue, date);
    // A shared image region never silently merges A/B schedules.
    if (selectedRegion) return EMPTY_REPORTS;
    return sortReportsByDateTime(VENUES.filter(venue => venue.floor === floor).flatMap(venue => venueReports(venue, date)));
  }, [selectedVenue, selectedRegion, floor, date]);
  const displayedReports = scheduleMode === 'mine' ? daySchedule : selectedReports;
  const pageCount = Math.max(1, Math.ceil(displayedReports.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pagedReports = displayedReports.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const floorLabel = MAP_FLOORS.find(item => item.id === floor)!.label;
  const scheduleTitle = scheduleMode === 'mine' ? '我的当天日程' : selectedVenue?.label ?? selectedRegion?.label ?? `${floorLabel}全部会场`;

  function showPanel(panel: 'map' | 'schedule') {
    setMobilePanel(panel);
    requestAnimationFrame(() => (panel === 'map' ? mapHeading : scheduleHeading).current?.focus({ preventScroll: true }));
  }

  function selectVenue(venue: VenueLocation, keepScheduleMode = false) {
    setFloor(venue.floor);
    setVenueId(venue.id);
    setRegionId(venue.regionId);
    if (!keepScheduleMode) setScheduleMode('venue');
    setPage(1);
    showPanel('map');
  }

  function selectRegion(id: string) {
    const region = REGION_BY_ID[id];
    if (!region) return;
    const matches = VENUES.filter(venue => venue.regionId === id);
    setFloor(region.floor);
    setRegionId(id);
    setVenueId(matches.length === 1 ? matches[0].id : null);
    setScheduleMode('venue');
    setPage(1);
    showPanel('map');
  }

  function selectFloor(nextFloor: Floor) {
    setFloor(nextFloor);
    setVenueId(null);
    setRegionId(null);
    setPage(1);
  }

  function selectDate(nextDate: string) {
    setDate(nextDate);
    setPage(1);
  }

  async function openReport(report: Report) {
    if (opening.current) return;
    opening.current = true;
    setOpeningId(report.id);
    setOpenError('');
    try {
      const opened = await onOpenReport(report);
      if (!opened) setOpenError('尚未打开报告：请先处理原笔记的保存提示，地图已保留，可重试。');
    } catch {
      setOpenError('打开报告未成功，地图已保留。请检查笔记保存状态后重试。');
    } finally {
      opening.current = false;
      setOpeningId(null);
    }
  }

  function renderVenueChoice(venue: VenueLocation) {
    return <button type="button" className="venueNavigatorVenueChoice" key={venue.id} aria-pressed={selectedVenue?.id === venue.id} aria-label={`定位会场：${venue.sourceLocation}`} onClick={() => selectVenue(venue)}>
      <strong>{venue.label}</strong>
      <span>{MAP_FLOORS.find(item => item.id === venue.floor)!.label} · 当天 {venueReports(venue, date).length} 场</span>
      <small className={venue.status === 'unresolved' ? 'venueNavigatorUnresolvedText' : ''}>{statusLabel(venue)}</small>
    </button>;
  }

  return <div className="venueNavigatorOverlay" role="dialog" aria-modal="true" aria-labelledby="venueNavigatorTitle" aria-describedby="venueNavigatorCaution">
    <section className="venueNavigatorDialog">
      <header className="venueNavigatorHeader">
        <div><p>CMANCN 2026 · 会场地图</p><h1 id="venueNavigatorTitle">西安国际会议中心</h1></div>
        <button className="venueNavigatorClose" type="button" onClick={onClose} aria-label="关闭会场地图">关闭 <span aria-hidden="true">×</span></button>
      </header>
      <div className="venueNavigatorControls">
        <div className="venueNavigatorButtonGroup" role="group" aria-label="地图楼层">
          {MAP_FLOORS.map(item => <button type="button" key={item.id} aria-pressed={floor === item.id} aria-label={`切换至${item.label}地图`} onClick={() => selectFloor(item.id)}>{item.id}F <span>{item.label}</span></button>)}
        </div>
        <div className="venueNavigatorButtonGroup" role="group" aria-label="日程日期">
          {CONFERENCE_DAYS.map(day => <button type="button" key={day.date} aria-pressed={date === day.date} aria-label={`查看${day.date}日程`} onClick={() => selectDate(day.date)}>{day.monthDay} <span>{day.weekday}</span></button>)}
        </div>
      </div>
      <details className="venueNavigatorCaution" id="venueNavigatorCaution">
        <summary>图纸与本届日程有差异：3 个厅位置待核，A/B 未分隔，请以现场通知为准</summary>
        <p>原图保留其原有会场、服务区及活动标注，不一定是 CMANCN 2026 的实际配置。编号标记仅为区域示意，不代表门位、步行路线或实时位置；A/B 共用父区域，不推测左右分区。</p>
        <ul>{VENUES.filter(venue => venue.status === 'unresolved').map(venue => <li key={venue.id}><button type="button" onClick={() => selectVenue(venue)} aria-label={`查看待核会场：${venue.sourceLocation}`}>{venue.sourceLocation}</button><span>{venue.note}</span></li>)}</ul>
      </details>
      <nav className="venueNavigatorMobileTabs" aria-label="地图内容切换">
        <button type="button" aria-pressed={mobilePanel === 'map'} aria-controls="venueNavigatorMapPanel" onClick={() => setMobilePanel('map')}>地图定位</button>
        <button type="button" aria-pressed={mobilePanel === 'venues'} aria-controls="venueNavigatorVenuesPanel" onClick={() => setMobilePanel('venues')}>搜索会场</button>
        <button type="button" aria-pressed={mobilePanel === 'schedule'} aria-controls="venueNavigatorSchedulePanel" onClick={() => setMobilePanel('schedule')}>当日日程</button>
      </nav>
      <div className="venueNavigatorBody" data-mobile-panel={mobilePanel}>
        <aside className="venueNavigatorVenuesPanel" id="venueNavigatorVenuesPanel" aria-labelledby="venueNavigatorVenuesTitle">
          <h2 id="venueNavigatorVenuesTitle">会场索引</h2>
          <label className="venueNavigatorSearch" htmlFor="venueNavigatorSearch">跨楼层搜索会场<input id="venueNavigatorSearch" type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="如 201A、主会场、第七分会场" autoComplete="off" /></label>
          <div className="venueNavigatorSearchMeta"><span>{normalizedQuery ? '全部楼层' : floorLabel} · {visibleVenues.length} 个日程会场</span>{query && <button type="button" onClick={() => setQuery('')} aria-label="清空会场搜索">清空</button>}</div>
          <div className="venueNavigatorVenueList">{visibleVenues.map(renderVenueChoice)}</div>
          {!visibleVenues.length && <p className="venueNavigatorEmpty">没有匹配的日程会场。试试房间编号或分会场名称。</p>}
          <h3>原图区域 / 服务设施</h3>
          <p className="venueNavigatorHint">原图用途不代表本届安排；点击可查看说明。</p>
          <div className="venueNavigatorRegionList">{visibleRegions.map(region => <button type="button" key={region.id} onClick={() => selectRegion(region.id)} aria-pressed={regionId === region.id} aria-label={`查看原图区域：${region.floor}层${region.label}`}>{region.floor}F · {region.label}</button>)}</div>
          {!visibleRegions.length && <p className="venueNavigatorEmpty">没有匹配的原图区域。</p>}
        </aside>
        <section className="venueNavigatorMapPanel" id="venueNavigatorMapPanel" aria-labelledby="venueNavigatorMapTitle">
          <div className="venueNavigatorPanelHeading"><h2 id="venueNavigatorMapTitle" ref={mapHeading} tabIndex={-1}>{floorLabel}原图</h2><span>区域示意 · 非路线导航</span></div>
          <div className="venueNavigatorMapFrame"><VenueMap floor={floor} selectedRegionId={regionId} onSelectRegion={selectRegion} /></div>
          <div className={`venueNavigatorSelection${selectedVenue?.status === 'unresolved' ? ' venueNavigatorSelectionUnresolved' : ''}`} aria-live="polite">
            {selectedVenue ? <>
              <span className="venueNavigatorStatus">{statusLabel(selectedVenue)}</span>
              <h3>{selectedVenue.label}</h3><p className="venueNavigatorSource">日程原始会场：{selectedVenue.sourceLocation}</p><p>{selectedVenue.note}</p>
              {selectedRegion && <p>对应原图：{selectedRegion.label}。{selectedRegion.note}</p>}
              {selectedVenue.status === 'unresolved' && <strong>仅按日程切换楼层，地图不放置定位点，不替换为其他同名厅。</strong>}
              <p>{date} · 本会场 {selectedReports.length} 场，仅匹配此具体会场。</p>
            </> : selectedRegion ? <>
              <span className="venueNavigatorStatus">{selectedRegion.kind === 'room' ? '原图编号区域示意' : '原图用途标注'}</span>
              <h3>{selectedRegion.label}</h3><p>{selectedRegion.note}</p>
              {regionVenues.length > 1 ? <><p><strong>本区域关联 {regionVenues.length} 个具体会场，请先选择，A/B 日程不合并。</strong></p><div className="venueNavigatorVenueList">{regionVenues.map(renderVenueChoice)}</div></> : <p>此原图区域没有已确认关联的本届报告会场，不生成或借用其他厅的日程。</p>}
            </> : <><span className="venueNavigatorStatus">{floorLabel}总览</span><h3>从原图或会场索引选择位置</h3><p>编号会场定位到原图对应区域。查找具体 A/B 会场请使用会场索引；位置待核厅仍可查看完整日程。</p></>}
          </div>
          <button type="button" className="venueNavigatorPrimary venueNavigatorReturn" onClick={() => showPanel('schedule')}>返回当日日程{scheduleMode === 'mine' ? ` · 我的 ${daySchedule.length} 场` : selectedVenue ? ` · ${selectedReports.length} 场` : ''}</button>
        </section>
        <section className="venueNavigatorSchedulePanel" id="venueNavigatorSchedulePanel" aria-labelledby="venueNavigatorScheduleTitle">
          <div className="venueNavigatorButtonGroup venueNavigatorScheduleModes" role="group" aria-label="日程列表范围">
            <button type="button" aria-pressed={scheduleMode === 'venue'} onClick={() => { setScheduleMode('venue'); setPage(1); }}>会场日程</button>
            <button type="button" aria-pressed={scheduleMode === 'mine'} onClick={() => { setScheduleMode('mine'); setPage(1); }}>我的当天日程 ({daySchedule.length})</button>
          </div>
          <h2 id="venueNavigatorScheduleTitle" ref={scheduleHeading} tabIndex={-1}>{scheduleTitle}</h2>
          <p className="venueNavigatorHint">{date} · {displayedReports.length} 场{scheduleMode === 'venue' && !selectedVenue && !selectedRegion ? ' · 本层多个会场，逐条标注实际地点' : ''}{scheduleMode === 'mine' ? ' · 跨楼层，与你的个人日程同步' : ''}</p>
          {conflicts.size > 0 && <p className="venueNavigatorConflictSummary" role="status">我的当天日程有 {conflicts.size} 场报告时间重叠{scheduleMode === 'mine' ? '，冲突对象列于相应报告下。' : '。'}{scheduleMode !== 'mine' && <button type="button" onClick={() => { setScheduleMode('mine'); setPage(1); }}>查看我的时间冲突</button>}</p>}
          {openError && <p className="venueNavigatorError" role="alert">{openError}</p>}
          {scheduleMode === 'venue' && !selectedVenue && regionVenues.length > 1 && <div className="venueNavigatorVenueList"><p className="venueNavigatorHint">先选具体会场，再查看当天日程：</p>{regionVenues.map(renderVenueChoice)}</div>}
          {!displayedReports.length && <p className="venueNavigatorEmpty">{scheduleMode === 'mine' ? '这一天还没有个人日程。切换至会场日程，可添加感兴趣的报告。' : !selectedVenue && selectedRegion ? regionVenues.length > 1 ? '尚未选择具体会场，不混合展示分区日程。' : '此原图区域没有已确认关联的本届报告日程，请参考区域用途说明。' : '此日期没有该会场范围的报告，仍可查看地图，或切换其他日期。'}</p>}
          <div className="venueNavigatorReportList">{pagedReports.map(report => {
            const scheduled = scheduledIds.has(report.id);
            const conflictIds = conflicts.get(report.id) ?? [];
            const reportVenue = VENUE_BY_LOCATION[report.location];
            return <article key={report.id} className="venueNavigatorReport" data-report-id={report.id}>
              <p className="venueNavigatorReportTime">{report.dateTime.slice(10).trim()} <span>{report.kind}</span></p>
              <h3>{report.sourceTitle}</h3><p>{report.speaker || '日程未提供讲者'}{report.institution ? ` · ${report.institution}` : ''}</p>
              <p className="venueNavigatorReportLocation">{report.location}</p>
              {reportVenue?.status === 'unresolved' && <span className="venueNavigatorUnresolvedText">位置待核对 · 可查看日程，暂无地图点位</span>}
              {conflictIds.length > 0 && <details className="venueNavigatorReportConflicts"><summary>与我的 {conflictIds.length} 场日程时间重叠</summary><ul>{conflictIds.map(id => {
                const other = scheduledById.get(id);
                return other ? <li key={id}>{other.dateTime.slice(10).trim()} · {other.sourceTitle}<span>{other.location}</span></li> : null;
              })}</ul></details>}
              <div className="venueNavigatorReportActions">
                <button type="button" aria-pressed={scheduled} aria-label={`${scheduled ? '移出' : '加入'}我的日程：${report.sourceTitle}`} onClick={() => onToggleSchedule(report)}>{scheduled ? '移出个人日程' : '加入个人日程'}</button>
                <button type="button" aria-label={`地图定位报告会场：${report.sourceTitle}`} disabled={!reportVenue} onClick={() => { if (reportVenue) selectVenue(reportVenue, true); }}>{reportVenue?.status === 'unresolved' ? '查看待核位置' : '地图定位'}</button>
                <button type="button" className="venueNavigatorPrimary" aria-label={`打开报告笔记：${report.sourceTitle}`} disabled={openingId !== null} onClick={() => void openReport(report)}>{openingId === report.id ? '正在打开…' : '打开报告笔记'}</button>
              </div>
            </article>;
          })}</div>
          {displayedReports.length > PAGE_SIZE && <nav className="venueNavigatorPagination" aria-label="会场日程分页">
            <button type="button" disabled={currentPage === 1} aria-label="上一页日程" onClick={() => { setPage(currentPage - 1); scheduleHeading.current?.scrollIntoView({ block: 'start' }); }}>上一页</button>
            <span aria-live="polite">{currentPage} / {pageCount} 页 · 共 {displayedReports.length} 场</span>
            <button type="button" disabled={currentPage === pageCount} aria-label="下一页日程" onClick={() => { setPage(currentPage + 1); scheduleHeading.current?.scrollIntoView({ block: 'start' }); }}>下一页</button>
          </nav>}
        </section>
      </div>
    </section>
  </div>;
}
