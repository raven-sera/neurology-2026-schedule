'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { PointerEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { readLibraryMeta, updateLibraryMeta } from '../lib/noteStorage';
import type { StoredSlide } from '../lib/noteStorage';
import { useDialog } from '../lib/useDialog';
import { NOTEBOOK_OPEN_EVENT } from '../lib/libraryTypes';
import type { NotebookOpenOptions } from '../lib/libraryTypes';

export function useBlobUrl(blob?: Blob) {
  const resource = useRef<{ blob: Blob; url: string } | null>(null);
  const subscribe = useCallback((notify: () => void) => {
    const current = blob ? { blob, url: URL.createObjectURL(blob) } : null;
    resource.current = current;
    notify();
    return () => { if (current) URL.revokeObjectURL(current.url); if (resource.current === current) resource.current = null; };
  }, [blob]);
  const snapshot = useCallback(() => resource.current?.blob === blob ? resource.current?.url || '' : '', [blob]);
  return useSyncExternalStore(subscribe, snapshot, () => '');
}

export function SlideThumbnail({ slide }: { slide: StoredSlide }) {
  const url = useBlobUrl(slide.mode === 'processed' ? slide.processedThumbnail || slide.thumbnail : slide.thumbnail);
  return url ? <img src={url} alt={slide.name} loading="lazy" decoding="async" /> : <span>载入缩略图…</span>;
}

function ReaderImage({ slide, root, active }: { slide: StoredSlide; root: HTMLDivElement | null; active: boolean }) {
  const holder = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!holder.current || !root) return;
    const observer = new IntersectionObserver(entries => setNear(entries[0].isIntersecting), { root, rootMargin: '240px' });
    observer.observe(holder.current);
    return () => observer.disconnect();
  }, [root]);
  const blob = slide.mode === 'processed' ? slide.processed || slide.original : slide.original;
  const url = useBlobUrl(near && active ? blob : undefined);
  return <div ref={holder} className="slidesReaderImage" style={{ aspectRatio: `${slide.width} / ${slide.height}` }}>
    {url ? <img src={url} alt={slide.name} decoding="async" onLoad={() => setFailed(false)} onError={() => setFailed(true)} /> : <span>第 {slide.order + 1} 页</span>}
    {failed && <p role="alert">此版本无法显示，请在管理中切回原图或重新校正。</p>}
  </div>;
}

