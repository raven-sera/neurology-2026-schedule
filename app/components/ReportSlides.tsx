'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { reports, searchScore } from '../lib/reports';
import type { Report } from '../lib/reports';
import { readSlideRecords, removeSlideRecords, moveSlideRecords, writeSlideRecords, LIBRARY_CHANGE_EVENT } from '../lib/noteStorage';
import type { StoredSlide } from '../lib/noteStorage';
import type { SlideCorners } from '../lib/slideImages';
import { useDialog } from '../lib/useDialog';
import './report-slides.css';
import SlideReader, { SlideAnnotation, SlideThumbnail, useBlobUrl } from './SlideReader';
import { NOTEBOOK_OPEN_EVENT } from '../lib/libraryTypes';
import type { NotebookOpenOptions } from '../lib/libraryTypes';

import { prepareSlideImage, detectSlideCorners, processSlideImage } from '../lib/slideImages';
import { buildSlideExport } from '../lib/slideExport';

const fullCorners = (): SlideCorners => [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
const cornerNames = ['左上角', '右上角', '右下角', '左下角'];
const cornerDirections: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

function explain(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'QuotaExceededError') return '浏览器存储空间不足。请先导出备份，再删除不需要的照片后重试。';
    return error.message || '操作失败，请重试。';
  }
  return '操作失败，请重试。';
}

async function storeSlidePhoto(file: File, reportId: number, order: number): Promise<StoredSlide> {
  const image = await prepareSlideImage(file);
  const createdAt = Date.now();
  const id = globalThis.crypto?.randomUUID?.() || `${reportId}-${createdAt}-${Math.random().toString(36).slice(2)}`;
  const record: StoredSlide = { id, reportId, name: file.name || `PPT ${order + 1}`, ...image, createdAt, order, mode: 'original' };
  await writeSlideRecords([record]);
  return record;
}


