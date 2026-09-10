'use client';
import { deferred } from '../lib/deferred';
import { useDialog } from '../lib/useDialog';


import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import type { Editor } from '@tiptap/core';
import Image from '@tiptap/extension-image';
import {
  loadStoredNote,
  persistStoredNote,
  stageStoredNote,
  readRecordingRecords,
  removeRecordingRecord,
  writeRecordingRecord,
  type StoredRecording,
  readLibraryMeta,
  updateLibraryMeta,
  readSlideRecord,
  readSlideRecords,
  type LibraryMeta,
} from '../lib/noteStorage';
import { TextStyleKit } from '@tiptap/extension-text-style';
import Underline from '@tiptap/extension-underline';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { createPortal } from 'react-dom';
import type { Report } from '../lib/reports';
import ReportSlides from './ReportSlides';
import { BrandLockup, HuiduQrCallout } from './BrandLockup';
import { renderPdf } from './ExportCenter';
import { imageToPng } from '../lib/slideImages';
import { NOTEBOOK_OPEN_EVENT, requestNotebook, type NotebookOpenOptions, type NotebookSection } from '../lib/libraryTypes';
import './notebook.css';

const MAX_RECORDING_MS = 10 * 60 * 1000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;


type RecordingItem = StoredRecording & { url: string };
type RecordingStatus = 'idle' | 'requesting' | 'recording' | 'saving';
type SaveStatus = 'loading' | 'saved' | 'pending' | 'error';
type ManualSaveStatus = 'idle' | 'saving' | 'saved' | 'error';
type RecordingController = {
  items: RecordingItem[];
  status: RecordingStatus;
  elapsedMs: number;
  error: string;
  loaded: boolean;
  startRecording: () => Promise<void>;
  stopRecording: () => void;
  renameRecording: (id: string, title: string) => Promise<void>;
  deleteRecording: (id: string) => Promise<void>;
  flush: () => Promise<boolean>;
};


function storedRecording(item: RecordingItem): StoredRecording {
  return {
    id: item.id,
    reportId: item.reportId,
    title: item.title,
    blob: item.blob,
    mimeType: item.mimeType,
    durationMs: item.durationMs,
    createdAt: item.createdAt,
  };
}

function formatDuration(durationMs: number) {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function recordingExtension(mimeType: string) {
  if (mimeType.includes('mp4')) return 'm4a';
  if (mimeType.includes('ogg')) return 'ogg';
  if (mimeType.includes('wav')) return 'wav';
  return 'webm';
}

function safeFilename(value: string) {
  return value.trim().replace(/[\\/:*?"<>|]/g, '-').slice(0, 80) || '未命名录音';
}

function preferredAudioMimeType() {
  const candidates = [
    'audio/mp4;codecs=mp4a.40.2',
    'audio/webm;codecs=opus',
    'audio/ogg;codecs=opus',
    'audio/webm',
  ];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? '';
}

async function imageFileToDataUrl(file: File) {
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type)) {
    throw new Error('请选择 JPG、PNG、WebP 或 GIF 图片。');
  }
  if (file.size > MAX_IMAGE_BYTES) throw new Error('单张图片不能超过 8 MB。');

  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1800 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext('2d');
  if (!context) {
    bitmap.close();
    throw new Error('浏览器无法处理这张图片。');
  }
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL(file.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.88);
}

async function waitForImages(root: HTMLElement) {
  await Promise.all(Array.from(root.querySelectorAll('img')).map(async (image) => {
    if (!image.complete) {
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
          window.clearTimeout(timer);
          image.removeEventListener('load', loaded);
          image.removeEventListener('error', failed);
          if (error) reject(error); else resolve();
        };
        const loaded = () => finish();
        const failed = () => finish(new Error('图片无法载入，请修复后重新导出。'));
        const timer = window.setTimeout(() => finish(new Error('图片载入超时，请重试。')), 20000);
        image.addEventListener('load', loaded, { once: true });
        image.addEventListener('error', failed, { once: true });
        if (image.complete) { if (image.naturalWidth) loaded(); else failed(); }
      });
    }
    if (!image.naturalWidth) throw new Error('图片无法载入，请修复后重新导出。');
    await image.decode();
  }));
}

const ColoredUnderline = Underline.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      underlineColor: {
        default: null,
        parseHTML: (element) => element.style.textDecorationColor || null,
        renderHTML: (attributes) => attributes.underlineColor
          ? { style: `text-decoration-color: ${attributes.underlineColor}` }
          : {},
      },
    };
  },
});

const EDITOR_EXTENSIONS = [
  StarterKit.configure({
    heading: { levels: [1, 2, 3] },
    underline: false,
    link: { openOnClick: false },
  }),
  TextStyleKit,
  ColoredUnderline,
  Image.configure({
    allowBase64: true,
    HTMLAttributes: { class: 'noteEmbeddedImage' },
  }),
];

