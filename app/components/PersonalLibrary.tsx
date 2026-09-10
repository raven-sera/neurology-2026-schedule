'use client';

import { lazy, Suspense, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { reports } from '../lib/reports';
import type { Report } from '../lib/reports';
import type { NotebookOpenOptions, NotebookSection } from '../lib/libraryTypes';
import { LIBRARY_CHANGE_EVENT, readLibraryMeta, readLibrarySummaries, readSlideThumbnail } from '../lib/noteStorage';
import type { LibrarySummary } from '../lib/noteStorage';
import { useClientReady } from '../lib/useClientReady';
import './personal-library.css';

const LibraryBackup = lazy(() => import('./LibraryBackup'));
const REPORT_BY_ID = new Map(reports.map((report) => [report.id, report]));
const BROWSING_KEY = 'neuro2026-personal-library-browsing-v1';
const TYPE_FILTERS = [{ value: 'all', label: '全部' }, { value: 'slides', label: 'PPT' }, { value: 'text', label: '文字' }, { value: 'audio', label: '录音' }] as const;
type ContentFilter = (typeof TYPE_FILTERS)[number]['value'];
type BrowsingState = { query: string; type: ContentFilter; date: string; field: string; tag: string; sort: 'updated' | 'date'; expanded: boolean; scroll: number };
const DEFAULT_BROWSING: BrowsingState = { query: '', type: 'all', date: '', field: '', tag: '', sort: 'updated', expanded: false, scroll: 0 };
const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase();
const titleFor = (item: LibrarySummary) => REPORT_BY_ID.get(item.reportId)?.sourceTitle ?? `未关联报告 · #${item.reportId}`;
const dateFor = (item: LibrarySummary) => REPORT_BY_ID.get(item.reportId)?.dateTime.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? '';
const timestamp = (value: number) => value > 0 && Number.isFinite(value) ? new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '时间未记录';

function loadBrowsing(): BrowsingState {
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(BROWSING_KEY) ?? 'null');
    if (!saved || typeof saved !== 'object') return DEFAULT_BROWSING;
    const value = saved as Partial<BrowsingState>;
    return {
      query: typeof value.query === 'string' ? value.query : '',
      type: TYPE_FILTERS.some((filter) => filter.value === value.type) ? value.type! : 'all',
      date: typeof value.date === 'string' ? value.date : '',
      field: typeof value.field === 'string' ? value.field : '',
      tag: typeof value.tag === 'string' ? value.tag : '',
      sort: value.sort === 'date' ? 'date' : 'updated',
      expanded: value.expanded === true,
      scroll: typeof value.scroll === 'number' && Number.isFinite(value.scroll) ? Math.max(0, value.scroll) : 0,
    };
  } catch { return DEFAULT_BROWSING; }
}

function saveBrowsing(value: BrowsingState) {
  try { sessionStorage.setItem(BROWSING_KEY, JSON.stringify(value)); } catch { /* Browsing still works when session storage is unavailable. */ }
}

function validReadingSection(item: LibrarySummary, section?: NotebookSection): NotebookSection {
  if (section === 'slides' && item.slideCount > 0 || section === 'text' && item.hasNote || section === 'audio' && item.recordingCount > 0) return section!;
  return item.slideCount > 0 ? 'slides' : item.hasNote ? 'text' : 'audio';
}

function excerpt(text: string, tokens: string[]) {
  const clean = text.replace(/\s+/g, ' ').trim();
  const haystack = normalize(clean);
  const hits = tokens.map((token) => haystack.indexOf(token)).filter((index) => index >= 0);
  const start = hits.length ? Math.max(0, Math.min(...hits) - 35) : 0;
  return `${start ? '…' : ''}${clean.slice(start, start + 170)}${clean.length > start + 170 ? '…' : ''}`;
}

