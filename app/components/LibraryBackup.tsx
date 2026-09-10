'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDialog } from '../lib/useDialog';
import { useClientReady } from '../lib/useClientReady';
import { readLibrarySnapshot, readLibrarySummaries, restoreLibrarySnapshot } from '../lib/noteStorage';
import { createLibraryArchive, parseLibraryArchive, type BackupProgress, type ParsedLibraryArchive } from '../lib/libraryBackup';
import { reports } from '../lib/reports';
import './library-backup.css';

const reportTitles = new Map(reports.map(report => [report.id, report.sourceTitle]));
function formatBytes(bytes: number) { return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
function errorMessage(error: unknown) {
  if (error instanceof DOMException && error.name === 'QuotaExceededError') return '本机存储空间不足，恢复未提交。请释放浏览器或设备空间后再试。';
  return error instanceof Error ? error.message : '操作未完成，请保留备份文件并重试。';
}

export default function LibraryBackup({ onClose }: { onClose: () => void }) {
  const mounted = useClientReady();
  const [busy, setBusy] = useState('');
  const [progress, setProgress] = useState<BackupProgress | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [download, setDownload] = useState<{ url: string; filename: string; size: number } | null>(null);
  const [preview, setPreview] = useState<ParsedLibraryArchive | null>(null);
  const [conflicts, setConflicts] = useState<number[]>([]);
  const [policy, setPolicy] = useState<'keep' | 'replace'>('keep');
  const [confirmed, setConfirmed] = useState(false);
  const [usage, setUsage] = useState<{ usage?: number; quota?: number } | null>(null);
  const [estimateState, setEstimateState] = useState('正在读取存储估算…');
  const fileInput = useRef<HTMLInputElement>(null);
  const lock = useRef(false);
  const alive = useRef(true);
  const url = useRef('');
  useDialog('.libraryBackupOverlay', () => { if (!lock.current) onClose(); }, mounted);

  useEffect(() => {
    alive.current = true;
    if (navigator.storage?.estimate) {
      void navigator.storage.estimate().then(value => { if (alive.current) { setUsage(value); setEstimateState(''); } }).catch(() => { if (alive.current) setEstimateState('当前浏览器无法读取存储估算。'); });
    }
    return () => { alive.current = false; if (url.current) URL.revokeObjectURL(url.current); };
  }, []);

  const begin = (label: string) => {
    if (lock.current) return false;
    lock.current = true; setBusy(label); setError(''); setNotice(''); setProgress(null); return true;
  };
  const finish = () => { lock.current = false; if (alive.current) { setBusy(''); setProgress(null); } };
  const updateProgress = (value: BackupProgress) => { if (alive.current) setProgress(value); };
  const generate = async () => {
    if (!begin('正在读取本机资料库…')) return;
    if (url.current) { URL.revokeObjectURL(url.current); url.current = ''; } setDownload(null);
    try {
      const snapshot = await readLibrarySnapshot();
      if (alive.current) setBusy('正在逐个打包文件…');
      const blob = await createLibraryArchive(snapshot, updateProgress);
      if (!alive.current) return;
      url.current = URL.createObjectURL(blob);
      setDownload({ url: url.current, filename: `CMANCN 2026-个人资料库-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`, size: blob.size });
      setNotice('ZIP 已准备好。请点击“下载备份 ZIP”保存到自己的安全位置。');
    } catch (cause) { if (alive.current) setError(errorMessage(cause)); }
    finally { finish(); }
  };
  const inspect = async (file: File) => {
    if (!begin('正在检查备份文件…')) return;
    setPreview(null); setConflicts([]); setPolicy('keep'); setConfirmed(false);
    try {
      const parsed = await parseLibraryArchive(file, updateProgress);
      if (alive.current) { setBusy('正在检查本机报告冲突…'); setProgress(null); }
      const current = await readLibrarySummaries();
      const ids = new Set(current.map(item => item.reportId));
      if (alive.current) { setPreview(parsed); setConflicts(parsed.reportIds.filter(id => ids.has(id))); }
    } catch (cause) { if (alive.current) setError(`${errorMessage(cause)} 本机资料尚未修改。`); }
    finally { finish(); }
  };
  const restore = async () => {
    if (!preview || (policy === 'replace' && !confirmed) || !begin('正在原子恢复资料，请勿关闭页面…')) return;
    try {
      const result = await restoreLibrarySnapshot(preview.snapshot, policy);
      if (!alive.current) return;
      setNotice(`恢复完成：已恢复 ${result.restored} 场报告，保留并跳过 ${result.skipped} 场报告。`);
      setPreview(null); setConfirmed(false);
      if (navigator.storage?.estimate) void navigator.storage.estimate().then(value => { if (alive.current) setUsage(value); }).catch(() => {});
    } catch (cause) { if (alive.current) setError(`${errorMessage(cause)} 恢复未提交，原有本机资料保持不变。`); }
    finally { finish(); }
  };

  if (!mounted) return null;
  const unknownIds = preview?.reportIds.filter(id => !reportTitles.has(id)) ?? [];
  return createPortal(<div className="libraryBackupOverlay" role="dialog" aria-modal="true" aria-labelledby="libraryBackupTitle" onClick={event => { if (event.target === event.currentTarget && !lock.current) onClose(); }}>
    <div className="libraryBackupDialog" aria-busy={!!busy}>
      <header><div><small>个人资料库 · 本机文件</small><h2 id="libraryBackupTitle">备份与恢复</h2></div><button type="button" disabled={!!busy} onClick={onClose}>关闭</button></header>
      <div className="libraryBackupPrivacy"><strong>这是私密的本地备份，不是云同步</strong><p>ZIP 包含完整笔记、照片原图与扫描版、缩略图、录音、批注、标签和阅读位置。文件未加密，任何取得文件的人都可能读取内容；请妥善保管，不要上传含敏感信息的资料。</p><p>清除站点数据、更换浏览器或设备不会自动迁移资料。PDF 和图片导出不能代替本备份。</p></div>
      <p className="libraryBackupStorage">{usage ? <>本站浏览器存储估算：已用 {typeof usage.usage === 'number' ? formatBytes(usage.usage) : '未知'} / 可用配额 {typeof usage.quota === 'number' ? formatBytes(usage.quota) : '未知'}。包含本站 IndexedDB 与缓存，并非仅资料库大小；配额不代表永久保存。</> : typeof navigator.storage?.estimate === 'function' ? estimateState : '当前浏览器不提供存储估算。'}</p>
      <section aria-labelledby="libraryBackupExportTitle"><h3 id="libraryBackupExportTitle">导出完整资料库</h3><p>逐个打包二进制原文件，不转为 PDF，不改变原有资料。单个 ZIP 上限 512 MB；生成后由你点击下载。</p><button className="libraryBackupPrimary" type="button" disabled={!!busy} onClick={() => void generate()}>生成完整备份</button>
        {download && <div className="libraryBackupReady"><span>{download.filename} · {formatBytes(download.size)}</span><a href={download.url} download={download.filename}>下载备份 ZIP</a><small>文件已生成不等于已保存；请确认浏览器下载完成。</small></div>}
      </section>
      <section aria-labelledby="libraryBackupImportTitle"><h3 id="libraryBackupImportTitle">从 ZIP 恢复</h3><p>先完整校验文件，再预览和确认；无效备份不会写入资料库。恢复以整场报告为单位，不做隐式合并。</p><label className="libraryBackupFile">选择备份 ZIP<input ref={fileInput} type="file" accept=".zip,application/zip" disabled={!!busy} onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void inspect(file); }} /></label>
        {preview && <div className="libraryBackupPreview"><h4>恢复预览</h4><p>备份时间：{new Date(preview.createdAt).toLocaleString('zh-CN')}</p><dl><div><dt>报告</dt><dd>{preview.reportIds.length}</dd></div><div><dt>文字笔记</dt><dd>{preview.snapshot.notes.length}</dd></div><div><dt>PPT 照片</dt><dd>{preview.snapshot.slides.length}</dd></div><div><dt>录音</dt><dd>{preview.snapshot.recordings.length}</dd></div><div><dt>报告冲突</dt><dd>{conflicts.length}</dd></div></dl>
          {!!preview.sanitizedNotes && <p>已安全整理 {preview.sanitizedNotes} 篇笔记的 HTML；保留支持的文字格式、栅格内嵌图片和 PPT 链接，移除不安全内容。</p>}
          {!!unknownIds.length && <div className="libraryBackupWarning"><strong>{unknownIds.length} 场报告不在当前日程中</strong><p>这些旧版或未知报告的资料仍将保留原报告 ID 恢复，不会丢弃。当前日程可能无法打开它们，但可再次完整备份。</p><p>{unknownIds.map(id => `未知报告 #${id}`).join('、')}</p></div>}
          {!!conflicts.length && <details><summary>查看 {conflicts.length} 场本机已有资料的报告</summary><ul>{conflicts.map(id => <li key={id}>{reportTitles.get(id) || `未知报告 #${id}`} <small>#{id}</small></li>)}</ul></details>}
          <fieldset disabled={!!busy}><legend>遇到本机已有报告时</legend><label><input type="radio" name="libraryBackupPolicy" checked={policy === 'keep'} onChange={() => { setPolicy('keep'); setConfirmed(false); }} />保留本机报告，跳过备份中整场冲突报告（推荐）</label><label><input type="radio" name="libraryBackupPolicy" checked={policy === 'replace'} onChange={() => { setPolicy('replace'); setConfirmed(false); }} />以备份整场替换本机冲突报告</label></fieldset>
          {policy === 'replace' && <div className="libraryBackupWarning"><strong>替换会删除冲突报告现有的全部笔记、照片、录音及标签</strong><p>只有备份中的该报告内容会恢复，本机独有内容也会被移除。建议先下载当前资料库备份。应用时会重新检查冲突，包括预览后新增的资料。</p><label><input type="checkbox" checked={confirmed} disabled={!!busy} onChange={event => setConfirmed(event.target.checked)} />我确认按上述规则整场替换所有冲突报告</label></div>}
          <p>恢复时重新检查本机状态；如照片或录音 ID 已被移到其他报告而发生冲突，操作将停止，不会覆盖其他报告。</p><button className="libraryBackupPrimary" type="button" disabled={!!busy || !preview.reportIds.length || (policy === 'replace' && !confirmed)} onClick={() => void restore()}>{policy === 'replace' ? '确认按备份恢复并替换' : '恢复非冲突报告'}</button>
        </div>}
      </section>
      {busy && <div className="libraryBackupStatus" role="status"><strong>{busy}</strong>{progress && <><progress value={progress.completed} max={Math.max(1, progress.total)} /><span>{progress.label} · {formatBytes(progress.completed)} / {formatBytes(progress.total)}</span></>}<small>处理期间请保留此页面；恢复提交完成后才能关闭。</small></div>}
      {notice && <p className="libraryBackupStatus" role="status">{notice}</p>}
      {error && <p className="libraryBackupError" role="alert">{error}</p>}
    </div>
  </div>, document.body);
}
