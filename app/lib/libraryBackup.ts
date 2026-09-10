import { Inflate, Zip, ZipPassThrough } from 'fflate';
import type { LibraryMeta, LibrarySnapshot, StoredRecording, StoredSlide } from './noteStorage';

const MiB = 1024 * 1024;
export const BACKUP_LIMITS = { archive: 512 * MiB, expanded: 1024 * MiB, entry: 128 * MiB, manifest: 32 * MiB, entries: 12001, records: 10000 } as const;
const FORMAT = 'neuro2026-personal-library';
const VERSION = 1;
const CHUNK = 64 * 1024;
const imageMimes: Record<string, true> = { 'image/jpeg': true, 'image/png': true, 'image/webp': true, 'image/gif': true, 'image/bmp': true, 'image/avif': true, 'image/heic': true, 'image/heif': true };
const audioMimes: Record<string, true> = { 'audio/webm': true, 'audio/ogg': true, 'audio/mp4': true, 'audio/mpeg': true, 'audio/wav': true, 'audio/x-wav': true, 'audio/aac': true, 'audio/flac': true, 'video/webm': true, 'video/mp4': true };
const supportedTags: Record<string, true> = { P: true, BR: true, STRONG: true, B: true, EM: true, I: true, U: true, S: true, STRIKE: true, H1: true, H2: true, H3: true, H4: true, H5: true, H6: true, UL: true, OL: true, LI: true, BLOCKQUOTE: true, PRE: true, CODE: true, HR: true, SPAN: true, DIV: true, A: true, IMG: true, SUB: true, SUP: true };
const blockedTags: Record<string, true> = { SCRIPT: true, STYLE: true, SVG: true, MATH: true, IFRAME: true, OBJECT: true, EMBED: true, FORM: true, INPUT: true, BUTTON: true, TEXTAREA: true, SELECT: true, TEMPLATE: true, LINK: true, META: true, BASE: true, AUDIO: true, VIDEO: true, SOURCE: true };
type BinaryRef = { path: string; mimeType: string; size: number };
type SlideManifest = Omit<StoredSlide, 'original' | 'thumbnail' | 'processed' | 'processedThumbnail'> & { original: BinaryRef; thumbnail: BinaryRef; processed?: BinaryRef; processedThumbnail?: BinaryRef };
type RecordingManifest = Omit<StoredRecording, 'blob'> & { blob: BinaryRef };
type Manifest = { format: typeof FORMAT; version: typeof VERSION; createdAt: number; notes: LibrarySnapshot['notes']; slides: SlideManifest[]; recordings: RecordingManifest[]; meta: LibraryMeta[] };
export type BackupProgress = { completed: number; total: number; label: string };
export type ParsedLibraryArchive = { snapshot: LibrarySnapshot; createdAt: number; sanitizedNotes: number; reportIds: number[] };
type Entry = { path: string; method: number; flags: number; crc: number; size: number; compressed: number; offset: number; dataOffset?: number };
function fail(message: string): never { throw new Error(message); }
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : fail('备份清单包含无效对象。');
const finite = (value: unknown, label: string, max = Number.MAX_SAFE_INTEGER): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max ? value : fail(`${label}必须是有效的非负数字。`);
const integer = (value: unknown, label: string, max = Number.MAX_SAFE_INTEGER): number => Number.isSafeInteger(finite(value, label, max)) ? value as number : fail(`${label}必须是整数。`);
const reportId = (value: unknown): number => { const id = integer(value, '报告 ID'); return id > 0 ? id : fail('报告 ID 必须是正整数。'); };
const text = (value: unknown, label: string, max = 100000): string => typeof value === 'string' && value.length <= max ? value : fail(`${label}无效或过长。`);
const identifier = (value: unknown): string => { const id = text(value, '记录 ID', 256); return id && !/[\u0000-\u001f\u007f]/.test(id) ? id : fail('记录 ID 为空或含控制字符。'); };
const array = (value: unknown, label: string): unknown[] => Array.isArray(value) && value.length <= BACKUP_LIMITS.records ? value : fail(`${label}不是有效数组或记录过多。`);
const unique = (values: (string | number)[], label: string) => { if (new Set(values).size !== values.length) fail(`${label}重复，无法安全恢复。`); };
const baseMime = (mime: string) => mime.split(';')[0].trim().toLowerCase();
function mime(value: unknown, image: boolean): string {
  const result = text(value, '文件类型', 160);
  if ((image ? imageMimes : audioMimes)[baseMime(result)] !== true || /[\r\n\u0000]/.test(result)) fail('备份含不支持的图片或录音类型。');
  return result;
}