export function SlideAnnotation({ slide, disabled, draft, onDraft, onSave, onImportant }: {
  slide: StoredSlide; disabled: boolean; draft: string; onDraft: (text: string) => void;
  onSave: () => Promise<boolean>; onImportant: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const dirty = draft !== (slide.annotation || '');
  const save = async () => { setSaving(true); try { setFailed(!await onSave()); } finally { setSaving(false); } };
  return <div className="slidesAnnotation" onBlur={event => { if (dirty && !saving && !disabled && !event.currentTarget.contains(event.relatedTarget as Node | null)) void save(); }}>
    {slide.annotation && <p className="slidesAnnotationPreview">{slide.annotation}</p>}
    <details open={dirty || failed || undefined}><summary>{dirty ? '批注待保存' : slide.annotation ? '编辑本页批注' : '添加本页批注'}</summary>
      <label htmlFor={`annotation-${slide.id}`}>本页批注</label>
      <textarea id={`annotation-${slide.id}`} rows={2} value={draft} disabled={saving} placeholder="记录要点、疑问或结论…" onChange={event => { onDraft(event.target.value); setFailed(false); }} />
      <button type="button" disabled={disabled || saving || !dirty} onClick={() => void save()}>保存批注</button>
    </details>
    <div className="slidesActions"><button type="button" disabled={disabled || saving} aria-pressed={!!slide.important} onClick={onImportant}>{slide.important ? '已标重要' : '标为重要'}</button><small role="status">{saving ? '正在保存…' : failed ? '保存失败，内容仍在输入框，请重试' : dirty ? '未保存' : slide.annotation ? '已保存到本机' : ''}</small></div>
  </div>;
}

function FullscreenSlide({ slides, initialId, onClose, onPage }: { slides: StoredSlide[]; initialId: string; onClose: () => void; onPage: (id: string) => void }) {
  const [id, setId] = useState(initialId);
  const index = Math.max(0, slides.findIndex(slide => slide.id === id));
  const slide = slides[index];
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const stage = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef({ x: 0, y: 0, distance: 0, zoom: 1, panX: 0, panY: 0, pinch: false });
  const url = useBlobUrl(slide.mode === 'processed' ? slide.processed || slide.original : slide.original);
  useDialog('.slidesFullscreen', onClose);
  const changePage = (offset: number) => {
    const next = slides[index + offset];
    if (!next) return;
    setId(next.id); setZoom(1); setPan({ x: 0, y: 0 }); pointers.current.clear(); onPage(next.id);
  };
  const adjustZoom = (value: number) => { setZoom(Math.max(1, Math.min(5, value))); setPan({ x: 0, y: 0 }); };
  const start = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const points = [...pointers.current.values()];
    gesture.current = { x: event.clientX, y: event.clientY, distance: points.length > 1 ? Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) : 0, zoom, panX: pan.x, panY: pan.y, pinch: points.length > 1 };
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const points = [...pointers.current.values()];
    if (points.length > 1 && gesture.current.distance) {
      setZoom(Math.max(1, Math.min(5, gesture.current.zoom * Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) / gesture.current.distance)));
    } else if (zoom > 1 && !gesture.current.pinch) {
      const box = stage.current?.getBoundingClientRect();
      const maxX = (box?.width || 0) * (zoom - 1) / 2, maxY = (box?.height || 0) * (zoom - 1) / 2;
      setPan({ x: Math.max(-maxX, Math.min(maxX, gesture.current.panX + event.clientX - gesture.current.x)), y: Math.max(-maxY, Math.min(maxY, gesture.current.panY + event.clientY - gesture.current.y)) });
    }
  };
  const end = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    if (event.type !== 'pointercancel' && pointers.current.size === 1 && zoom === 1 && !gesture.current.pinch) {
      const dx = event.clientX - gesture.current.x, dy = event.clientY - gesture.current.y;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) changePage(dx < 0 ? 1 : -1);
    }
    pointers.current.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (zoom === 1) setPan({ x: 0, y: 0 });
  };
  return createPortal(<div className="slidesOverlay slidesFullscreen" role="dialog" aria-modal="true" aria-label="全屏单页阅读" onKeyDown={event => { if (event.key === 'ArrowLeft') { event.preventDefault(); changePage(-1); } if (event.key === 'ArrowRight') { event.preventDefault(); changePage(1); } }}>
    <header className="slidesActions"><strong>第 {slide.order + 1} 页 · {index + 1} / {slides.length}</strong><button type="button" onClick={onClose}>退出全屏</button></header>
    <div ref={stage} className="slidesZoomStage" onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onWheel={event => { adjustZoom(zoom + (event.deltaY < 0 ? .25 : -.25)); }}>
      {url && <img src={url} alt={slide.name} draggable={false} style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }} />}
    </div>
    <footer className="slidesActions"><button type="button" disabled={index === 0} onClick={() => changePage(-1)}>上一页</button><button type="button" disabled={zoom <= 1} aria-label="缩小图片" onClick={() => adjustZoom(zoom - .5)}>−</button><button type="button" onClick={() => adjustZoom(1)}>{Math.round(zoom * 100)}% · 复位</button><button type="button" disabled={zoom >= 5} aria-label="放大图片" onClick={() => adjustZoom(zoom + .5)}>＋</button><button type="button" disabled={index === slides.length - 1} onClick={() => changePage(1)}>下一页</button><small>双指缩放，放大后拖动；原比例左右滑动翻页</small></footer>
  </div>, document.body);
}