function NoteToolbar({ editor, onInsertImage, onInsertSlide, canLinkSlide }: {
  editor: Editor;
  onInsertImage: () => void;
  onInsertSlide: () => void;
  canLinkSlide: boolean;
}) {
  const heading = editor.isActive('heading', { level: 1 })
    ? '1'
    : editor.isActive('heading', { level: 2 })
      ? '2'
      : editor.isActive('heading', { level: 3 }) ? '3' : '0';
  const textStyle = editor.getAttributes('textStyle');

  return (
    <div className="noteToolbar" role="toolbar" aria-label="笔记格式工具栏">
      <label className="noteToolbarSelect">
        <span>标题</span>
        <select
          value={heading}
          onChange={(event) => {
            const level = Number(event.target.value);
            if (level === 0) editor.chain().focus().setParagraph().run();
            else editor.chain().focus().setHeading({ level: level as 1 | 2 | 3 }).run();
          }}
          aria-label="段落与标题级别"
        >
          <option value="0">正文</option>
          <option value="1">一级标题</option>
          <option value="2">二级标题</option>
          <option value="3">三级标题</option>
        </select>
      </label>
      <label className="noteToolbarSelect">
        <span>字体</span>
        <select
          value={textStyle.fontFamily ?? ''}
          onChange={(event) => {
            const value = event.target.value;
            if (value) editor.chain().focus().setFontFamily(value).run();
            else editor.chain().focus().unsetFontFamily().run();
          }}
          aria-label="字体"
        >
          <option value="">默认字体</option>
          <option value="Microsoft YaHei">微软雅黑</option>
          <option value="SimSun">宋体</option>
          <option value="KaiTi">楷体</option>
          <option value="Arial">Arial</option>
          <option value="Georgia">Georgia</option>
        </select>
      </label>
      <label className="noteToolbarSelect isCompact">
        <span>字号</span>
        <select
          value={textStyle.fontSize ?? ''}
          onChange={(event) => {
            const value = event.target.value;
            if (value) editor.chain().focus().setFontSize(value).run();
            else editor.chain().focus().unsetFontSize().run();
          }}
          aria-label="字号"
        >
          <option value="">默认</option>
          {[12, 14, 16, 18, 22, 28, 36].map((size) => (
            <option value={`${size}px`} key={size}>{size}px</option>
          ))}
        </select>
      </label>
      <div className="noteToolbarButtons">
        <button type="button" className={editor.isActive('bold') ? 'isActive' : ''} onClick={() => editor.chain().focus().toggleBold().run()} aria-label="粗体" title="粗体">B</button>
        <button type="button" className={editor.isActive('italic') ? 'isActive' : ''} onClick={() => editor.chain().focus().toggleItalic().run()} aria-label="斜体" title="斜体"><i>I</i></button>
        <button type="button" className={editor.isActive('underline') ? 'isActive' : ''} onClick={() => editor.chain().focus().toggleUnderline().run()} aria-label="下划线" title="下划线"><u>U</u></button>
        <button type="button" className={editor.isActive('orderedList') ? 'isActive' : ''} onClick={() => editor.chain().focus().toggleOrderedList().run()} aria-label="有序列表" title="有序列表">1.</button>
        <button type="button" className={editor.isActive('bulletList') ? 'isActive' : ''} onClick={() => editor.chain().focus().toggleBulletList().run()} aria-label="无序列表" title="无序列表">•</button>
      </div>
      <div className="noteColorTools">
        <label title="字体颜色"><span style={{ color: '#002fa7' }}>A</span><input type="color" defaultValue="#071b56" onChange={(event) => editor.chain().focus().setColor(event.target.value).run()} aria-label="字体颜色" /></label>
        <label title="高亮颜色"><span className="highlightSwatch">A</span><input type="color" defaultValue="#dce7ff" onChange={(event) => editor.chain().focus().setBackgroundColor(event.target.value).run()} aria-label="高亮颜色" /></label>
        <label title="下划线颜色"><span className="underlineSwatch">U</span><input type="color" defaultValue="#002fa7" onChange={(event) => editor.chain().focus().setUnderline().updateAttributes('underline', { underlineColor: event.target.value }).run()} aria-label="下划线颜色" /></label>
      </div>
      <div className="noteToolbarButtons noteToolbarUtility">
        <button type="button" onClick={onInsertImage} aria-label="在光标位置插入图片" title="插入图片">图片＋</button>
        <button type="button" onClick={onInsertSlide} disabled={!canLinkSlide} title="插入当前 PPT 的固定链接，排序或移动后仍可定位">引用当前 PPT</button>
        <button type="button" onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().run()} aria-label="清除格式" title="清除格式">清格式</button>
        <button type="button" disabled={!editor.can().chain().focus().undo().run()} onClick={() => editor.chain().focus().undo().run()} aria-label="撤销" title="撤销">↶</button>
        <button type="button" disabled={!editor.can().chain().focus().redo().run()} onClick={() => editor.chain().focus().redo().run()} aria-label="重做" title="重做">↷</button>
      </div>
    </div>
  );
}