function SlideCamera({ onClose, onNative, onGallery, onCapture, saveErrors, report, slides, pending }: {
  onClose: () => void;
  onNative: () => void;
  onGallery: () => void;
  report: Report;
  slides: StoredSlide[];
  pending: boolean;
  onCapture: (file: File) => Promise<boolean>;
  saveErrors: string[];
}) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const alive = useRef(false);
  const capturing = useRef(false);
  const captureDone = useRef<Promise<void>>(Promise.resolve());
  const resolveCapture = useRef<(() => void) | null>(null);
  const captureSaved = useRef(false);
  useEffect(() => {
    const flush = (event: Event) => {
      if (!capturing.current) return;
      (event as CustomEvent<{ promises: Promise<void>[] }>).detail.promises.push(captureDone.current.then(() => { if (!captureSaved.current) throw new Error('拍摄照片未保存，请处理拍摄窗口中的错误后重试。'); }));
    };
    window.addEventListener('neuro2026:flush-notebook', flush);
    return () => window.removeEventListener('neuro2026:flush-notebook', flush);
  }, []);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('正在请求后置摄像头权限…');
  const [attempt, setAttempt] = useState(0);
  const closeRequested = useRef(false);
  const requestClose = () => {
    if (capturing.current || pending) { closeRequested.current = true; setMessage('当前照片保存完成后将关闭摄像头。'); return; }
    onClose();
  };
  useDialog('.slideCameraOverlay', requestClose);
  useEffect(() => { if (!busy && !pending && closeRequested.current) onClose(); }, [busy, pending, onClose]);

  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    const stop = () => { stream.current?.getTracks().forEach(track => track.stop()); stream.current = null; };
    const start = async () => {
      try {
        if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
          throw new Error('连续拍摄需要 HTTPS（或 localhost）及支持摄像头的浏览器。请改用系统拍照，或从相册添加。');
        }
        const next = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 2560 }, height: { ideal: 1440 } }, audio: false });
        if (cancelled) { next.getTracks().forEach(track => track.stop()); return; }
        stream.current = next;
        if (!video.current) { stop(); return; }
        video.current.srcObject = next;
        next.getVideoTracks().forEach(track => {
          track.onended = () => {
            if (cancelled) return;
            setReady(false);
            setError('摄像头已断开。请重新开启，或使用系统拍照。');
          };
        });
        await video.current.play();
        if (cancelled) { stop(); return; }
        setReady(true);
        setMessage('对准 PPT 后拍摄；保存完成即可继续拍下一张。');
      } catch (cause) {
        stop();
        if (cancelled) return;
        const name = cause instanceof Error ? cause.name : '';
        setMessage('');
        setError(name === 'NotAllowedError' ? '摄像头权限被拒绝。请在浏览器网站设置中允许摄像头后重试，或使用系统拍照 / 相册。' : name === 'NotFoundError' ? '未找到摄像头。请使用相册添加照片。' : name === 'NotReadableError' ? '摄像头可能正被其他应用占用，请关闭占用后重试，或使用系统拍照。' : explain(cause));
      }
    };
    void start();
    return () => { cancelled = true; alive.current = false; stop(); };
  }, [attempt]);

  const capture = async () => {
    if (capturing.current || !ready || !video.current) return;
    capturing.current = true;
    captureSaved.current = false;
    captureDone.current = new Promise<void>(resolve => { resolveCapture.current = resolve; });
    setBusy(true);
    setError('');
    try {
      const source = video.current;
      if (!source.videoWidth || !source.videoHeight) throw new Error('摄像头画面尚未就绪，请稍后重试。');
      const canvas = document.createElement('canvas');
      canvas.width = source.videoWidth;
      canvas.height = source.videoHeight;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('浏览器无法读取拍摄画面，请改用系统拍照。');
      context.drawImage(source, 0, 0);
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('照片生成失败，请重新拍摄。')), 'image/jpeg', 0.95));
      canvas.width = canvas.height = 0;
      if (!alive.current) return;
      const saved = await onCapture(new File([blob], `PPT-${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`, { type: 'image/jpeg' }));
      captureSaved.current = saved;
      if (alive.current) setMessage(saved ? '本张已保存到此报告，可以继续拍摄。' : '本张未保存，请关闭拍摄查看错误，处理后重试。');
    } catch (cause) {
      if (alive.current) setError(explain(cause));
    } finally {
      capturing.current = false;
      resolveCapture.current?.(); resolveCapture.current = null;
      if (alive.current) setBusy(false);
    }
  };

  return createPortal(<div className="slidesOverlay slideCameraOverlay" role="dialog" aria-modal="true" aria-labelledby="slideCameraTitle">
    <div className="slidesDialog">
      <header><div><small>PPT 连续拍摄 · 已保存 {slides.length} 张</small><h3 id="slideCameraTitle">{report.sourceTitle}</h3></div><button type="button" onClick={requestClose}>{busy || pending ? '保存完成后关闭' : '停止并关闭'}</button></header>
      <video ref={video} autoPlay playsInline muted aria-label="后置摄像头实时画面" />
      <div className="slidesRecent" aria-label="最近已保存照片">{slides.slice(-6).map(slide => <div key={slide.id}><SlideThumbnail slide={slide} /><small>{slide.order + 1}</small></div>)}</div>
      <details><summary>拍摄与隐私说明</summary><p className="slidesHint">仅存本机，不上传。关闭会停止摄像头；正在保存时会等待。画质取决于设备的视频分辨率，需要最高画质可用系统相机或相册。</p></details>
      <p role="status">{busy || pending ? '正在处理并写入本机，完成前不计入已保存张数…' : message}</p>
      {error && <p className="slidesError" role="alert">{error}</p>}
      {!!saveErrors.length && <div className="slidesError" role="alert">{saveErrors.map((text, index) => <p key={index}>{text}</p>)}</div>}
      <div className="slidesActions"><button className="slidesPrimary slidesShutter" type="button" disabled={!ready || busy || pending} onClick={() => void capture()}>{busy || pending ? '保存中…' : '拍摄并保存'}</button>{error && <button type="button" disabled={busy || pending} onClick={() => { setReady(false); setError(''); setMessage('正在请求后置摄像头权限…'); setAttempt(value => value + 1); }}>重新开启摄像头</button>}<button type="button" disabled={busy || pending} onClick={onNative}>系统拍照</button><button type="button" disabled={busy || pending} onClick={onGallery}>从相册添加</button></div>
    </div>
  </div>, document.body);
}