export default function SlideReader({ slides, reportId, active, initialSlideId, renderAnnotation, onActiveSlideChange, onError }: {
  slides: StoredSlide[]; reportId: number; active: boolean; initialSlideId?: string;
  renderAnnotation: (slide: StoredSlide) => ReactNode;
  onActiveSlideChange?: (slide: { id: string; index: number } | null) => void; onError: (message: string) => void;
}) {
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [importantOnly, setImportantOnly] = useState(false);
  const [current, setCurrent] = useState('');
  const [jumpPage, setJumpPage] = useState('');
  const [fullscreen, setFullscreen] = useState<string | null>(null);
  const pages = useRef(new Map<string, HTMLElement>());
  const positions = useRef<{ slideId: string; offset: number } | null>(null);
  const restored = useRef(false);
  const callbacks = useRef({ onActiveSlideChange, onError });
  const handledInitialId = useRef<string | undefined>(undefined);
  const requestedId = useRef<string | undefined>(undefined);
  const [requestVersion, setRequestVersion] = useState(0);
  useEffect(() => {
    const open = (event: Event) => {
      const detail = (event as CustomEvent<{ reportId: number; options: NotebookOpenOptions }>).detail;
      if (detail.reportId !== reportId || !detail.options.slideId) return;
      requestedId.current = detail.options.slideId;
      setImportantOnly(false);
      setRequestVersion(version => version + 1);
    };
    window.addEventListener(NOTEBOOK_OPEN_EVENT, open);
    return () => window.removeEventListener(NOTEBOOK_OPEN_EVENT, open);
  }, [reportId]);
  useEffect(() => { callbacks.current = { onActiveSlideChange, onError }; }, [onActiveSlideChange, onError]);
  const visible = useMemo(() => importantOnly ? slides.filter(slide => slide.important) : slides, [slides, importantOnly]);
  const jump = useCallback((id: string, offset = 0) => {
    const page = pages.current.get(id);
    if (!root || !page) return;
    root.scrollBy({ top: page.getBoundingClientRect().top - root.getBoundingClientRect().top - root.clientTop + offset, behavior: 'instant' });
    setCurrent(id);
  }, [root]);
  useEffect(() => {
    if (!active || !root) return;
    let cancelled = false;
    restored.current = false;
    void readLibraryMeta(reportId).then(meta => {
      if (cancelled) return;
      const saved = positions.current || meta.reading;
      const requested = requestedId.current || (initialSlideId && handledInitialId.current !== initialSlideId ? initialSlideId : undefined);
      const id = requested || saved?.slideId;
      if (id && pages.current.has(id)) { jump(id, requested ? 0 : saved?.offset || 0); if (requested) { handledInitialId.current = requested; requestedId.current = undefined; } }
      restored.current = true;
      root.dispatchEvent(new Event('scroll'));
    }).catch(() => { if (!cancelled) { restored.current = true; callbacks.current.onError('无法读取上次阅读位置，可继续阅读。'); root.dispatchEvent(new Event('scroll')); } });
    return () => { cancelled = true; restored.current = false; };
  }, [active, reportId, root, initialSlideId, jump, requestVersion]);
  useEffect(() => {
    if (!active || !root) return;
    let timer: number | undefined;
    let pending = false;
    const persist = () => {
      if (!pending || !positions.current) return;
      pending = false;
      void updateLibraryMeta(reportId, { reading: { ...positions.current, updatedAt: Date.now() } }).catch(() => callbacks.current.onError('阅读位置未能保存，请检查本机存储。'));
    };
    const scroll = () => {
      if (!restored.current) return;
      const top = root.getBoundingClientRect().top + root.clientTop;
      let candidate: StoredSlide | undefined;
      for (const slide of visible) {
        const rect = pages.current.get(slide.id)?.getBoundingClientRect();
        if (rect && rect.bottom > top + 1) { candidate = slide; break; }
      }
      if (!candidate) return;
      const page = pages.current.get(candidate.id)!;
      positions.current = { slideId: candidate.id, offset: top - page.getBoundingClientRect().top };
      pending = true;
      setCurrent(candidate.id);
      callbacks.current.onActiveSlideChange?.({ id: candidate.id, index: slides.findIndex(item => item.id === candidate.id) });
      clearTimeout(timer); timer = window.setTimeout(persist, 350);
    };
    root.addEventListener('scroll', scroll, { passive: true });
    window.addEventListener('pagehide', persist);
    return () => { clearTimeout(timer); persist(); root.removeEventListener('scroll', scroll); window.removeEventListener('pagehide', persist); };
  }, [active, root, visible, reportId, slides]);
  useEffect(() => { if (active && root && restored.current) root.dispatchEvent(new Event('scroll')); }, [visible, active, root]);
  return <div className="slidesReader">
    <div className="slidesActions slidesReaderToolbar"><label><input type="checkbox" checked={importantOnly} onChange={event => setImportantOnly(event.target.checked)} />只看重要</label><form onSubmit={event => { event.preventDefault(); const slide = slides[Number(jumpPage) - 1]; if (slide) { if (importantOnly && !slide.important) { setImportantOnly(false); requestAnimationFrame(() => jump(slide.id)); } else jump(slide.id); } }}><label>跳到第 <input type="number" min="1" max={slides.length} value={jumpPage} onChange={event => setJumpPage(event.target.value)} aria-label="页码" /> 页</label><button type="submit">跳转</button></form><span>第 {Math.max(1, slides.findIndex(slide => slide.id === current) + 1)} / {slides.length} 页</span></div>
    <div className="slidesReaderLayout"><nav className="slidesDirectory" aria-label="照片缩略图目录">{visible.map(slide => <button type="button" key={slide.id} aria-current={current === slide.id ? 'page' : undefined} onClick={() => jump(slide.id)}><SlideThumbnail slide={slide} /><span>{slide.order + 1}{slide.important ? ' · 重要' : ''}</span></button>)}</nav>
      <div className="slidesReadingViewport" ref={setRoot} tabIndex={0} aria-label="连续照片阅读区">{visible.map(slide => <article key={slide.id} ref={node => { if (node) pages.current.set(slide.id, node); else pages.current.delete(slide.id); }} className="slidesReadPage"><header><strong>第 {slide.order + 1} 页{slide.important ? ' · 重要' : ''}</strong><button type="button" onClick={() => { setFullscreen(slide.id); jump(slide.id); }}>全屏 / 放大</button></header><ReaderImage slide={slide} root={root} active={active} />{renderAnnotation(slide)}</article>)}{!visible.length && <p className="slidesEmpty">尚未标记重要照片。取消筛选查看全部。</p>}</div>
    </div>
    {active && fullscreen && visible.length > 0 && <FullscreenSlide slides={visible} initialId={fullscreen} onClose={() => setFullscreen(null)} onPage={id => jump(id)} />}
  </div>;
}