function RecordingCard({ item, onRename, onDelete }: {
  item: RecordingItem;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
}) {
  const extension = recordingExtension(item.mimeType);
  return (
    <article className="recordingCard">
      <div className="recordingIndex" aria-hidden>REC</div>
      <div className="recordingContent">
        <input
          defaultValue={item.title}
          aria-label="录音标题"
          onBlur={(event) => onRename(item.id, event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
        />
        <div className="recordingMeta">
          <span>{formatDuration(item.durationMs)}</span>
          <span>{new Date(item.createdAt).toLocaleString('zh-CN')}</span>
          <span>{extension.toUpperCase()}</span>
        </div>
        <audio controls preload="metadata" src={item.url}>当前浏览器不支持音频播放。</audio>
      </div>
      <div className="recordingActions">
        <a href={item.url} download={`${safeFilename(item.title)}.${extension}`}>下载</a>
        <button type="button" onClick={() => onDelete(item.id)}>删除</button>
      </div>
    </article>
  );
}

function useRecordings(reportId: number) {
  const [items, setItems] = useState<RecordingItem[]>([]);
  const [status, setStatus] = useState<RecordingStatus>('idle');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const itemsRef = useRef<RecordingItem[]>([]);
  const mountedRef = useRef(false);
  const recordingRequestedRef = useRef(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const segmentStartedAtRef = useRef(0);
  const rotationTimerRef = useRef<number | null>(null);
  const elapsedTimerRef = useRef<number | null>(null);
  const nextRecordingNumberRef = useRef(1);
  const pendingWritesRef = useRef(new Set<Promise<unknown>>());
  const unsavedRef = useRef(new Map<string, StoredRecording>());
  const readFailedRef = useRef(false);

  async function saveRecording(record: StoredRecording) {
    unsavedRef.current.set(record.id, record);
    const operation = writeRecordingRecord(record);
    pendingWritesRef.current.add(operation);
    try {
      await operation;
      if (unsavedRef.current.get(record.id) === record) unsavedRef.current.delete(record.id);
    } finally {
      pendingWritesRef.current.delete(operation);
    }
  }

  async function flush() {
    if (!loaded || recordingRequestedRef.current || recorderRef.current?.state === 'recording') return false;
    await Promise.allSettled([...pendingWritesRef.current]);
    try {
      if (readFailedRef.current) await readRecordingRecords(reportId);
      readFailedRef.current = false;
      for (const record of [...unsavedRef.current.values()]) await saveRecording(record);
      return true;
    } catch {
      setError('录音尚未全部保存，未生成 PDF。请先下载未保存的录音并重试。');
      return false;
    }
  }

  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;
    const warn = (event: BeforeUnloadEvent) => {
      if (unsavedRef.current.size || pendingWritesRef.current.size || recordingRequestedRef.current) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    readRecordingRecords(reportId).then((records) => {
      const loadedItems = records.map((record) => ({ ...record, url: URL.createObjectURL(record.blob) }));
      if (cancelled) {
        loadedItems.forEach((item) => URL.revokeObjectURL(item.url));
        return;
      }
      itemsRef.current = loadedItems;
      nextRecordingNumberRef.current = loadedItems.length + 1;
      setItems(loadedItems);
      setLoaded(true);
    }).catch(() => {
      if (!cancelled) {
        readFailedRef.current = true;
        setError('浏览器无法读取已保存的录音；新录音仍可在本次页面中下载。');
        setLoaded(true);
      }
    });

    return () => {
      window.removeEventListener('beforeunload', warn);
      cancelled = true;
      mountedRef.current = false;
      recordingRequestedRef.current = false;
      if (rotationTimerRef.current !== null) window.clearTimeout(rotationTimerRef.current);
      if (elapsedTimerRef.current !== null) window.clearInterval(elapsedTimerRef.current);
      const recorder = recorderRef.current;
      if (recorder?.state === 'recording' || recorder?.state === 'paused') recorder.stop();
      else streamRef.current?.getTracks().forEach((track) => track.stop());
      itemsRef.current.forEach((item) => URL.revokeObjectURL(item.url));
    };
  }, [reportId]);

  async function persistSegment(blob: Blob, mimeType: string, durationMs: number) {
    const createdAt = Date.now();
    const number = nextRecordingNumberRef.current++;
    const record: StoredRecording = {
      id: crypto.randomUUID(),
      reportId,
      title: `录音 ${String(number).padStart(2, '0')} · ${new Date(createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`,
      blob,
      mimeType,
      durationMs,
      createdAt,
    };
    try {
      await saveRecording(record);
    } catch {
      if (mountedRef.current) setError('这段录音未能写入浏览器存储，请在关闭页面前下载。');
    }
    if (!mountedRef.current) return;
    const item = { ...record, url: URL.createObjectURL(record.blob) };
    const nextItems = [...itemsRef.current, item];
    itemsRef.current = nextItems;
    setItems(nextItems);
  }

  function startSegment(stream: MediaStream) {
    if (!recordingRequestedRef.current) return;
    const preferredMimeType = preferredAudioMimeType();
    let recorder: MediaRecorder;
    try {
      recorder = preferredMimeType
        ? new MediaRecorder(stream, { mimeType: preferredMimeType })
        : new MediaRecorder(stream);
    } catch {
      recordingRequestedRef.current = false;
      stream.getTracks().forEach((track) => track.stop());
      if (mountedRef.current) {
        setStatus('idle');
        setError('当前浏览器无法创建音频录制器。');
      }
      return;
    }

    recorderRef.current = recorder;
    chunksRef.current = [];
    segmentStartedAtRef.current = Date.now();
    if (rotationTimerRef.current !== null) window.clearTimeout(rotationTimerRef.current);
    if (elapsedTimerRef.current !== null) window.clearInterval(elapsedTimerRef.current);

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };
    recorder.onerror = () => {
      recordingRequestedRef.current = false;
      if (mountedRef.current) setError('录音过程中发生错误，已尝试保存当前片段。');
    };
    recorder.onstop = () => {
      if (rotationTimerRef.current !== null) window.clearTimeout(rotationTimerRef.current);
      if (elapsedTimerRef.current !== null) window.clearInterval(elapsedTimerRef.current);
      rotationTimerRef.current = null;
      elapsedTimerRef.current = null;
      const durationMs = Math.min(MAX_RECORDING_MS, Date.now() - segmentStartedAtRef.current);
      const mimeType = recorder.mimeType || preferredMimeType || 'audio/webm';
      const blob = new Blob(chunksRef.current, { type: mimeType });
      const shouldContinue = recordingRequestedRef.current
        && stream.getAudioTracks().some((track) => track.readyState === 'live');

      const segmentSave = blob.size > 0 ? persistSegment(blob, mimeType, durationMs) : Promise.resolve();
      if (!blob.size && mountedRef.current) setError('当前片段没有收到音频数据，未创建空录音。');

      const finishSession = () => {
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        recorderRef.current = null;
        if (mountedRef.current) {
          setElapsedMs(0);
          setStatus('saving');
          void segmentSave.finally(async () => {
            await Promise.allSettled([...pendingWritesRef.current]);
            if (mountedRef.current) setStatus('idle');
          });
        }
      };
      if (shouldContinue) {
        queueMicrotask(() => {
          const canContinue = recordingRequestedRef.current
            && stream.getAudioTracks().some((track) => track.readyState === 'live');
          if (canContinue) startSegment(stream);
          else finishSession();
        });
      } else {
        finishSession();
      }
    };

    try {
      recorder.start(1000);
    } catch {
      recordingRequestedRef.current = false;
      stream.getTracks().forEach((track) => track.stop());
      if (mountedRef.current) {
        setStatus('idle');
        setError('麦克风已连接，但浏览器未能开始录音。');
      }
      return;
    }

    if (mountedRef.current) {
      setError('');
      setElapsedMs(0);
      setStatus('recording');
    }
    elapsedTimerRef.current = window.setInterval(() => {
      if (mountedRef.current) {
        setElapsedMs(Math.min(MAX_RECORDING_MS, Date.now() - segmentStartedAtRef.current));
      }
    }, 500);
    rotationTimerRef.current = window.setTimeout(() => {
      if (recorder.state === 'recording' && recordingRequestedRef.current) recorder.stop();
    }, MAX_RECORDING_MS);
  }

  async function startRecording() {
    if (!loaded || status !== 'idle') return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError('当前浏览器不支持录音，请使用最新版 Chrome、Edge 或 Safari。');
      return;
    }
    recordingRequestedRef.current = true;
    setError('');
    setStatus('requesting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!recordingRequestedRef.current || !mountedRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      stream.getAudioTracks().forEach((track) => {
        track.addEventListener('ended', () => {
          if (!recordingRequestedRef.current) return;
          recordingRequestedRef.current = false;
          if (mountedRef.current) setError('麦克风连接已中断，当前录音已停止。');
          const recorder = recorderRef.current;
          if (recorder?.state === 'recording' || recorder?.state === 'paused') recorder.stop();
        }, { once: true });
      });
      startSegment(stream);
    } catch (caught) {
      recordingRequestedRef.current = false;
      if (mountedRef.current) {
        setStatus('idle');
        setError(caught instanceof DOMException && caught.name === 'NotAllowedError'
          ? '没有获得麦克风权限。请在浏览器地址栏中允许后重试。'
          : '无法连接麦克风，请检查系统输入设备。');
      }
    }
  }

  function stopRecording() {
    recordingRequestedRef.current = false;
    if (rotationTimerRef.current !== null) window.clearTimeout(rotationTimerRef.current);
    const recorder = recorderRef.current;
    if (recorder?.state === 'recording' || recorder?.state === 'paused') {
      setStatus('saving');
      recorder.stop();
    }
  }

  async function renameRecording(id: string, nextTitle: string) {
    const item = itemsRef.current.find((candidate) => candidate.id === id);
    if (!item) return;
    const title = nextTitle.trim() || '未命名录音';
    const updated = { ...item, title };
    const nextItems = itemsRef.current.map((candidate) => candidate.id === id ? updated : candidate);
    itemsRef.current = nextItems;
    setItems(nextItems);
    try {
      await saveRecording(storedRecording(updated));
    } catch {
      setError('录音标题未能写入浏览器存储。');
    }
  }

  async function deleteRecording(id: string) {
    const item = itemsRef.current.find((candidate) => candidate.id === id);
    if (!item || !window.confirm(`删除“${item.title}”？此操作无法撤销。`)) return;
    try {
      await Promise.allSettled([...pendingWritesRef.current]);
      const operation = removeRecordingRecord(id);
      pendingWritesRef.current.add(operation);
      try { await operation; } finally { pendingWritesRef.current.delete(operation); }
      unsavedRef.current.delete(id);
      URL.revokeObjectURL(item.url);
      const nextItems = itemsRef.current.filter((candidate) => candidate.id !== id);
      itemsRef.current = nextItems;
      setItems(nextItems);
    } catch {
      setError('录音删除失败，请刷新后重试。');
    }
  }

  return {
    items,
    status,
    elapsedMs,
    error,
    loaded,
    startRecording,
    stopRecording,
    renameRecording,
    deleteRecording,
    flush,
  };
}