function SlideEditor({ slide, onClose, onApply, saveErrors }: {
  slide: StoredSlide;
  onClose: () => void;
  onApply: (corners: SlideCorners, enhance: boolean, rotation: 0 | 90 | 180 | 270) => Promise<boolean>;
  saveErrors: string[];
}) {
  const url = useBlobUrl(slide.original);
  const stage = useRef<HTMLDivElement>(null);
  const alive = useRef(false);
  const saving = useRef(false);
  const [corners, setCorners] = useState<SlideCorners>(fullCorners);
  const [enhance, setEnhance] = useState(true);
  const [rotation, setRotation] = useState<0 | 90 | 180 | 270>(0);
  const [detecting, setDetecting] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('正在识别边缘…');
  const [error, setError] = useState('');
  const requestClose = () => { if (saving.current) { setError('正在处理并保存，请等待完成后关闭。'); return; } onClose(); };
  useDialog('.slideEditorOverlay', requestClose);
  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    void (async () => {
      try {
        const detected = await detectSlideCorners(slide.original);
        if (cancelled) return;
        setCorners(detected || fullCorners());
        setMessage(detected ? '已识别候选边缘，请检查四角后保存。' : '未识别到可靠边缘，已选择全图。请手动拖动四角。');
      } catch (cause) {
        if (!cancelled) setMessage(`自动识别不可用，仍可手动选取四角。${explain(cause)}`);
      } finally { if (!cancelled) setDetecting(false); }
    })();
    return () => { cancelled = true; alive.current = false; };
  }, [slide.original]);

  const updateCorner = (index: number, x: number, y: number) => setCorners(previous => previous.map((point, i) => i === index ? { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) } : point) as SlideCorners);
  const drag = (event: PointerEvent<HTMLButtonElement>, index: number) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId) || !stage.current) return;
    const rect = stage.current.getBoundingClientRect();
    if (rect.width && rect.height) updateCorner(index, (event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height);
  };
  const moveKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const direction = cornerDirections[event.key];
    if (!direction) return;
    event.preventDefault();
    const amount = event.shiftKey ? 0.05 : 0.005;
    updateCorner(index, corners[index].x + direction[0] * amount, corners[index].y + direction[1] * amount);
  };
  const apply = async () => {
    if (saving.current || detecting) return;
    saving.current = true;
    setBusy(true);
    setError('');
    try {
      if (await onApply(corners, enhance, rotation)) { if (alive.current) onClose(); }
      else if (alive.current) setError('处理或保存失败，原图未改动。请关闭窗口查看错误，或重试。');
    } finally {
      saving.current = false;
      if (alive.current) setBusy(false);
    }
  };
  return createPortal(<div className="slidesOverlay slideEditorOverlay" role="dialog" aria-modal="true" aria-labelledby="slideEditorTitle">
    <div className="slidesDialog">
      <header><div><small>原图始终保留</small><h3 id="slideEditorTitle">校正 PPT 四角</h3></div><button type="button" onClick={requestClose}>关闭</button></header>
      <p className="slidesHint">按左上、右上、右下、左下顺序选取，四边不要交叉。拖动圆点，或聚焦圆点后用方向键微调（Shift 加速）。下方为原图；旋转在裁切后应用。</p>
      <div className="slidesCornerPad"><div className="slidesCornerStage" ref={stage}>
        {url && <img src={url} alt={`待校正原图：${slide.name}`} draggable={false} />}
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><polygon points={corners.map(point => `${point.x * 100},${point.y * 100}`).join(' ')} /></svg>
        {corners.map((point, index) => <button type="button" className="slidesCorner" key={index} disabled={detecting || busy} style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }} aria-label={`${cornerNames[index]}，横向 ${Math.round(point.x * 100)}%，纵向 ${Math.round(point.y * 100)}%，方向键移动`} onPointerDown={event => { event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={event => drag(event, index)} onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onKeyDown={event => moveKey(event, index)}>{index + 1}</button>)}
      </div></div>
      <p role="status">{busy ? '正在校正并保存…' : message}</p>
      {error && <p role="alert" className="slidesError">{error}</p>}
      {!!saveErrors.length && <div className="slidesError" role="alert">{saveErrors.map((text, index) => <p key={index}>{text}</p>)}</div>}
      <div className="slidesEditOptions"><label><input type="checkbox" checked={enhance} disabled={busy} onChange={event => setEnhance(event.target.checked)} />增强对比度与清晰度</label><label>顺时针旋转<select value={rotation} disabled={busy} onChange={event => setRotation(Number(event.target.value) as 0 | 90 | 180 | 270)}><option value={0}>不旋转</option><option value={90}>90°</option><option value={180}>180°</option><option value={270}>270°</option></select></label></div>
      <div className="slidesActions"><button type="button" disabled={busy || detecting} onClick={() => setCorners(fullCorners())}>重置全图四角</button><button className="slidesPrimary" type="button" disabled={busy || detecting} onClick={() => void apply()}>{busy ? '保存中…' : '校正并保存扫描版'}</button></div>
    </div>
  </div>, document.body);
}