function SlideThumbnail({ id, updatedAt }: { id: string; updatedAt: number }) {
  const container = useRef<HTMLDivElement>(null);
  const [source, setSource] = useState('');
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let objectUrl = '';
    const load = async () => {
      try {
        const blob = await readSlideThumbnail(id);
        if (cancelled) return;
        if (!blob) { setUnavailable(true); return; }
        objectUrl = URL.createObjectURL(blob);
        setSource(objectUrl);
      } catch { if (!cancelled) setUnavailable(true); }
    };
    let observer: IntersectionObserver | undefined;
    if (typeof IntersectionObserver === 'undefined') void load();
    else {
      observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) { observer?.disconnect(); void load(); }
      }, { rootMargin: '160px' });
      if (container.current) observer.observe(container.current);
    }
    return () => { cancelled = true; observer?.disconnect(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [id, updatedAt]);
  return <div className="libraryThumbnail" ref={container} aria-hidden="true">
    {source && !unavailable ? <img src={source} alt="" loading="lazy" onError={() => setUnavailable(true)} /> : <span>{unavailable ? '预览不可用' : 'PPT'}</span>}
  </div>;
}

export default function PersonalLibrary(props: { onOpen: (report: Report, options: NotebookOpenOptions) => void }) {
  const ready = useClientReady();
  return ready ? <LibraryContent {...props} /> : <p className="moduleLoading" role="status">正在打开本机图书馆…</p>;
}