function RecordingPanel({ recordings }: {
  recordings: RecordingController;
}) {
  const isRecording = recordings.status === 'recording';
  const isBusy = recordings.status === 'requesting' || recordings.status === 'saving';
  const statusText = recordings.status === 'requesting'
    ? '正在等待麦克风权限…'
    : recordings.status === 'saving'
      ? '正在保存当前片段…'
      : isRecording
        ? `正在录音 ${formatDuration(recordings.elapsedMs)} / 10:00`
        : '每段最长 10 分钟；到时自动保存，并立即继续下一段。';

  return (
    <section className="audioNoteSection" aria-labelledby="audio-note-title">
      <div className="audioNoteHeading">
        <div>
          <span className="sectionKicker">本机录制 · 自动分段</span>
          <h4 id="audio-note-title">录音笔记</h4>
        </div>
        <span>{recordings.items.length} 条录音</span>
      </div>
      <p className="microphonePermissionNotice">
        <span aria-hidden>MIC</span>
        <strong>麦克风录音需要浏览器授权。</strong>
        <small>首次使用时，请在浏览器的权限提示中选择“允许”。</small>
      </p>
      <div className={`recorderConsole ${isRecording ? 'isRecording' : ''}`}>
        <button
          type="button"
          className="recordButton"
          disabled={!recordings.loaded || isBusy}
          onClick={isRecording ? recordings.stopRecording : recordings.startRecording}
          aria-label={isRecording ? '停止并保存录音' : '开始录音'}
        >
          <span aria-hidden>{isRecording ? '■' : '●'}</span>
          {isRecording ? '停止并保存' : '开始录音'}
        </button>
        <div className="recordingStatus" aria-live="polite">
          <strong>{statusText}</strong>
          <div><span style={{ width: `${Math.min(100, recordings.elapsedMs / MAX_RECORDING_MS * 100)}%` }} /></div>
          <small>保存格式：M4A / WebM / OGG（由当前浏览器决定）</small>
        </div>
      </div>
      {recordings.error && <p className="recordingError" role="alert">{recordings.error}</p>}
      {recordings.items.length > 0 && (
        <div className="recordingList">
          {recordings.items.map((item) => (
            <RecordingCard
              key={item.id}
              item={item}
              onRename={recordings.renameRecording}
              onDelete={recordings.deleteRecording}
            />
          ))}
        </div>
      )}
    </section>
  );
}

type ExportPhoto = { id: string; name: string; src: string; annotation: string; important: boolean; mode: 'original' | 'processed'; createdAt: number };
type NoteExportSnapshot = {
  html: string;
  textLength: number;
  recordings: StoredRecording[];
  photos: ExportPhoto[];
  meta: LibraryMeta;
};

function SingleNoteDocument({ report, html, textLength, recordings, photos, meta }: NoteExportSnapshot & { report: Report }) {
  return (
    <div className="pdfDocument singleNoteDocument singleNotePagedDocument">
      <header className="singleNotePageChromeHeader" data-pdf-page-header>
        <BrandLockup compact />
        <div>
          <span>NEURO 2026 · REPORT NOTE</span>
          <b>{report.speaker} · {report.field}</b>
        </div>
      </header>
      <main className="singleNotePageContent" data-pdf-page-content>
        <header className="singleNoteHeader" data-pdf-keep>
          <div><span>NEURO 2026 · REPORT NOTE</span><h1>单场听会笔记</h1></div>
        </header>
        <section className="singleNoteReport notebookPdfMetadata">
          <small>{report.field} · {report.directions.join(' / ')}</small>
          <h2>{report.sourceTitle}</h2>
          <div>
            <span><i>时间</i>{report.dateTime}</span>
            <span><i>报告人</i>{report.speaker}</span>
            <span><i>单位</i>{report.institution}</span>
            <span><i>地点</i>{report.location || '未公布'}</span>
            <span><i>报告 ID / 小节编号</i>{report.id} / {report.abstractNo || '未提供'}</span>
            <span><i>日程类别 / 类型</i>{report.scheduleCategory} / {report.kind || '日程未提供'}</span>
            <span><i>专场</i>{report.program}</span>
            <span><i>Session</i>{report.session || '无'}</span>
            <span><i>主持</i>{report.chairman || '日程未提供'}</span>
            <span><i>个人标签</i>{meta.tags.join('、') || '无'}</span>
            <span className="notebookPdfOfficial"><i>原始日程表</i>2026神经病学年会日程.xlsx · 全部日程 · 第 {report.sourceRow} 行</span>
          </div>
        </section>
        <section className="singleNoteBody singleNoteRichBody">
          <header data-pdf-keep><span>MY NOTES</span><b>{textLength} 字 · {photos.length} 张 PPT · {recordings.length} 条录音</b></header>
          <div className="noteRichContent singleNoteRichText" dangerouslySetInnerHTML={{ __html: html || '<p></p>' }} />
        </section>
        {photos.length > 0 && (
          <section className="notebookPdfSlides">
            <h2 data-pdf-keep>PPT 照片 · 当前顺序</h2>
            {photos.map((photo, index) => (
              <article key={photo.id}>
                <figure data-pdf-keep>
                  <figcaption><b>{index + 1}. {photo.name}</b>{photo.important && <strong>重要</strong>}<span>{photo.mode === 'processed' ? '扫描版' : '原图'} · {new Date(photo.createdAt).toLocaleString('zh-CN')}</span></figcaption>
                  <img src={photo.src} alt={`第 ${index + 1} 张 PPT：${photo.name}`} />
                </figure>
                <p className="notebookPdfPhotoId">固定引用 ID：{photo.id}</p>
                {photo.annotation && <div className="notebookPdfAnnotation"><b>批注</b><p>{photo.annotation}</p></div>}
              </article>
            ))}
          </section>
        )}
        {recordings.length > 0 && (
          <section className="pdfRecordingList">
            <header data-pdf-keep><span>AUDIO NOTES</span><b>{recordings.length} 条</b></header>
            <p className="notebookPdfAudioNotice">此 PDF 仅列出录音信息，不能播放音频。音频文件随“资料库完整备份”保存；请同时下载完整备份，以便恢复、播放或迁移。</p>
            {recordings.map((recording, index) => (
              <div key={recording.id} data-pdf-keep>
                <b>{String(index + 1).padStart(2, '0')}</b>
                <span>{recording.title}</span>
                <small>{formatDuration(recording.durationMs)} · {new Date(recording.createdAt).toLocaleString('zh-CN')} · {recording.mimeType}</small>
              </div>
            ))}
          </section>
        )}
      </main>
      <footer className="singleNotePageChromeFooter" data-pdf-page-footer>
        <HuiduQrCallout compact />
        <span>保存于 {new Date().toLocaleDateString('zh-CN')}</span>
        <b aria-hidden="true" />
      </footer>
    </div>
  );
}