/** Build a new allowlisted tree: imported markup never reaches the live document. */
export function sanitizeLibraryNote(html: string): string {
  const template = document.createElement('template');
  template.innerHTML = html;
  const output = document.createElement('div');
  let nodes = 0;
  const visit = (source: Node, parent: Node, depth: number) => {
    if (++nodes > 200000 || depth > 128) fail('笔记 HTML 结构过大或嵌套过深。');
    if (source.nodeType === 3) { parent.appendChild(document.createTextNode(source.textContent || '')); return; }
    if (!(source instanceof Element) || source.namespaceURI !== 'http://www.w3.org/1999/xhtml' || blockedTags[source.tagName] === true) return;
    let destination = parent;
    if (supportedTags[source.tagName] === true) {
      const element = document.createElement(source.tagName.toLowerCase());
      if (source.tagName === 'A') {
        const href = (source.getAttribute('href') || '').trim();
        if (/^https?:\/\//i.test(href) || /^mailto:[^\s<>]+$/i.test(href) || /^#neuro2026-slide=[^\s<>]+$/.test(href)) {
          try { const url = new URL(href, 'https://backup.invalid/'); if (['https:', 'http:', 'mailto:'].includes(url.protocol)) element.setAttribute('href', href); } catch { /* Invalid links become plain text. */ }
        }
        element.setAttribute('rel', 'noopener noreferrer');
      }
      if (source.tagName === 'IMG') {
        const src = source.getAttribute('src') || '';
        if (!/^data:image\/(?:png|jpeg|webp|gif|bmp|avif);base64,[A-Za-z0-9+/]*={0,2}$/.test(src) || src.length > 12 * MiB) return;
        const header = Uint8Array.from(atob(src.slice(src.indexOf(',') + 1, src.indexOf(',') + 1 + 64)), char => char.charCodeAt(0));
        if (!rasterHeader(header, src.slice(5, src.indexOf(';')))) return;
        element.setAttribute('src', src);
        element.setAttribute('alt', (source.getAttribute('alt') || '').slice(0, 1000));
        for (const dimension of ['width', 'height']) { const value = source.getAttribute(dimension); if (value && /^\d{1,5}$/.test(value) && Number(value) > 0 && Number(value) <= 20000) element.setAttribute(dimension, value); }
      }
      if (source.tagName === 'OL') { const start = source.getAttribute('start'); if (start && /^-?\d{1,6}$/.test(start)) element.setAttribute('start', start); }
      const style = (source as HTMLElement).style;
      for (const property of ['color', 'background-color', 'text-decoration-color']) {
        const value = style.getPropertyValue(property);
        if (/^(?:#[\da-f]{3,8}|(?:rgba?|hsla?)\([\d\s.,%/+-]+\)|[a-z]+)$/i.test(value) && CSS.supports(property, value)) element.style.setProperty(property, value);
      }
      const fontSize = style.fontSize;
      if (/^\d+(?:\.\d+)?(?:px|pt|em|rem|%)$/.test(fontSize) && parseFloat(fontSize) > 0 && parseFloat(fontSize) <= 200) element.style.fontSize = fontSize;
      const fontFamily = style.fontFamily.replace(/['"]/g, '');
      if (['Microsoft YaHei', 'SimSun', 'KaiTi', 'Arial', 'Georgia'].includes(fontFamily)) element.style.fontFamily = fontFamily;
      parent.appendChild(element); destination = element;
    }
    for (const child of Array.from(source.childNodes)) visit(child, destination, depth + 1);
  };
  for (const child of Array.from(template.content.childNodes)) visit(child, output, 0);
  return output.innerHTML;
}

function rasterHeader(bytes: Uint8Array, type: string): boolean {
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  if (type === 'image/jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (type === 'image/png') return bytes.length >= 24 && ascii(1, 4) === 'PNG' && bytes[0] === 137 && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10;
  if (type === 'image/gif') return ['GIF87a', 'GIF89a'].includes(ascii(0, 6));
  if (type === 'image/webp') return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP';
  if (type === 'image/bmp') return ascii(0, 2) === 'BM';
  return ascii(4, 8) === 'ftyp' && /avif|avis|heic|heix|hevc|hevx|mif1|msf1/.test(ascii(8, 48));
}

function validateManifest(value: unknown, entries: Map<string, Entry>): Manifest {
  const data = record(value);
  if (data.format !== FORMAT) fail('这不是神经病学年会个人资料库备份，请选择本工具导出的 ZIP。');
  if (data.version !== VERSION) fail(`不支持备份版本 ${String(data.version)}；请使用支持该版本的应用。`);
  const used = new Set(['manifest.json']);
  const binary = (value: unknown, image: boolean): BinaryRef => {
    const ref = record(value), path = text(ref.path, '二进制路径', 80), entry = entries.get(path);
    const size = integer(ref.size, '二进制长度', BACKUP_LIMITS.entry);
    if (!/^assets\/\d{6}\.bin$/.test(path) || !entry || used.has(path) || size !== entry.size || !size) fail('备份缺少二进制文件、引用重复或文件大小不匹配。');
    used.add(path);
    return { path, size, mimeType: mime(ref.mimeType, image) };
  };
  const notes = array(data.notes, '笔记').map(value => { const item = record(value); return { reportId: reportId(item.reportId), html: text(item.html, '笔记正文', 24 * MiB), updatedAt: finite(item.updatedAt, '笔记更新时间') }; });
  const slides: SlideManifest[] = array(data.slides, '照片').map(value => {
    const item = record(value);
    const mode = item.mode === 'original' || item.mode === 'processed' ? item.mode : fail('照片显示版本无效。');
    const width = integer(item.width, '图片宽度', 30000), height = integer(item.height, '图片高度', 30000);
    if (!width || !height || width * height > 48000000) fail('照片尺寸超出安全范围。');
    if (item.important !== undefined && typeof item.important !== 'boolean') fail('照片重点标记无效。');
    const slide: SlideManifest = { id: identifier(item.id), reportId: reportId(item.reportId), name: text(item.name, '照片名称', 2000), width, height, createdAt: finite(item.createdAt, '照片时间'), order: finite(item.order, '照片顺序'), mode, original: binary(item.original, true), thumbnail: binary(item.thumbnail, true) };
    if (item.annotation !== undefined) slide.annotation = text(item.annotation, '照片批注');
    if (item.important !== undefined) slide.important = item.important as boolean;
    if (item.updatedAt !== undefined) slide.updatedAt = finite(item.updatedAt, '照片更新时间');
    if (item.processed !== undefined) slide.processed = binary(item.processed, true);
    if (item.processedThumbnail !== undefined) slide.processedThumbnail = binary(item.processedThumbnail, true);
    if ((slide.processedThumbnail && !slide.processed) || (mode === 'processed' && !slide.processed)) fail('扫描版照片缺失。');
    return slide;
  });
  const recordings: RecordingManifest[] = array(data.recordings, '录音').map(value => {
    const item = record(value), blob = binary(item.blob, false), mimeType = mime(item.mimeType, false);
    if (baseMime(blob.mimeType) !== baseMime(mimeType)) fail('录音类型与文件不一致。');
    return { id: identifier(item.id), reportId: reportId(item.reportId), title: text(item.title, '录音名称', 2000), createdAt: finite(item.createdAt, '录音时间'), durationMs: finite(item.durationMs, '录音时长'), mimeType, blob };
  });
  const meta: LibraryMeta[] = array(data.meta, '资料元数据').map(value => {
    const item = record(value), tags = array(item.tags, '标签').map(tag => text(tag, '标签', 100));
    if (tags.length > 100) fail('单场报告的标签过多。');
    unique(tags, '标签');
    const result: LibraryMeta = { reportId: reportId(item.reportId), tags, lastOpenedAt: finite(item.lastOpenedAt, '最近打开时间') };
    if (item.reading !== undefined) {
      const reading = record(item.reading), section = reading.section;
      if (section !== 'slides' && section !== 'text' && section !== 'audio') fail('阅读位置的分区无效。');
      result.reading = { section, updatedAt: finite(reading.updatedAt, '阅读位置时间') };
      if (reading.slideId !== undefined) result.reading.slideId = identifier(reading.slideId);
      if (reading.offset !== undefined) {
        if (typeof reading.offset !== 'number' || !Number.isFinite(reading.offset) || Math.abs(reading.offset) > Number.MAX_SAFE_INTEGER) fail('照片阅读偏移无效。');
        result.reading.offset = reading.offset;
      }
      if (reading.textOffset !== undefined) result.reading.textOffset = finite(reading.textOffset, '文字阅读偏移');
    }
    return result;
  });
  unique(notes.map(item => item.reportId), '笔记报告 ID'); unique(meta.map(item => item.reportId), '元数据报告 ID');
  unique([...slides.map(item => item.id), ...recordings.map(item => item.id)], '照片或录音 ID');
  if (used.size !== entries.size) fail('备份包含清单未引用的文件。');
  return { format: FORMAT, version: VERSION, createdAt: finite(data.createdAt, '备份创建时间', 8640000000000000), notes, slides, recordings, meta };
}

export async function createLibraryArchive(snapshot: LibrarySnapshot, progress?: (value: BackupProgress) => void): Promise<Blob> {
  const assets: { ref: BinaryRef; blob: Blob }[] = [];
  const add = (blob: Blob, fallback?: string): BinaryRef => {
    const ref = { path: `assets/${String(assets.length + 1).padStart(6, '0')}.bin`, mimeType: blob.type || fallback || '', size: blob.size };
    assets.push({ ref, blob }); return ref;
  };
  const manifest: Manifest = { format: FORMAT, version: VERSION, createdAt: Date.now(), notes: snapshot.notes, meta: snapshot.meta,
    slides: snapshot.slides.map(slide => ({ ...slide, original: add(slide.original), thumbnail: add(slide.thumbnail), processed: slide.processed ? add(slide.processed) : undefined, processedThumbnail: slide.processedThumbnail ? add(slide.processedThumbnail) : undefined })),
    recordings: snapshot.recordings.map(recording => ({ ...recording, blob: add(recording.blob, recording.mimeType) })) };
  const manifestBlob = new Blob([JSON.stringify(manifest)], { type: 'application/json' });
  const files = [{ path: 'manifest.json', blob: manifestBlob }, ...assets.map(({ ref, blob }) => ({ path: ref.path, blob }))];
  const total = files.reduce((sum, file) => sum + file.blob.size, 0);
  if (manifestBlob.size > BACKUP_LIMITS.manifest || files.length > BACKUP_LIMITS.entries || total + files.length * 200 > BACKUP_LIMITS.archive) fail('资料库超出单个备份的安全上限（512 MB / 12001 个文件），请先单独导出大体积资料。');
  const entries = new Map(files.map(file => [file.path, { path: file.path, size: file.blob.size, compressed: file.blob.size, method: 0, flags: 0, crc: 0, offset: 0 }]));
  validateManifest(manifest, entries);
  const parts: BlobPart[] = [];
  let completed = 0, outputSize = 0, finished = false;
  const zip = new Zip((error, data, final) => {
    if (error) throw error;
    outputSize += data.length;
    if (outputSize > BACKUP_LIMITS.archive) fail('备份超过 512 MB 安全上限。');
    parts.push(new Blob([data as Uint8Array<ArrayBuffer>])); finished = final;
  });
  try {
    for (const file of files) {
      const entry = new ZipPassThrough(file.path); zip.add(entry);
      for (let offset = 0; offset < file.blob.size; offset += CHUNK) {
        const chunk = new Uint8Array(await file.blob.slice(offset, offset + CHUNK).arrayBuffer());
        entry.push(chunk, offset + chunk.length === file.blob.size); completed += chunk.length;
        progress?.({ completed, total, label: '正在打包原始文件' });
      }
      if (!file.blob.size) entry.push(new Uint8Array(), true);
    }
    zip.end();
    if (!finished) fail('ZIP 未能完成，请重新生成。');
    return new Blob(parts, { type: 'application/zip' });
  } catch (error) { zip.terminate(); throw error; }
}

const crcTable = new Uint32Array(256);
for (let index = 0; index < 256; index++) { let value = index; for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1; crcTable[index] = value >>> 0; }
function crcChunk(crc: number, bytes: Uint8Array): number { for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8); return crc; }
const bytesAt = async (file: Blob, start: number, size: number) => new Uint8Array(await file.slice(start, start + size).arrayBuffer());
const decode = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);

async function archiveDirectory(file: Blob): Promise<Map<string, Entry>> {
  if (file.size < 22 || file.size > BACKUP_LIMITS.archive) fail('ZIP 为空、已损坏或超过 512 MB 安全上限。');
  const tail = await bytesAt(file, Math.max(0, file.size - 65557), 65557), view = new DataView(tail.buffer);
  let end = -1;
  for (let offset = tail.length - 22; offset >= 0; offset--) if (view.getUint32(offset, true) === 0x06054b50 && offset + 22 + view.getUint16(offset + 20, true) === tail.length) { end = offset; break; }
  if (end < 0) fail('ZIP 结尾目录缺失，文件可能未下载完整。');
  const count = view.getUint16(end + 10, true), directorySize = view.getUint32(end + 12, true), directoryOffset = view.getUint32(end + 16, true);
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || view.getUint16(end + 8, true) !== count || !count || count > BACKUP_LIMITS.entries || directorySize > 4 * MiB || directoryOffset + directorySize !== file.size - tail.length + end) fail('不支持分卷、ZIP64 或异常 ZIP 目录。');
  const directory = await bytesAt(file, directoryOffset, directorySize), central = new DataView(directory.buffer), entries = new Map<string, Entry>();
  let offset = 0, expanded = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > directory.length || central.getUint32(offset, true) !== 0x02014b50) fail('ZIP 文件目录已损坏。');
    const nameSize = central.getUint16(offset + 28, true), extraSize = central.getUint16(offset + 30, true), commentSize = central.getUint16(offset + 32, true);
    if (offset + 46 + nameSize + extraSize + commentSize > directory.length) fail('ZIP 目录长度不正确。');
    const path = decode(directory.subarray(offset + 46, offset + 46 + nameSize));
    const entry: Entry = { path, flags: central.getUint16(offset + 8, true), method: central.getUint16(offset + 10, true), crc: central.getUint32(offset + 16, true), compressed: central.getUint32(offset + 20, true), size: central.getUint32(offset + 24, true), offset: central.getUint32(offset + 42, true) };
    const unixType = (central.getUint32(offset + 38, true) >>> 16) & 0xf000;
    if ((path !== 'manifest.json' && !/^assets\/\d{6}\.bin$/.test(path)) || entries.has(path) || (unixType && unixType !== 0x8000) || central.getUint16(offset + 34, true) || (entry.flags & ~0x080e) || ![0, 8].includes(entry.method)) fail('ZIP 含不安全路径、重复文件、链接、加密或不支持的压缩方式。');
    if (entry.size > (path === 'manifest.json' ? BACKUP_LIMITS.manifest : BACKUP_LIMITS.entry) || entry.size > Math.max(1, entry.compressed) * 200 || (entry.method === 0 && entry.size !== entry.compressed)) fail('ZIP 文件解压体积或压缩比超出安全范围。');
    expanded += entry.size; if (expanded > BACKUP_LIMITS.expanded) fail('ZIP 总解压体积超过 1 GB 安全上限。');
    entries.set(path, entry); offset += 46 + nameSize + extraSize + commentSize;
  }
  if (offset !== directory.length || !entries.has('manifest.json')) fail('ZIP 缺少清单或目录不完整。');
  let previousEnd = 0;
  for (const entry of [...entries.values()].sort((a, b) => a.offset - b.offset)) {
    if (entry.offset !== previousEnd || entry.offset + 30 > directoryOffset) fail('ZIP 文件区间重叠或含未声明内容。');
    const localBytes = await bytesAt(file, entry.offset, 30), local = new DataView(localBytes.buffer);
    if (local.getUint32(0, true) !== 0x04034b50 || local.getUint16(6, true) !== entry.flags || local.getUint16(8, true) !== entry.method) fail('ZIP 文件头与目录不一致。');
    const nameSize = local.getUint16(26, true), extraSize = local.getUint16(28, true);
    entry.dataOffset = entry.offset + 30 + nameSize + extraSize;
    if (entry.dataOffset + entry.compressed > directoryOffset || decode(await bytesAt(file, entry.offset + 30, nameSize)) !== entry.path) fail('ZIP 文件名或长度与目录不一致。');
    previousEnd = entry.dataOffset + entry.compressed;
    if (entry.flags & 8) {
      const descriptorBytes = await bytesAt(file, previousEnd, Math.min(16, directoryOffset - previousEnd));
      if (descriptorBytes.length < 12) fail('ZIP 数据描述符缺失。');
      const descriptor = new DataView(descriptorBytes.buffer), start = descriptor.getUint32(0, true) === 0x08074b50 ? 4 : 0;
      if (descriptorBytes.length < start + 12 || descriptor.getUint32(start, true) !== entry.crc || descriptor.getUint32(start + 4, true) !== entry.compressed || descriptor.getUint32(start + 8, true) !== entry.size) fail('ZIP 数据校验信息不一致。');
      previousEnd += start + 12;
    } else if (local.getUint32(14, true) !== entry.crc || local.getUint32(18, true) !== entry.compressed || local.getUint32(22, true) !== entry.size) fail('ZIP 本地文件长度或校验码不一致。');
  }
  if (previousEnd !== directoryOffset) fail('ZIP 含未声明的文件内容。');
  return entries;
}