function LibraryContent({ onOpen }: { onOpen: (report: Report, options: NotebookOpenOptions) => void }) {
  const [browsing, setBrowsing] = useState<BrowsingState>(loadBrowsing);
  const browsingRef = useRef(browsing);
  const [items, setItems] = useState<LibrarySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [backupOpen, setBackupOpen] = useState(false);
  const [opening, setOpening] = useState<number | null>(null);
  const restored = useRef(false);
  const request = useRef(0);
  const openRequest = useRef(0);
  const mounted = useRef(false);
  const deferredQuery = useDeferredValue(browsing.query);
  const tokens = useMemo(() => normalize(deferredQuery).trim().split(/\s+/).filter(Boolean), [deferredQuery]);

  const refresh = useCallback(() => {
    const current = ++request.current;
    return readLibrarySummaries().then(summaries => {
      if (!mounted.current || current !== request.current) return;
      setError('');
      setItems(summaries);
      setLoaded(true);
    }).catch(cause => {
      if (!mounted.current || current !== request.current) return;
      setError(`无法读取本机资料库。已有内容未被删除，请重试；也可以尝试导出备份。${cause instanceof Error ? `（${cause.message}）` : ''}`);
    }).finally(() => { if (mounted.current && current === request.current) setLoading(false); });
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const onChange = (event: Event) => {
      const detail = (event as CustomEvent<{ reportIds: number[]; kind: string }>).detail;
      if (detail?.kind === 'reading') {
        // Reading changes only refresh metadata, never the full library index or image blobs.
        const generation = request.current;
        void Promise.all(detail.reportIds.map((id) => readLibraryMeta(id))).then((metas) => {
          if (!mounted.current || generation !== request.current) return;
          const byId = new Map(metas.map((meta) => [meta.reportId, meta]));
          setItems((current) => current.map((item) => byId.has(item.reportId) ? { ...item, meta: byId.get(item.reportId)! } : item));
        }).catch(() => { /* The next committed content change or focus refresh retries metadata. */ });
      } else { setLoading(true); void refresh(); }
    };
    const onFocus = () => { setLoading(true); void refresh(); };
    window.addEventListener(LIBRARY_CHANGE_EVENT, onChange);
    window.addEventListener('focus', onFocus);
    return () => {
      mounted.current = false;
      ++request.current;
      ++openRequest.current;
      saveBrowsing(browsingRef.current);
      window.removeEventListener(LIBRARY_CHANGE_EVENT, onChange);
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  useEffect(() => {
    if (!loaded || restored.current || deferredQuery !== browsing.query) return;
    const frame = requestAnimationFrame(() => {
      window.scrollTo({ top: browsingRef.current.scroll, behavior: 'instant' });
      restored.current = true;
    });
    return () => cancelAnimationFrame(frame);
  }, [loaded, deferredQuery, browsing.query]);

  useEffect(() => {
    let frame = 0;
    const onScroll = () => {
      if (!restored.current || document.body.style.overflow === 'hidden' || frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        browsingRef.current = { ...browsingRef.current, scroll: window.scrollY };
        saveBrowsing(browsingRef.current);
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => { window.removeEventListener('scroll', onScroll); cancelAnimationFrame(frame); };
  }, []);

  const changeBrowsing = (patch: Partial<BrowsingState>) => {
    const next = { ...browsingRef.current, ...patch };
    browsingRef.current = next;
    setBrowsing(next);
    saveBrowsing(next);
  };
  const open = async (item: LibrarySummary, options: NotebookOpenOptions, resume = false) => {
    const report = REPORT_BY_ID.get(item.reportId);
    if (!report) {
      setNotice(`报告 #${item.reportId} 已不在当前日程数据中，暂时无法打开对应笔记本。资料仍保存在本机，请通过“备份 / 恢复”导出完整备份，勿清理浏览器数据。`);
      return;
    }
    browsingRef.current = { ...browsingRef.current, scroll: window.scrollY };
    saveBrowsing(browsingRef.current);
    setNotice('');
    const current = ++openRequest.current;
    let target = options;
    if (resume) {
      setOpening(item.reportId);
      try {
        const meta = await readLibraryMeta(item.reportId);
        const section = validReadingSection(item, meta.reading?.section);
        target = { ...options, section, slideId: section === 'slides' ? meta.reading?.slideId : undefined };
      } catch {
        if (mounted.current && current === openRequest.current) {
          setNotice('未能读取上次阅读位置。请重试，或使用资料卡片中的“阅读”从内容入口打开。');
          setOpening(null);
        }
        return;
      }
    }
    if (!mounted.current || current !== openRequest.current) return;
    setOpening(null);
    onOpen(report, target);
  };

  const choices = useMemo(() => ({
    dates: [...new Set(items.map(dateFor).filter(Boolean))].sort(),
    fields: [...new Set(items.map((item) => REPORT_BY_ID.get(item.reportId)?.field ?? '').filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN')),
    tags: [...new Set(items.flatMap((item) => item.meta.tags))].sort((a, b) => a.localeCompare(b, 'zh-CN')),
  }), [items]);
  const totals = useMemo(() => items.reduce((result, item) => ({
    all: result.all + 1, slides: result.slides + Number(item.slideCount > 0), text: result.text + Number(item.hasNote), audio: result.audio + Number(item.recordingCount > 0),
    photos: result.photos + item.slideCount, recordings: result.recordings + item.recordingCount,
  }), { all: 0, slides: 0, text: 0, audio: 0, photos: 0, recordings: 0 }), [items]);
  const latest = useMemo(() => items.reduce<LibrarySummary | undefined>((result, item) => item.meta.lastOpenedAt > (result?.meta.lastOpenedAt ?? 0) ? item : result, undefined), [items]);
  const visible = useMemo(() => items.filter((item) => {
    const report = REPORT_BY_ID.get(item.reportId);
    if (browsing.type === 'slides' && !item.slideCount || browsing.type === 'text' && !item.hasNote || browsing.type === 'audio' && !item.recordingCount) return false;
    if (browsing.date && dateFor(item) !== browsing.date || browsing.field && report?.field !== browsing.field || browsing.tag && !item.meta.tags.includes(browsing.tag)) return false;
    if (!tokens.length) return true;
    const haystack = normalize([titleFor(item), report?.speaker, report?.institution, item.noteText, item.annotationText, ...item.meta.tags].join(' '));
    return tokens.every((token) => haystack.includes(token));
  }).sort((a, b) => browsing.sort === 'date' ? dateFor(b).localeCompare(dateFor(a)) || b.updatedAt - a.updatedAt || a.reportId - b.reportId : b.updatedAt - a.updatedAt || a.reportId - b.reportId), [items, browsing.type, browsing.date, browsing.field, browsing.tag, browsing.sort, tokens]);
  const filtered = Boolean(browsing.query || browsing.type !== 'all' || browsing.date || browsing.field || browsing.tag);
  const secondaryCount = Number(Boolean(browsing.date)) + Number(Boolean(browsing.field)) + Number(Boolean(browsing.tag));

  return <section className="personalLibrary" aria-labelledby="personal-library-title">
    <header className="libraryHeading">
      <div><span className="libraryEyebrow">我的学习资料</span><h1 id="personal-library-title">个人图书馆</h1><p>把拍下的 PPT、写下的笔记和录音，留在同一个报告里。</p></div>
      <button type="button" onClick={() => setBackupOpen(true)}>备份 / 恢复</button>
    </header>
    <details className="libraryPrivacy"><summary>仅保存在当前浏览器 · 请定期备份</summary><p>不会自动上传或跨设备同步。清理网站数据可能丢失资料；换设备前先导出完整备份。</p></details>
    <div className="libraryToolbar">
      <label className="librarySearch"><span className="librarySrOnly">搜索资料库</span><input type="search" placeholder="搜索标题、讲者、笔记、PPT 批注或标签" value={browsing.query} onChange={(event) => changeBrowsing({ query: event.target.value })} /></label>
      <div className="libraryFilterRow"><div className="libraryTypes" role="group" aria-label="资料类型">{TYPE_FILTERS.map((filter) => <button type="button" key={filter.value} aria-pressed={browsing.type === filter.value} onClick={() => changeBrowsing({ type: filter.value })}>{filter.label}<span>{loaded ? totals[filter.value] : '—'}</span></button>)}</div>
        <button type="button" className="libraryMoreFilters" aria-expanded={browsing.expanded} aria-controls="library-secondary-filters" onClick={() => changeBrowsing({ expanded: !browsing.expanded })}>筛选{secondaryCount > 0 ? ` · ${secondaryCount}` : ''}</button>
        <label className="librarySort"><span className="librarySrOnly">排序方式</span><select value={browsing.sort} onChange={(event) => changeBrowsing({ sort: event.target.value === 'date' ? 'date' : 'updated' })}><option value="updated">最近更新</option><option value="date">报告日期 · 由近到远</option></select></label>
      </div>
      {browsing.expanded && <div className="librarySecondaryFilters" id="library-secondary-filters">
        <label>报告日期<select value={browsing.date} onChange={(event) => changeBrowsing({ date: event.target.value })}><option value="">全部日期</option>{browsing.date && !choices.dates.includes(browsing.date) && <option value={browsing.date}>{browsing.date}（暂无资料）</option>}{choices.dates.map((date) => <option key={date}>{date}</option>)}</select></label>
        <label>研究领域<select value={browsing.field} onChange={(event) => changeBrowsing({ field: event.target.value })}><option value="">全部领域</option>{browsing.field && !choices.fields.includes(browsing.field) && <option value={browsing.field}>{browsing.field}（暂无资料）</option>}{choices.fields.map((field) => <option key={field}>{field}</option>)}</select></label>
        <label>个人标签<select value={browsing.tag} onChange={(event) => changeBrowsing({ tag: event.target.value })}><option value="">全部标签</option>{browsing.tag && !choices.tags.includes(browsing.tag) && <option value={browsing.tag}>{browsing.tag}（暂无资料）</option>}{choices.tags.map((tag) => <option key={tag}>{tag}</option>)}</select></label>
        <p>标签可在报告笔记本中编辑；日期和领域来自报告日程。</p>
      </div>}
    </div>


    {loaded && <div className="libraryTotals" aria-label="资料库概况"><strong>{totals.all}<span>份报告资料</span></strong><span>{totals.photos} 页 PPT</span><span>{totals.text} 份文字笔记</span><span>{totals.recordings} 段录音</span></div>}

    {latest && <section className="libraryContinue" aria-label="继续上次阅读">
      <div className="libraryContinueCopy"><span className="libraryEyebrow">继续上次阅读</span><h2>{titleFor(latest)}</h2>
        <p>{REPORT_BY_ID.get(latest.reportId)?.speaker || '报告信息暂不可用'} · {timestamp(latest.meta.lastOpenedAt)}</p>
        <p>{[REPORT_BY_ID.get(latest.reportId)?.dateTime, REPORT_BY_ID.get(latest.reportId)?.field].filter(Boolean).join(' · ')}</p>
        <small>{latest.meta.reading?.section === 'slides' ? `PPT${latest.meta.reading.slideId && latest.slides.some((slide) => slide.id === latest.meta.reading?.slideId) ? ` · 第 ${latest.slides.findIndex((slide) => slide.id === latest.meta.reading?.slideId) + 1} 页` : ''}` : latest.meta.reading?.section === 'text' ? '文字笔记 · 返回上次位置' : latest.meta.reading?.section === 'audio' ? '录音' : '返回报告资料'} · {latest.slideCount} 页 PPT / {latest.hasNote ? 1 : 0} 份笔记 / {latest.recordingCount} 段录音</small>
      </div>
      <div className="libraryContinueActions"><button type="button" className="libraryPrimary" disabled={opening === latest.reportId} onClick={() => void open(latest, { mode: 'read' }, true)}>继续阅读</button><button type="button" disabled={opening === latest.reportId} onClick={() => void open(latest, { mode: 'edit' }, true)}>继续编辑</button></div>
    </section>}

    {notice && <div className="libraryNotice" role="status"><p>{notice}</p><button type="button" onClick={() => setNotice('')}>知道了</button></div>}
    {error && <div className="libraryError" role="alert"><p>{error}</p>{loaded && <p>下方是上次成功读取的资料，暂未确认最新状态。</p>}<button type="button" disabled={loading} onClick={() => void refresh()}>重新读取</button></div>}
    <div className="libraryResultHeading" role="status" aria-live="polite"><span>{loading ? loaded ? '正在更新资料…' : '正在读取本机资料…' : loaded ? `找到 ${visible.length} 份资料${filtered ? ' · 已筛选' : ''}` : '资料库尚未读取成功'}{deferredQuery !== browsing.query ? ' · 正在搜索' : ''}</span>{filtered && <button type="button" onClick={() => changeBrowsing({ query: '', type: 'all', date: '', field: '', tag: '' })}>清除筛选</button>}</div>

    {loaded && !error && !loading && items.length === 0 && <div className="libraryEmpty"><span className="libraryEyebrow">从一场报告开始</span><h2>你的学习资料会汇集在这里</h2><p>在报告看板打开一场报告，拍摄或导入 PPT、写笔记或录音，保存后即可在这里阅读。已有本机笔记也会自动显示。</p><p>仅收藏或加入日程、但尚未保存资料的报告不会出现在这里。</p><button type="button" onClick={() => setBackupOpen(true)}>从备份恢复资料</button></div>}
    {loaded && !error && !loading && items.length > 0 && visible.length === 0 && <div className="libraryEmpty"><h2>没有符合条件的资料</h2><p>试试更短的关键词，或放宽类型、日期、领域和标签筛选。原有资料没有被删除。</p><button type="button" onClick={() => changeBrowsing({ query: '', type: 'all', date: '', field: '', tag: '' })}>显示全部资料</button></div>}

    <ul className="libraryList" aria-busy={loading}>{visible.map((item) => {
      const report = REPORT_BY_ID.get(item.reportId);
      const annotationHits = tokens.length ? item.slides.filter((slide) => tokens.some((token) => normalize(slide.annotation).includes(token))) : [];
      const textHit = item.hasNote && tokens.some((token) => normalize(item.noteText).includes(token));
      const target: NotebookOpenOptions = annotationHits.length ? { section: 'slides', slideId: annotationHits[0].id } : textHit ? { section: 'text' } : { section: browsing.type === 'all' ? validReadingSection(item) : browsing.type };
      const thumbnail = target.slideId ?? item.firstSlideId;
      return <li className="libraryCard" key={item.reportId}>
        {item.slideCount > 0 && thumbnail && <button type="button" className="libraryPreviewButton" aria-label={`阅读 ${titleFor(item)} 的 PPT`} onClick={() => void open(item, { section: 'slides', slideId: thumbnail, mode: 'read' })}><SlideThumbnail key={`${thumbnail}:${item.updatedAt}`} id={thumbnail} updatedAt={item.updatedAt} /><span>{item.slideCount} 页 PPT</span></button>}
        <div className="libraryCardBody">
          <div className="libraryCardContext"><span>{report?.field ?? '未关联日程'}</span><time>{report?.dateTime || '报告日期未知'}</time></div>
          <h2><button type="button" onClick={() => void open(item, { ...target, mode: 'read' })}>{titleFor(item)}</button></h2>
          <p className="librarySpeaker">{report ? [report.speaker, report.institution].filter(Boolean).join(' · ') : `原报告编号 ${item.reportId} · 本机资料仍保留`}</p>
          {report && <p className="libraryReportContext">{[report.program, report.session, report.location].filter(Boolean).join(' · ')}</p>}
          {item.hasNote && <p className="libraryExcerpt">{excerpt(item.noteText, tokens) || '已保存文字笔记，打开查看完整内容。'}</p>}
          {!item.hasNote && !item.slideCount && <p className="libraryExcerpt">已保存 {item.recordingCount} 段录音，打开笔记本收听。</p>}
          {annotationHits.length > 0 && <div className="librarySearchHits" aria-label="匹配的 PPT 批注">{annotationHits.map((slide) => <button type="button" key={slide.id} onClick={() => void open(item, { section: 'slides', slideId: slide.id, mode: 'read' })}><b>PPT 第 {item.slides.findIndex((entry) => entry.id === slide.id) + 1} 页批注</b><span>{excerpt(slide.annotation, tokens)}</span></button>)}</div>}
          {textHit && <button type="button" className="libraryTextHit" onClick={() => void open(item, { section: 'text', mode: 'read' })}>命中文字笔记 · 打开文字</button>}
          {item.meta.tags.length > 0 && <div className="libraryTags" aria-label="个人标签">{item.meta.tags.map((tag) => <button type="button" key={tag} aria-pressed={browsing.tag === tag} onClick={() => changeBrowsing({ tag: browsing.tag === tag ? '' : tag })}>#{tag}</button>)}</div>}
          {!report && <p className="libraryOrphan">当前日程已找不到此报告，暂时无法打开笔记本。请导出完整备份保留原始内容；恢复到包含该报告的版本后可继续访问。</p>}
          <div className="libraryCardFooter"><div className="libraryContentCounts" aria-label="已保存内容">{item.slideCount > 0 && <button type="button" onClick={() => void open(item, { section: 'slides', mode: 'read' })}>{item.slideCount} 页 PPT</button>}{item.hasNote && <button type="button" onClick={() => void open(item, { section: 'text', mode: 'read' })}>文字笔记</button>}{item.recordingCount > 0 && <button type="button" onClick={() => void open(item, { section: 'audio', mode: 'read' })}>{item.recordingCount} 段录音</button>}</div><span className="libraryUpdated">更新于 {timestamp(item.updatedAt)}</span></div>
        </div>
        <div className="libraryCardActions">{report ? <><button type="button" className="libraryPrimary" onClick={() => void open(item, { ...target, mode: 'read' })}>阅读</button><button type="button" disabled={opening === item.reportId} onClick={() => void open(item, { mode: 'edit' }, true)}>继续编辑</button></> : <button type="button" onClick={() => setBackupOpen(true)}>备份此设备资料</button>}</div>
      </li>;
    })}</ul>
    <p className="libraryBottomNote">资料只在本机保存。阅读不会修改内容；需要增补时选择“继续编辑”。</p>
    {backupOpen && <Suspense fallback={<div className="libraryBackupLoading" role="status"><p>正在打开备份工具…</p><button type="button" onClick={() => setBackupOpen(false)}>取消</button></div>}><LibraryBackup onClose={() => setBackupOpen(false)} /></Suspense>}
  </section>;
}