function SingleNoteExport({ report, html, textLength, recordings, photos, meta, onClose }: NoteExportSnapshot & {
  report: Report;
  onClose: () => void;
}) {
  const [stage, setStage] = useState<'generating' | 'preview' | 'error'>('generating');
  const [pdfUrl, setPdfUrl] = useState('');
  const [previewImages, setPreviewImages] = useState<string[]>([]);
  const [portalReady, setPortalReady] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  useDialog('.singleNoteExportOverlay', onClose, portalReady);
  const sourceRef = useRef<HTMLDivElement>(null);
  const filename = `NEURO2026-${safeFilename(report.speaker)}-听会笔记.pdf`;

  useEffect(() => {
    const frame = requestAnimationFrame(() => setPortalReady(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => () => {
    if (pdfUrl) URL.revokeObjectURL(pdfUrl);
  }, [pdfUrl]);

  useEffect(() => {
    if (!portalReady || !sourceRef.current) return;
    let cancelled = false;
    const source = sourceRef.current;
    const build = async () => {
      try {
        await document.fonts?.ready;
        await waitForImages(source);
        source.classList.add('isCapturing');
        const { promise, resolve } = deferred<void>();
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        await promise;
        const rect = source.getBoundingClientRect();
        if (rect.width < 500 || rect.height < 500 || rect.left < -1) {
          throw new Error('Single-note PDF source is unavailable.');
        }
        const { blob, previews } = await renderPdf(source, rect, {
          preserveBrowserTextLayout: true,
          repeatingPageChrome: {
            contentSelector: '[data-pdf-page-content]',
            headerSelector: '[data-pdf-page-header]',
            footerSelector: '[data-pdf-page-footer]',
          },
        });
        if (blob.size < 8000) throw new Error('Single-note PDF is unexpectedly small.');
        if (cancelled) return;
        setPdfUrl(URL.createObjectURL(blob));
        setPreviewImages(previews);
        setStage('preview');
      } catch (error) {
        console.error(error);
        if (!cancelled) {
          setErrorMessage(error instanceof Error ? error.message : 'PDF 生成失败。');
          setStage('error');
        }
      } finally {
        source.classList.remove('isCapturing');
      }
    };
    void build();
    return () => {
      cancelled = true;
    };
  }, [portalReady]);

  const print = () => {
    const frame = document.querySelector<HTMLIFrameElement>('.singleNotePrintFrame');
    frame?.contentWindow?.focus();
    frame?.contentWindow?.print();
  };

  const dialog = (
    <div className="exportOverlay singleNoteExportOverlay" role="dialog" aria-modal="true" aria-label="导出单场听会笔记">
      <div className="exportModal previewMode">
        <header className="exportTop">
          <div><span>ONE REPORT · AUTO PAGINATION</span><h2>导出听会笔记</h2></div>
          <button onClick={onClose} aria-label="关闭笔记导出">×</button>
        </header>
        {stage === 'generating' && (
          <div className="exportGenerating">
            <span className="generatingOrb">PDF</span>
            <h3>正在排版并自动分页</h3>
            <p>报告信息、富文本、按当前顺序排列的 PPT 与批注、录音清单将自动分页。</p>
          </div>
        )}
        {stage === 'error' && (
          <div className="exportError">
            <b>生成没有完成</b>
            <p>{errorMessage} 笔记已保存在浏览器中，可以关闭后重新尝试。</p>
            <button onClick={onClose}>关闭</button>
          </div>
        )}
        {stage === 'preview' && (
          <div className="previewArea">
            <div className="previewToolbar">
              <div><b>{previewImages.length} 页 PDF 预览</b><span>{filename}</span></div>
              <a href={pdfUrl} download={filename}>保存到本地 ↓</a>
              <button className="printButton" onClick={print}>打印 ↗</button>
            </div>
            <div className="pdfPreviewPages">
              {previewImages.map((image, index) => (
                <figure key={index}>
                  <img src={image} alt={`${filename} 第 ${index + 1} 页`} />
                  <figcaption>{index + 1} / {previewImages.length}</figcaption>
                </figure>
              ))}
            </div>
            <iframe className="pdfPrintFrame singleNotePrintFrame" src={pdfUrl} title={`${filename} 打印文件`} />
          </div>
        )}
      </div>
    </div>
  );

  return portalReady
    ? createPortal(
      <>
        {dialog}
        <div className="pdfSource" aria-hidden="true" ref={sourceRef}>
          <SingleNoteDocument report={report} html={html} textLength={textLength} recordings={recordings} photos={photos} meta={meta} />
        </div>
      </>,
      document.body,
    )
    : null;
}

export default function ReportNotes({ report, initialSection, initialMode = 'read', autoCapture = false, initialSlideId }: {
  report: Report;
  initialSection?: NotebookSection;
  initialMode?: 'read' | 'edit';
  autoCapture?: boolean;
  initialSlideId?: string;
}) {
  const [section, setSection] = useState<NotebookSection>(autoCapture || initialSlideId ? 'slides' : initialSection ?? 'text');
  const [mode, setMode] = useState(initialMode);
  const intent = `${initialMode}|${initialSection || ''}|${autoCapture}|${initialSlideId || ''}`;
  const [previousIntent, setPreviousIntent] = useState(intent);
  if (intent !== previousIntent) {
    setPreviousIntent(intent);
    setMode(initialMode);
    if (autoCapture || initialSlideId || initialSection) setSection(autoCapture || initialSlideId ? 'slides' : initialSection!);
  }
  const [desktop, setDesktop] = useState(false);
  const [textLength, setTextLength] = useState(0);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('loading');
  const [savedAt, setSavedAt] = useState(0);
  const [manualSaveStatus, setManualSaveStatus] = useState<ManualSaveStatus>('idle');
  const [message, setMessage] = useState('');
  const [tags, setTags] = useState('');
  const [tagStatus, setTagStatus] = useState<SaveStatus>('loading');
  const [metaLoaded, setMetaLoaded] = useState(false);
  const [slideCount, setSlideCount] = useState(0);
  const [currentSlide, setCurrentSlide] = useState<{ id: string; index: number } | null>(null);
  const [exportSnapshot, setExportSnapshot] = useState<NoteExportSnapshot | null>(null);
  const [exportProgress, setExportProgress] = useState('');
  const imageInputRef = useRef<HTMLInputElement>(null);
  const textPaneRef = useRef<HTMLDivElement>(null);
  const audioPaneRef = useRef<HTMLDivElement>(null);
  const latestHtmlRef = useRef('<p></p>');
  const initialViewRef = useRef({ section: initialSection, capture: autoCapture, slideId: initialSlideId });
  const dirtyRef = useRef(false);
  const loadedRef = useRef(false);
  const tagsRef = useRef('');
  const tagsDirtyRef = useRef(false);
  const textOffsetRef = useRef(0);
  const restoreTextRef = useRef(false);
  const explicitSectionRef = useRef(Boolean(initialSection || initialSlideId || autoCapture));
  const saveTimerRef = useRef<number | null>(null);
  const readingTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(false);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const recordings = useRecordings(report.id);
  const slidesVisible = section === 'slides' || (desktop && section === 'text');
  const textVisible = section === 'text' || (desktop && section === 'slides');
  const exporting = Boolean(exportProgress || exportSnapshot);
  const noteReady = loadedRef.current && saveStatus !== 'loading';

  const persistHtml = useCallback(async (nextHtml: string) => {
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
    if (!loadedRef.current) return false;
    try {
      const updatedAt = await persistStoredNote(report.id, nextHtml);
      if (latestHtmlRef.current === nextHtml) dirtyRef.current = false;
      if (mountedRef.current && latestHtmlRef.current === nextHtml) {
        setSavedAt(updatedAt);
        setSaveStatus('saved');
      }
      return true;
    } catch {
      if (mountedRef.current) setSaveStatus('error');
      return false;
    }
  }, [report.id]);

  async function saveTags() {
    if (!metaLoaded) return false;
    if (!tagsDirtyRef.current) return true;
    const draft = tagsRef.current;
    const values = [...new Set(draft.split(/[,，;；\n]/).map((tag) => tag.trim()).filter(Boolean))];
    setTagStatus('pending');
    try {
      await updateLibraryMeta(report.id, { tags: values });
      if (tagsRef.current === draft) {
        tagsDirtyRef.current = false;
        setTags(values.join('，'));
        tagsRef.current = values.join('，');
        setTagStatus('saved');
      }
      return true;
    } catch {
      setTagStatus('error');
      return false;
    }
  }

  const editor = useEditor({
    extensions: EDITOR_EXTENSIONS,
    content: '<p></p>',
    editable: false,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: 'noteRichContent',
        role: 'textbox',
        'aria-label': `${report.sourceTitle}的听会笔记`,
        'aria-multiline': 'true',
        spellcheck: 'true',
      },
    },
    onUpdate: ({ editor: activeEditor }) => {
      latestHtmlRef.current = activeEditor.getHTML();
      dirtyRef.current = true;
      setTextLength(activeEditor.getText().length);
      setSaveStatus('pending');
      setManualSaveStatus('idle');
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = window.setTimeout(() => void persistHtml(latestHtmlRef.current), 800);
    },
  }, [report.id]);

  useEffect(() => {
    const media = window.matchMedia('(min-width: 1000px)');
    const update = () => setDesktop(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    if (autoCapture || initialSlideId || initialSection) {
      explicitSectionRef.current = true;
    }
  }, [initialMode, initialSection, initialSlideId, autoCapture]);


  const applyNavigation = useEffectEvent((options: NotebookOpenOptions) => {
    if (options.mode) setMode(options.mode);
    if (options.section || options.slideId || options.capture) selectSection(options.slideId || options.capture ? 'slides' : options.section!);
  });
  const flushChanges = useEffectEvent(async () => {
    if (dirtyRef.current && !(await persistHtml(latestHtmlRef.current))) throw new Error('文本笔记保存失败，请重试后再离开。');
    if (tagsDirtyRef.current && !(await saveTags())) throw new Error('报告标签保存失败，请重试后再离开。');
    if (recordings.loaded && !(await recordings.flush())) throw new Error('录音尚未全部保存，请先停止录音并保存。');
  });

  useEffect(() => {
    const open = (event: Event) => {
      const detail = (event as CustomEvent<{ reportId: number; options: NotebookOpenOptions }>).detail;
      if (detail?.reportId !== report.id) return;
      applyNavigation(detail.options);
    };
    window.addEventListener(NOTEBOOK_OPEN_EVENT, open);
    return () => window.removeEventListener(NOTEBOOK_OPEN_EVENT, open);
  }, [report.id]);

  useEffect(() => {
    const flush = (event: Event) => {
      const detail = (event as CustomEvent<{ promises: Promise<unknown>[] }>).detail;
      if (!Array.isArray(detail?.promises)) return;
      detail.promises.push(flushChanges());
    };
    window.addEventListener('neuro2026:flush-notebook', flush);
    return () => window.removeEventListener('neuro2026:flush-notebook', flush);
  }, [report.id]);
  useEffect(() => {
    let cancelled = false;
    void readLibraryMeta(report.id).then((meta) => {
      if (cancelled) return;
      tagsRef.current = meta.tags.join('，');
      setTags(tagsRef.current);
      setTagStatus('saved');
      textOffsetRef.current = meta.reading?.textOffset ?? 0;
      restoreTextRef.current = true;
      if (!explicitSectionRef.current) setSection(meta.reading?.section ?? 'text');
      setMetaLoaded(true);
      void updateLibraryMeta(report.id, {
        lastOpenedAt: Date.now(),
        reading: { section: initialViewRef.current.capture || initialViewRef.current.slideId ? 'slides' : initialViewRef.current.section ?? meta.reading?.section ?? 'text', updatedAt: Date.now() },
      }).catch(() => { if (!cancelled) setMessage('上次打开时间未能保存，笔记内容不受影响。'); });
    }).catch(() => {
      if (!cancelled) {
        setTagStatus('error');
        setMessage('标签与阅读位置载入失败，请重新打开笔记后再编辑标签。');
      }
    });
    return () => { cancelled = true; };
  }, [report.id]);

  useEffect(() => {
    mountedRef.current = true;
    const flush = () => {
      if (loadedRef.current && dirtyRef.current) {
        try { stageStoredNote(report.id, latestHtmlRef.current); } catch { /* IDB is still attempted below. */ }
        void persistStoredNote(report.id, latestHtmlRef.current).catch(() => window.dispatchEvent(new Event('neuro2026:storage-warning')));
      }
      if (tagsDirtyRef.current) {
        const values = [...new Set(tagsRef.current.split(/[,，;；\n]/).map((tag) => tag.trim()).filter(Boolean))];
        void updateLibraryMeta(report.id, { tags: values }).catch(() => window.dispatchEvent(new Event('neuro2026:storage-warning')));
      }
      if (readingTimerRef.current !== null) {
        window.clearTimeout(readingTimerRef.current);
        readingTimerRef.current = null;
        void updateLibraryMeta(report.id, { reading: { textOffset: textOffsetRef.current, updatedAt: Date.now() } }).catch(() => window.dispatchEvent(new Event('neuro2026:storage-warning')));
      }
    };
    const visibility = () => { if (document.visibilityState === 'hidden') flush(); };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current || tagsDirtyRef.current) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', beforeUnload);
      document.removeEventListener('visibilitychange', visibility);
      mountedRef.current = false;
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
      flush();
    };
  }, [report.id]);

  useEffect(() => {
    const active = recordings.status !== 'idle';
    window.dispatchEvent(new CustomEvent('neuro2026:recording-state', { detail: { reportId: report.id, active } }));
    const warn = (event: BeforeUnloadEvent) => {
      if (active) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', warn);
    return () => {
      window.removeEventListener('beforeunload', warn);
      window.dispatchEvent(new CustomEvent('neuro2026:recording-state', { detail: { reportId: report.id, active: false } }));
    };
  }, [recordings.status, report.id]);

  useEffect(() => {
    if (!editor) return;
    let cancelled = false;
    loadedRef.current = false;
    void loadStoredNote(report.id).then((record) => {
      if (cancelled) return;
      editor.commands.setContent(record.html, { emitUpdate: false });
      editor.setEditable(modeRef.current === 'edit', false);
      latestHtmlRef.current = editor.getHTML();
      loadedRef.current = true;
      setTextLength(editor.getText().length);
      setSavedAt(record.updatedAt);
      setSaveStatus('saved');
      if (record.migrated) {
        dirtyRef.current = true;
        void persistHtml(latestHtmlRef.current);
      }
    }).catch(() => {
      if (!cancelled) {
        editor.setEditable(false, false);
        setSaveStatus('error');
        setMessage('文本读取失败，为保护已有笔记，编辑与导出已禁用。请重新打开后重试。');
      }
    });
    return () => { cancelled = true; };
  }, [editor, report.id, persistHtml]);

  useEffect(() => {
    editor?.setEditable(loadedRef.current && mode === 'edit' && !exporting, false);
  }, [editor, mode, saveStatus, exporting]);

  useEffect(() => {
    if (!metaLoaded || !textVisible || !noteReady || !textPaneRef.current || !restoreTextRef.current) return;
    let cancelled = false;
    const pane = textPaneRef.current;
    void waitForImages(pane).catch(() => {}).then(() => {
      if (cancelled) return;
      pane.scrollTop = textOffsetRef.current;
      restoreTextRef.current = false;
    });
    return () => { cancelled = true; };
  }, [metaLoaded, textVisible, noteReady]);

  useEffect(() => {
    if (noteReady && mode === 'edit' && section === 'text') editor?.commands.focus(undefined, { scrollIntoView: false });
  }, [mode, section, editor, noteReady]);

  useEffect(() => {
    if (section === 'audio' && mode === 'edit') audioPaneRef.current?.querySelector<HTMLButtonElement>('.recordButton')?.focus({ preventScroll: true });
  }, [section, mode]);

  useEffect(() => () => {
    exportSnapshot?.photos.forEach((photo) => URL.revokeObjectURL(photo.src));
  }, [exportSnapshot]);

  function selectSection(next: NotebookSection) {
    explicitSectionRef.current = true;
    if (readingTimerRef.current !== null) {
      window.clearTimeout(readingTimerRef.current);
      readingTimerRef.current = null;
    }
    setSection(next);
    if (metaLoaded) {
      void updateLibraryMeta(report.id, { reading: { section: next, textOffset: textOffsetRef.current, updatedAt: Date.now() } }).catch(() => setMessage('阅读位置保存失败，内容未受影响。'));
    }
  }

  async function insertImage(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !editor) return;
    setMessage('');
    try {
      const dataUrl = await imageFileToDataUrl(file);
      if (!mountedRef.current || editor.isDestroyed) return;
      editor.chain().focus().setImage({ src: dataUrl, alt: file.name, title: file.name }).run();
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : '图片插入失败。');
    }
  }

  async function followSlide(id: string) {
    setMessage('');
    try {
      const slide = await readSlideRecord(id);
      if (!slide) { setMessage('这张 PPT 已被删除，固定链接已失效。文字引用仍保留，可在编辑模式删除或改写。'); return; }
      if (dirtyRef.current && !(await persistHtml(latestHtmlRef.current))) { setMessage('笔记保存失败，未离开当前页面。请先重试保存。'); return; }
      if (slide.reportId !== report.id && recordings.status !== 'idle') { setMessage('请先停止录音并等待保存，再打开已移动到另一场报告的 PPT。'); return; }
      requestNotebook(slide.reportId, { section: 'slides', slideId: slide.id, mode: 'read' });
    } catch {
      setMessage('无法读取 PPT 引用，请检查本机存储后重试。');
    }
  }

  async function saveNow() {
    if (!editor || !loadedRef.current || manualSaveStatus === 'saving') return;
    setManualSaveStatus('saving');
    const saved = await persistHtml(editor.getHTML());
    const tagsSaved = await saveTags();
    if (mountedRef.current) setManualSaveStatus(saved && tagsSaved ? 'saved' : 'error');
  }

  async function openExport() {
    if (!editor || !loadedRef.current || exporting) return;
    if (recordings.status !== 'idle') { setMessage('请先停止录音并等待保存完成，再导出完整笔记。切换标签页不会停止录音。'); return; }
    setMessage('');
    setExportProgress('正在保存完整笔记…');
    editor.setEditable(false, false);
    const html = editor.getHTML();
    const length = editor.getText().length;
    const photos: ExportPhoto[] = [];
    try {
      if (!(await persistHtml(html)) || !(await saveTags()) || !(await recordings.flush())) throw new Error('存在未保存的内容，已停止导出。请先重试保存。');
      const promises: Promise<void>[] = [];
      window.dispatchEvent(new CustomEvent('neuro2026:flush-notebook', { detail: { promises } }));
      await Promise.all(promises);
      const [slides, audio, meta] = await Promise.all([readSlideRecords(report.id), readRecordingRecords(report.id), readLibraryMeta(report.id)]);
      for (const [index, slide] of slides.entries()) {
        if (!mountedRef.current) return;
        setExportProgress(`正在准备 PPT ${index + 1} / ${slides.length}…`);
        const selected = slide.mode === 'processed' ? slide.processed : slide.original;
        if (!(selected instanceof Blob) || !selected.size) throw new Error(`“${slide.name}”的${slide.mode === 'processed' ? '扫描版' : '原图'}不可用，请重新选择图片版本。`);
        const image = await imageToPng(selected);
        photos.push({ id: slide.id, name: slide.name, src: URL.createObjectURL(image), annotation: slide.annotation ?? '', important: Boolean(slide.important), mode: slide.mode, createdAt: slide.createdAt });
      }
      if (!mountedRef.current) return;
      setExportSnapshot({ html, textLength: length, recordings: audio, photos, meta });
    } catch (caught) {
      photos.forEach((photo) => URL.revokeObjectURL(photo.src));
      if (mountedRef.current) setMessage(caught instanceof Error ? caught.message : '完整笔记导出失败，请重试。');
    } finally {
      if (mountedRef.current) setExportProgress('');
      else photos.forEach((photo) => URL.revokeObjectURL(photo.src));
    }
  }

  const saveLabel = saveStatus === 'loading' ? '正在载入…' : saveStatus === 'pending' ? '正在自动保存…' : saveStatus === 'error' ? '保存失败，请重试' : savedAt ? `已保存于 ${new Date(savedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : '内容自动保存在本机';

  return (
    <section className="learningSection noteEditorSection notebook" data-section={section} data-mode={mode}>
      <header className="notebookHeader">
        <div><span className="sectionKicker">个人笔记 · 本机保存</span><h3>本场笔记</h3></div>
        <button type="button" onClick={() => void openExport()} disabled={!loadedRef.current || exporting}>完整笔记 PDF</button>
      </header>
      <div className="notebookTabs" role="tablist" aria-label="笔记内容">
        {([{ key: 'slides', title: 'PPT', count: slideCount }, { key: 'text', title: '文本', count: `${textLength} 字` }, { key: 'audio', title: '录音', count: recordings.items.length }] as const).map((tab) => (
          <button key={tab.key} type="button" role="tab" id={`notebook-tab-${tab.key}`} aria-controls={`notebook-panel-${tab.key}`} aria-selected={section === tab.key} onClick={() => selectSection(tab.key)}>{tab.title}<small>{tab.count}</small>{tab.key === 'audio' && recordings.status !== 'idle' && <i aria-label="录音进行中" />}</button>
        ))}
      </div>
      {recordings.status !== 'idle' && (
        <div className="notebookRecordingBanner" role="status">
          <span>{recordings.status === 'recording' ? `正在录音 ${formatDuration(recordings.elapsedMs)} · 切换标签不停止录音` : recordings.status === 'saving' ? '录音保存中，请勿关闭页面' : '等待麦克风授权'}</span>
          {recordings.status === 'recording' && <button type="button" onClick={recordings.stopRecording}>停止并保存</button>}
        </div>
      )}
      {message && <p className="noteEditorError" role="alert">{message}</p>}
      {recordings.error && section !== 'audio' && <p className="noteEditorError" role="alert">{recordings.error} <button type="button" onClick={() => selectSection('audio')}>查看录音</button></p>}
      {exportProgress && <p className="notebookProgress" role="status">{exportProgress}</p>}
      <fieldset className="notebookWorkspace" disabled={exporting} aria-busy={exporting}>
        <div className="notebookSlidePane" id="notebook-panel-slides" role="tabpanel" aria-labelledby="notebook-tab-slides" hidden={!slidesVisible}>
          <ReportSlides key={report.id} report={report} initialCapture={autoCapture} initialSlideId={initialSlideId} active={metaLoaded && slidesVisible && !exporting} onCountChange={setSlideCount} onActiveSlideChange={setCurrentSlide} />
        </div>
        <div className="notebookTextPane" id="notebook-panel-text" role="tabpanel" aria-labelledby="notebook-tab-text" hidden={!textVisible}>
          <div className="notebookTextHeading">
            <h4>文本笔记 <small>{mode === 'read' ? '阅读模式' : '编辑模式'}</small></h4>
            <button type="button" disabled={!loadedRef.current} onClick={() => {
              if (mode === 'read') { setMode('edit'); selectSection('text'); }
              else void persistHtml(latestHtmlRef.current).then((saved) => { if (saved) setMode('read'); });
            }}>{mode === 'read' ? '编辑文本' : '完成编辑'}</button>
          </div>
          {editor && mode === 'edit' && <NoteToolbar editor={editor} onInsertImage={() => imageInputRef.current?.click()} canLinkSlide={Boolean(currentSlide)} onInsertSlide={() => {
            if (!currentSlide) return;
            editor.chain().focus().insertContent([{ type: 'text', text: `PPT 引用（第 ${currentSlide.index + 1} 张）`, marks: [{ type: 'link', attrs: { href: `#neuro2026-slide=${encodeURIComponent(currentSlide.id)}`, target: null } }] }, { type: 'text', text: ' ' }]).run();
          }} />}
          <input ref={imageInputRef} className="noteImageInput" type="file" accept="image/jpeg,image/png,image/webp,image/gif" onChange={(event) => void insertImage(event)} />
          <div ref={textPaneRef} className="noteRichEditor notebookTextScroll" data-empty={textLength === 0} data-loading={saveStatus === 'loading'} onScroll={(event) => {
            if (!metaLoaded || !textVisible || restoreTextRef.current) return;
            textOffsetRef.current = event.currentTarget.scrollTop;
            if (readingTimerRef.current !== null) window.clearTimeout(readingTimerRef.current);
            readingTimerRef.current = window.setTimeout(() => {
              readingTimerRef.current = null;
              void updateLibraryMeta(report.id, { reading: { section: 'text', textOffset: textOffsetRef.current, updatedAt: Date.now() } }).catch(() => setMessage('文本阅读位置保存失败，笔记内容未受影响。'));
            }, 350);
          }} onClick={(event) => {
            const target = event.target instanceof Element ? event.target.closest('a') : null;
            const href = target?.getAttribute('href');
            if (!href?.startsWith('#neuro2026-slide=')) return;
            event.preventDefault();
            try { void followSlide(decodeURIComponent(href.slice('#neuro2026-slide='.length))); } catch { setMessage('PPT 引用格式无效，请在编辑模式重新插入。'); }
          }}>
            <EditorContent editor={editor} />
          </div>
          <footer className="noteEditorFooter">
            <span role="status" data-status={saveStatus}>{textLength} 字 · {saveLabel}</span>
            <button type="button" className="noteSaveButton" disabled={!loadedRef.current || manualSaveStatus === 'saving'} onClick={() => void saveNow()}>{manualSaveStatus === 'saving' ? '保存中…' : manualSaveStatus === 'saved' ? '保存成功' : manualSaveStatus === 'error' ? '保存失败 · 重试' : '立即保存'}</button>
          </footer>
        </div>
        <div ref={audioPaneRef} className="notebookAudioPane" id="notebook-panel-audio" role="tabpanel" aria-labelledby="notebook-tab-audio" hidden={section !== 'audio'}>
          <RecordingPanel recordings={recordings} />
        </div>
      </fieldset>
      <div className="notebookTags">
        <label htmlFor={`notebook-tags-${report.id}`}>报告标签</label>
        <input id={`notebook-tags-${report.id}`} value={tags} disabled={!metaLoaded || exporting} placeholder="多个标签用逗号分隔" onChange={(event) => { setTags(event.target.value); tagsRef.current = event.target.value; tagsDirtyRef.current = true; setTagStatus('pending'); }} onBlur={() => void saveTags()} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} />
        <button type="button" disabled={!metaLoaded || exporting} onClick={() => void saveTags()}>{tagStatus === 'error' ? '重试保存标签' : '保存标签'}</button>
        <span role="status">{tagStatus === 'error' ? '标签保存失败' : tagStatus === 'pending' ? '标签待保存' : tagStatus === 'loading' ? '载入标签…' : '标签已保存'}</span>
      </div>
      <p className="notebookLocalNotice">仅保存在当前浏览器，不会自动同步。完整 PDF 不包含可播放音频；迁移设备或清理浏览器前，请在资料库下载完整备份。</p>
      {exportSnapshot && <SingleNoteExport report={report} {...exportSnapshot} onClose={() => setExportSnapshot(null)} />}
    </section>
  );
}