async function extractEntry(file: Blob, entry: Entry, mimeType: string, onBytes: (size: number) => void): Promise<Blob> {
  const parts: BlobPart[] = [];
  let count = 0, crc = -1;
  const receive = (chunk: Uint8Array) => {
    count += chunk.length;
    if (count > entry.size || count > BACKUP_LIMITS.entry) fail('实际解压体积超出清单，已停止导入。');
    crc = crcChunk(crc, chunk); parts.push(new Blob([chunk as Uint8Array<ArrayBuffer>])); onBytes(chunk.length);
  };
  const inflate = entry.method === 8 ? new Inflate(receive) : null;
  for (let offset = 0; offset < entry.compressed; offset += CHUNK) {
    const chunk = await bytesAt(file, entry.dataOffset! + offset, Math.min(CHUNK, entry.compressed - offset));
    if (inflate) inflate.push(chunk, offset + chunk.length === entry.compressed); else receive(chunk);
  }
  if (inflate && !entry.compressed) inflate.push(new Uint8Array(), true);
  if (count !== entry.size || ((crc ^ -1) >>> 0) !== entry.crc) fail(`文件 ${entry.path} 校验失败，备份可能已损坏。`);
  const blob = new Blob(parts, { type: mimeType });
  if (baseMime(mimeType).startsWith('image/') && !rasterHeader(await bytesAt(blob, 0, 64), baseMime(mimeType))) fail('图片内容与声明类型不一致，已停止导入。');
  return blob;
}