export default function ReportSlides({ report, initialCapture = false, initialSlideId, active = true, onCountChange, onActiveSlideChange }: {
  report: Report; initialCapture?: boolean; initialSlideId?: string; active?: boolean;
  onCountChange?: (count: number) => void; onActiveSlideChange?: (slide: { id: string; index: number } | null) => void;
}) {
  const [slides, setSlides] = useState<StoredSlide[]>([]);
  const records = useRef<StoredSlide[]>([]);
  const alive = useRef(false);
  const locked = useRef(true);
  const [load, setLoad] = useState<'loading' | 'ready' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [camera, setCamera] = useState(false);
  const [previousActive, setPreviousActive] = useState(active);
  if (previousActive !== active) {
    setPreviousActive(active);
    if (!active) setCamera(false);
  }
  const [editing, setEditing] = useState<StoredSlide | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [view, setView] = useState<'read' | 'manage'>('read');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [moving, setMoving] = useState(false);
  const [moveQuery, setMoveQuery] = useState('');
  const [destination, setDestination] = useState<number | null>(null);
  const dragged = useRef<string | null>(null);
  const captureOpened = useRef(false);
  const currentSlideId = useRef<string | null>(null);
  const drafts = useRef<Record<string, string>>({});
  const [draftValues, setDraftValues] = useState<Record<string, string>>({});
  const operationDone = useRef<Promise<void>>(Promise.resolve());
  const resolveOperation = useRef<(() => void) | null>(null);
  const flushRef = useRef<(() => Promise<void>) | null>(null);
  const [exportResult, setExportResult] = useState<{ blob: Blob; filename: string } | null>(null);
  const [shareBusy, setShareBusy] = useState(false);
  const [progress, setProgress] = useState<{ completed: number; total: number } | null>(null);
  const nativeInput = useRef<HTMLInputElement>(null);
  const galleryInput = useRef<HTMLInputElement>(null);
  const exportUrl = useBlobUrl(exportResult?.blob);
  const disabled = load !== 'ready' || !!busy;
  const displaySlides = useMemo(() => slides.map((slide, index) => slide.order === index ? slide : { ...slide, order: index }), [slides]);
  const moveMatches = useMemo(() => reports.filter(item => item.id !== report.id).map(item => ({ report: item, score: searchScore(item, moveQuery) })).filter(item => item.score > 0).sort((a, b) => b.score - a.score), [moveQuery, report.id]);
  useDialog('.slidesMoveOverlay', () => { if (!locked.current) setMoving(false); }, moving);
  useDialog('.slidesDeleteOverlay', () => { if (!locked.current) setDeleting(false); }, deleting);
  useEffect(() => { if (load === 'ready') onCountChange?.(slides.length); }, [load, slides.length, onCountChange]);
  useEffect(() => {
    if (load !== 'ready') return;
    const index = slides.findIndex(slide => slide.id === currentSlideId.current);
    onActiveSlideChange?.(index < 0 ? null : { id: slides[index].id, index });
  }, [load, slides, onActiveSlideChange]);
  useEffect(() => {
    if (active && initialCapture && load === 'ready' && !captureOpened.current) { captureOpened.current = true; setCamera(true); }
  }, [active, initialCapture, load]);
  useEffect(() => {
    const open = (event: Event) => {
      const detail = (event as CustomEvent<{ reportId: number; options: NotebookOpenOptions }>).detail;
      if (detail.reportId !== report.id) return;
      if (detail.options.slideId) setView('read');
      if (detail.options.capture && load === 'ready') setCamera(true);
    };
    window.addEventListener(NOTEBOOK_OPEN_EVENT, open);
    return () => window.removeEventListener(NOTEBOOK_OPEN_EVENT, open);
  }, [report.id, load]);
  useEffect(() => {
    const flush = (event: Event) => { if (flushRef.current) (event as CustomEvent<{ promises: Promise<void>[] }>).detail.promises.push(flushRef.current()); };
    const leave = (event: BeforeUnloadEvent) => {
      if (locked.current || records.current.some(slide => drafts.current[slide.id] !== undefined && drafts.current[slide.id] !== (slide.annotation || ''))) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('neuro2026:flush-notebook', flush);
    window.addEventListener('beforeunload', leave);
    return () => { window.removeEventListener('neuro2026:flush-notebook', flush); window.removeEventListener('beforeunload', leave); };
  }, []);

  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    locked.current = true;
    void readSlideRecords(report.id).then(value => {
      if (cancelled) return;
      records.current = value.sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
      setSlides(records.current);
      setLoad('ready');
      locked.current = false;
    }).catch(cause => {
      if (cancelled) return;
      setErrors([`无法读取本报告的照片：${explain(cause)}`]);
      setLoad('error');
    });
    const refresh = (event: Event) => {
      const detail = (event as CustomEvent<{ reportIds: number[]; kind: string }>).detail;
      if (detail.kind !== 'content' || !detail.reportIds.includes(report.id) || locked.current) return;
      void readSlideRecords(report.id).then(value => { if (!cancelled && !locked.current) { records.current = value; setSlides(value); setExportResult(null); } }).catch(cause => { if (!cancelled) setErrors([explain(cause)]); });
    };
    window.addEventListener(LIBRARY_CHANGE_EVENT, refresh);
    return () => { cancelled = true; alive.current = false; window.removeEventListener(LIBRARY_CHANGE_EVENT, refresh); };
  }, [report.id, attempt]);

  const canShare = useMemo(() => {
    if (!exportResult) return false;
    try { return !!navigator.share && !!navigator.canShare?.({ files: [new File([exportResult.blob], exportResult.filename, { type: exportResult.blob.type })] }); }
    catch { return false; }
  }, [exportResult]);

  const begin = (label: string) => {
    if (locked.current || !alive.current) return false;
    locked.current = true;
    operationDone.current = new Promise<void>(resolve => { resolveOperation.current = resolve; });
    setBusy(label);
    setErrors([]);
    setNotice('');
    return true;
  };
  const finish = () => { locked.current = false; resolveOperation.current?.(); resolveOperation.current = null; if (alive.current) { setBusy(''); setProgress(null); } };
  const publish = (next: StoredSlide[]) => {
    records.current = next;
    if (alive.current) { setSlides(next); setExportResult(null); }
  };
  const flushDrafts = async () => {
    await operationDone.current;
    while (locked.current && resolveOperation.current) await operationDone.current;
    const changed = records.current.filter(slide => drafts.current[slide.id] !== undefined && drafts.current[slide.id] !== (slide.annotation || ''));
    if (!changed.length) return;
    if (!begin('正在保存批注…')) throw new Error('照片正在处理，请完成后重试。');
    try {
      const next = changed.map(slide => ({ ...slide, annotation: drafts.current[slide.id], updatedAt: Date.now() }));
      await writeSlideRecords(next);
      const byId = new Map(next.map(slide => [slide.id, slide]));
      publish(records.current.map(slide => byId.get(slide.id) || slide));
    } catch (cause) { if (alive.current) setErrors([`批注未保存：${explain(cause)}`]); throw cause; }
    finally { finish(); }
  };
  useEffect(() => { flushRef.current = flushDrafts; });
  const saveAnnotation = async () => { try { await flushDrafts(); return true; } catch { return false; } };
  const annotation = (slide: StoredSlide) => <SlideAnnotation slide={slide} disabled={disabled} draft={draftValues[slide.id] ?? slide.annotation ?? ''} onDraft={text => { drafts.current[slide.id] = text; setDraftValues({ ...drafts.current }); }} onSave={saveAnnotation} onImportant={() => void update(records.current.map(item => item.id === slide.id ? { ...item, important: !item.important, updatedAt: Date.now() } : item), '重要标记已保存。')} />;

  async function importFiles(files: File[]): Promise<boolean> {
    if (!files.length || !begin('正在导入照片…')) return false;
    let saved = 0;
    const failures: string[] = [];
    try {
      for (const [index, file] of files.entries()) {
        if (alive.current) setBusy(`正在保存 ${index + 1} / ${files.length}…`);
        try {
          const lastOrder = records.current.reduce((max, item) => Math.max(max, item.order), -1);
          const record = await storeSlidePhoto(file, report.id, lastOrder + 1);
          publish([...records.current, record]);
          saved++;
        } catch (cause) { failures.push(`${file.name || `第 ${index + 1} 张`}：${explain(cause)}`); }
      }
      if (alive.current) { setNotice(`已保存 ${saved} 张${failures.length ? `；${failures.length} 张失败，成功的照片已保留。` : '，可继续添加。'}`); setErrors(failures); }
    } catch (cause) { if (alive.current) setErrors([`照片导入失败：${explain(cause)}`]); }
    finally { finish(); }
    return saved === files.length;
  }

  const update = async (next: StoredSlide[], message: string) => {
    if (!begin('正在保存更改…')) return false;
    try {
      const previous = new Map(records.current.map(slide => [slide.id, slide]));
      await writeSlideRecords(next.filter(slide => previous.get(slide.id) !== slide));
      publish(next);
      if (alive.current) setNotice(message);
      return true;
    }
    catch (cause) { if (alive.current) setErrors([explain(cause)]); return false; }
    finally { finish(); }
  };
  const reorder = (from: number, to: number) => {
    if (from < 0 || to < 0 || from === to || to >= records.current.length) return;
    const next = [...records.current];
    next.splice(to, 0, next.splice(from, 1)[0]);
    void update(next.map((slide, order) => slide.order === order ? slide : { ...slide, order, updatedAt: Date.now() }), '照片顺序已保存，页面链接不变。');
  };
  const remove = async () => {
    if (!selected.size || !begin('正在删除选中照片…')) return;
    try {
      await removeSlideRecords([...selected]);
      publish(records.current.filter(item => !selected.has(item.id)));
      for (const id of selected) delete drafts.current[id];
      if (alive.current) { setDeleting(false); setSelected(new Set()); setNotice('选中照片、扫描版及批注已删除。'); }
    } catch (cause) { if (alive.current) setErrors([explain(cause)]); }
    finally { finish(); }
  };
  const moveSelected = async () => {
    if (!destination || !selected.size) return;
    try { await flushDrafts(); } catch { return; }
    if (!begin('正在移动照片…')) return;
    try {
      await moveSlideRecords([...selected], destination);
      publish(records.current.filter(item => !selected.has(item.id)));
      for (const id of selected) delete drafts.current[id];
      if (alive.current) { setMoving(false); setSelected(new Set()); setNotice('照片已移动到目标报告，原图、扫描版、批注和稳定链接均保留。'); }
    } catch (cause) { if (alive.current) setErrors([explain(cause)]); }
    finally { finish(); }
  };
  const scan = async () => {
    if (!begin('正在识别 PPT 边缘…')) return;
    let saved = 0, skipped = 0;
    const failures: string[] = [];
    try {
      const originals = records.current.filter(slide => selected.has(slide.id));
      for (const [index, slide] of originals.entries()) {
        if (!alive.current) break;
        setBusy(`正在扫描 ${index + 1} / ${originals.length}…`);
        try {
          const corners = await detectSlideCorners(slide.original);
          if (!corners) { skipped++; continue; }
          const result = await processSlideImage(slide.original, { corners, enhance: true });
          const next: StoredSlide = { ...slide, processed: result.blob, processedThumbnail: result.thumbnail, mode: 'processed', updatedAt: Date.now() };
          await writeSlideRecords([next]);
          publish(records.current.map(item => item.id === next.id ? next : item));
          saved++;
        } catch (cause) { failures.push(`${slide.name}：${explain(cause)}`); }
      }
      if (alive.current) { setNotice(`扫描版已保存 ${saved} 张；边缘不确定跳过 ${skipped} 张（原有版本不变），失败 ${failures.length} 张。可逐张手动校正。`); setErrors(failures); }
    } catch (cause) { if (alive.current) setErrors([explain(cause)]); }
    finally { finish(); }
  };
  const applyEdit = async (slide: StoredSlide, corners: SlideCorners, enhance: boolean, rotation: 0 | 90 | 180 | 270) => {
    if (!begin('正在校正并保存…')) return false;
    try {
      const result = await processSlideImage(slide.original, { corners, enhance, rotation });
      const current = records.current.find(item => item.id === slide.id) || slide;
      const next: StoredSlide = { ...current, processed: result.blob, processedThumbnail: result.thumbnail, mode: 'processed', updatedAt: Date.now() };
      await writeSlideRecords([next]);
      publish(records.current.map(item => item.id === slide.id ? next : item));
      if (alive.current) setNotice('扫描版已保存并选用，原图未改动。');
      return true;
    } catch (cause) { if (alive.current) setErrors([`${slide.name}：${explain(cause)}`]); return false; }
    finally { finish(); }
  };
  const exportSlides = async (format: 'pdf' | 'png') => {
    try { await flushDrafts(); } catch { return; }
    if (!records.current.length || !begin('正在生成导出文件…')) return;
    setExportResult(null);
    try {
      const result = await buildSlideExport(report, [...records.current], format, (completed, total) => { if (alive.current) setProgress({ completed, total }); });
      if (alive.current) { setExportResult(result); setNotice('导出文件已生成，请点击下方下载或分享。'); }
    } catch (cause) { if (alive.current) setErrors([`导出失败，可重新点击导出重试：${explain(cause)}`]); }
    finally { finish(); }
  };
  const share = async () => {
    if (!exportResult || shareBusy) return;
    setShareBusy(true);
    try {
      const file = new File([exportResult.blob], exportResult.filename, { type: exportResult.blob.type });
      await navigator.share({ files: [file], title: report.sourceTitle });
    } catch (cause) {
      if (alive.current && !(cause instanceof Error && cause.name === 'AbortError')) setErrors([`无法分享文件，请使用下载链接：${explain(cause)}`]);
    } finally { if (alive.current) setShareBusy(false); }
  };

  return <section className="reportSlides" aria-label="本报告 PPT 照片笔记" aria-busy={disabled}>
    <header className="slidesHeading"><h3>照片 <span>{slides.length} 张已保存</span></h3><div className="slidesActions"><button type="button" aria-pressed={view === 'read'} onClick={() => setView('read')}>阅读</button><button type="button" aria-pressed={view === 'manage'} onClick={() => setView('manage')}>管理</button><button type="button" className="slidesPrimary" disabled={disabled} onClick={() => { setErrors([]); setCamera(true); }}>拍摄 / 添加</button></div></header>
    <input className="slidesFileInput" ref={nativeInput} type="file" accept="image/*" capture="environment" aria-label="使用系统相机拍摄 PPT" disabled={disabled} onChange={event => { const files = Array.from(event.target.files || []); event.target.value = ''; void importFiles(files); }} />
    <input className="slidesFileInput" ref={galleryInput} type="file" accept="image/*" multiple aria-label="从相册选择多张 PPT 照片" disabled={disabled} onChange={event => { const files = Array.from(event.target.files || []); event.target.value = ''; void importFiles(files); }} />
    {load === 'loading' && <p role="status">正在读取照片…</p>}
    {load === 'error' && <button type="button" onClick={() => { setLoad('loading'); setErrors([]); setAttempt(value => value + 1); }}>重试读取照片</button>}
    {(busy || notice) && <p className="slidesNotice" role="status">{busy || notice}</p>}
    {progress && <div className="slidesProgress"><progress max={Math.max(1, progress.total)} value={progress.completed} aria-label="导出进度" /><span>{progress.completed} / {progress.total}</span></div>}
    {!!errors.length && <div className="slidesError" role="alert"><strong>操作未全部完成</strong><ul>{errors.map((error, index) => <li key={index}>{error}</li>)}</ul></div>}
    {load === 'ready' && !slides.length && <div className="slidesEmpty"><h4>为这场报告保存第一张照片</h4><p>拍摄或从相册多选添加。保存完成后直接连续阅读，不需要逐张确认。</p><div className="slidesActions"><button type="button" disabled={disabled} onClick={() => setCamera(true)}>连续拍摄</button><button type="button" disabled={disabled} onClick={() => galleryInput.current?.click()}>从相册添加</button></div></div>}
    {load === 'ready' && !!slides.length && <div hidden={view !== 'read'}><SlideReader key={report.id} reportId={report.id} slides={displaySlides} active={active && view === 'read' && !camera && !editing} initialSlideId={initialSlideId} renderAnnotation={slide => view === 'read' ? annotation(slide) : null} onActiveSlideChange={slide => { currentSlideId.current = slide?.id || null; onActiveSlideChange?.(slide); }} onError={message => setErrors([message])} /></div>}
    {view === 'manage' && !!slides.length && <><div className="slidesActions slidesBatchActions"><button type="button" disabled={disabled} onClick={() => setSelected(selected.size === slides.length ? new Set() : new Set(slides.map(slide => slide.id)))}>{selected.size === slides.length ? '取消全选' : '全选'}</button><span>已选 {selected.size} 张</span><button type="button" disabled={disabled || !selected.size} onClick={() => void scan()}>扫描选中</button><button type="button" disabled={disabled || !selected.size} onClick={() => { setDestination(null); setMoving(true); }}>移动到报告</button><button type="button" className="slidesDelete" disabled={disabled || !selected.size} onClick={() => setDeleting(true)}>删除选中</button></div>
      <ol className="slidesGrid">{slides.map((slide, index) => <li className="slidesCard" key={slide.id} onDragOver={event => { if (!disabled) event.preventDefault(); }} onDrop={event => { event.preventDefault(); if (!disabled && dragged.current) reorder(records.current.findIndex(item => item.id === dragged.current), index); dragged.current = null; }}>
        <div className="slidesThumbnail"><SlideThumbnail slide={slide} /><span>第 {index + 1} 页 · {slide.mode === 'processed' ? '扫描版' : '原图'}</span></div>
        <div className="slidesCardBody"><label className="slidesSelect"><input type="checkbox" disabled={disabled} checked={selected.has(slide.id)} onChange={() => setSelected(previous => { const next = new Set(previous); if (next.has(slide.id)) next.delete(slide.id); else next.add(slide.id); return next; })} />选择第 {index + 1} 页</label><strong className="slidesName">{slide.name}</strong>
          <div className="slidesVersion" role="group" aria-label={`第 ${index + 1} 张显示及导出版本`}><button type="button" disabled={disabled || slide.mode === 'original'} aria-pressed={slide.mode === 'original'} onClick={() => void update(records.current.map(item => item.id === slide.id ? { ...item, mode: 'original', updatedAt: Date.now() } : item), '已改用原图，扫描版仍保留。')}>原图</button><button type="button" disabled={disabled || !slide.processed || slide.mode === 'processed'} aria-pressed={slide.mode === 'processed'} onClick={() => void update(records.current.map(item => item.id === slide.id ? { ...item, mode: 'processed', updatedAt: Date.now() } : item), '已改用扫描版。')}>扫描版</button></div>
          <button type="button" disabled={disabled} onClick={() => { setErrors([]); setEditing(slide); }}>旋转 / 手动校正</button>
          <div className="slidesOrder"><button type="button" disabled={disabled} draggable={!disabled} onDragStart={event => { dragged.current = slide.id; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', slide.id); }} onDragEnd={() => { dragged.current = null; }} aria-label={`拖动第 ${index + 1} 页排序；也可用前移后移按钮`}>拖动排序</button><button type="button" disabled={disabled || index === 0} aria-label={`将第 ${index + 1} 页前移`} onClick={() => reorder(index, index - 1)}>前移</button><button type="button" disabled={disabled || index === slides.length - 1} aria-label={`将第 ${index + 1} 页后移`} onClick={() => reorder(index, index + 1)}>后移</button></div>
          {annotation(slide)}
        </div>
      </li>)}</ol>
      <details><summary>扫描说明</summary><p className="slidesHint">仅处理选中照片。自动扫描只处理可靠四边；反光、遮挡时可手动校正。请检查结果，增强不能恢复原图中缺失的文字。旋转和校正均保存为扫描版，原文件始终保留。</p></details></>}
    <details className="slidesExport"><summary>导出照片 · PDF / PNG</summary><p className="slidesHint">按当前顺序和所选版本导出。PDF 首页面为报告封面；PNG ZIP 内为封面和编号照片。此处只导出图片，不含批注和 OCR 文字；图文批注请使用笔记本的整本导出。处理可能为内存安全缩放，原文件仍保留。</p><div className="slidesActions"><button type="button" disabled={disabled || !slides.length} onClick={() => void exportSlides('pdf')}>生成 PDF</button><button type="button" disabled={disabled || !slides.length} onClick={() => void exportSlides('png')}>生成 PNG 图片包</button></div>
      {exportResult && exportUrl && <div className="slidesExportReady"><strong>文件已准备好</strong><span>{exportResult.filename}</span><div className="slidesActions"><a className="slidesDownload" href={exportUrl} download={exportResult.filename}>下载文件（{(exportResult.blob.size / 1024 / 1024).toFixed(1)} MB）</a>{canShare && <button type="button" disabled={shareBusy} onClick={() => void share()}>{shareBusy ? '正在分享…' : '分享文件'}</button>}</div><small>修改照片后需重新生成文件。</small></div>}
    </details>
    <details className="slidesPrivacy"><summary>本机存储与隐私</summary><p className="slidesHint">照片保存在本浏览器，不上传，不跨设备同步。清除网站数据、结束无痕浏览或浏览器回收存储可能导致丢失，请及时使用资料库完整备份。导入格式、大小限制与原照片处理规则不变；不支持的格式会明确报错。</p></details>
    {camera && <SlideCamera report={report} slides={slides} pending={!!busy} saveErrors={errors} onClose={() => setCamera(false)} onNative={() => nativeInput.current?.click()} onGallery={() => galleryInput.current?.click()} onCapture={file => importFiles([file])} />}
    {editing && <SlideEditor saveErrors={errors} slide={editing} onClose={() => setEditing(null)} onApply={(corners, enhance, rotation) => applyEdit(editing, corners, enhance, rotation)} />}
    {moving && createPortal(<div className="slidesOverlay slidesMoveOverlay" role="dialog" aria-modal="true" aria-labelledby="slidesMoveTitle"><div className="slidesDialog"><header><h3 id="slidesMoveTitle">移动 {selected.size} 张照片到报告</h3><button type="button" disabled={disabled} onClick={() => setMoving(false)}>取消</button></header><label className="slidesMoveSearch">搜索报告标题、讲者或领域<input type="search" value={moveQuery} onChange={event => setMoveQuery(event.target.value)} /></label><p className="slidesHint">保留照片 ID、原图、扫描版和批注，追加到目标报告末尾。</p><div className="slidesMoveResults">{moveMatches.map(item => <button type="button" key={item.report.id} disabled={disabled} aria-pressed={destination === item.report.id} onClick={() => setDestination(item.report.id)}><strong>{item.report.sourceTitle}</strong><small>{item.report.speaker} · {item.report.field}</small></button>)}{!moveMatches.length && <p>没有匹配的报告，请换个关键词。</p>}</div>{!!errors.length && <p className="slidesError" role="alert">{errors.join('；')}</p>}<button type="button" className="slidesPrimary" disabled={disabled || destination === null} onClick={() => void moveSelected()}>{busy || '确认移动'}</button></div></div>, document.body)}
    {deleting && createPortal(<div className="slidesOverlay slidesDeleteOverlay" role="dialog" aria-modal="true" aria-labelledby="slidesDeleteTitle"><div className="slidesDialog"><h3 id="slidesDeleteTitle">永久删除选中的 {selected.size} 张照片？</h3><p>原图、扫描版和本页批注都会从本机删除，无法撤销。文字笔记中的页面链接将不再可用。</p>{!!errors.length && <p className="slidesError" role="alert">{errors.join('；')}</p>}<div className="slidesActions"><button type="button" disabled={disabled} onClick={() => setDeleting(false)}>取消</button><button type="button" className="slidesDelete" disabled={disabled} onClick={() => void remove()}>{busy || '确认永久删除'}</button></div></div></div>, document.body)}
  </section>;
}