/** Pure preparation: no IndexedDB/localStorage writes occur before successful return. */
export async function parseLibraryArchive(file: Blob, progress?: (value: BackupProgress) => void): Promise<ParsedLibraryArchive> {
  try {
    const entries = await archiveDirectory(file), total = [...entries.values()].reduce((sum, entry) => sum + entry.size, 0);
    let completed = 0;
    const onBytes = (size: number) => { completed += size; progress?.({ completed, total, label: '正在校验并读取备份' }); };
    const manifestFile = await extractEntry(file, entries.get('manifest.json')!, 'application/json', onBytes);
    const manifest = validateManifest(JSON.parse(decode(new Uint8Array(await manifestFile.arrayBuffer()))), entries);
    let sanitizedNotes = 0;
    const notes = manifest.notes.map(note => { const html = sanitizeLibraryNote(note.html); if (html !== note.html) sanitizedNotes++; return { ...note, html }; });
    const binary = (ref: BinaryRef) => extractEntry(file, entries.get(ref.path)!, ref.mimeType, onBytes);
    const slides: StoredSlide[] = [];
    for (const slide of manifest.slides) slides.push({ ...slide, original: await binary(slide.original), thumbnail: await binary(slide.thumbnail), processed: slide.processed ? await binary(slide.processed) : undefined, processedThumbnail: slide.processedThumbnail ? await binary(slide.processedThumbnail) : undefined });
    const recordings: StoredRecording[] = [];
    for (const recording of manifest.recordings) recordings.push({ ...recording, blob: await binary(recording.blob) });
    const snapshot: LibrarySnapshot = { notes, slides, recordings, meta: manifest.meta };
    const reportIds = [...new Set([...notes, ...slides, ...recordings, ...manifest.meta].map(item => item.reportId))].sort((a, b) => a - b);
    return { snapshot, reportIds, createdAt: manifest.createdAt, sanitizedNotes };
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError || error instanceof RangeError) fail('备份格式损坏或不符合安全限制；本机资料尚未修改。');
    throw error;
  }
}
