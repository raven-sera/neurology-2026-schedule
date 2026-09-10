import { deferred } from './deferred';
import type { NotebookSection } from './libraryTypes';
const NOTES_DATABASE = 'neuro2026-report-notes';
const NOTES_STORE = 'notes';
const RECORDINGS_STORE = 'recordings';
const SLIDES_STORE = 'slides';
const NOTE_INDEX = 'note-index';
const SLIDE_INDEX = 'slide-index';
const RECORDING_INDEX = 'recording-index';
const META_STORE = 'library-meta';
const THUMBNAILS_STORE = 'slide-thumbnails';
const ALL_STORES = [NOTES_STORE, SLIDES_STORE, RECORDINGS_STORE, NOTE_INDEX, SLIDE_INDEX, RECORDING_INDEX, META_STORE, THUMBNAILS_STORE];
export const LIBRARY_CHANGE_EVENT = 'neuro2026:library-change';
const LEGACY_NOTE_KEY = 'neuro2026-report-note-';
const FALLBACK_NOTE_KEY = 'neuro2026-report-note-html-';

export type NoteRecord = {
  reportId: number;
  html: string;
  updatedAt: number;
  legacyFallback?: boolean;
};

export type StoredRecording = {
  id: string;
  reportId: number;
  title: string;
  blob: Blob;
  mimeType: string;
  durationMs: number;
  createdAt: number;
};

export type StoredSlide = {
  id: string;
  reportId: number;
  name: string;
  original: Blob;
  thumbnail: Blob;
  width: number;
  height: number;
  createdAt: number;
  order: number;
  processed?: Blob;
  processedThumbnail?: Blob;
  mode: 'original' | 'processed';
  annotation?: string;
  important?: boolean;
  updatedAt?: number;
};

export type LibraryReading = {
  section: NotebookSection;
  slideId?: string;
  offset?: number;
  textOffset?: number;
  updatedAt: number;
};
export type LibraryMeta = {
  reportId: number;
  tags: string[];
  lastOpenedAt: number;
  reading?: LibraryReading;
  updatedAt?: number;
};
export type SlideIndex = {
  id: string; reportId: number; name: string; order: number;
  createdAt: number; updatedAt: number; annotation: string; important: boolean;
};
type NoteIndex = { reportId: number; noteText: string; hasNote: boolean; updatedAt: number };
type RecordingIndex = { id: string; reportId: number; createdAt: number; title: string };
export type LibrarySummary = NoteIndex & {
  slideCount: number; recordingCount: number; annotationText: string;
  firstSlideId?: string; meta: LibraryMeta; slides: SlideIndex[];
};
export type LibrarySnapshot = {
  notes: NoteRecord[]; slides: StoredSlide[]; recordings: StoredRecording[]; meta: LibraryMeta[];
};

function changed(reportIds: number[], kind: 'content' | 'meta' | 'reading' = 'content') {
  window.dispatchEvent(new CustomEvent(LIBRARY_CHANGE_EVENT, { detail: { reportIds, kind } }));
}
function defaultMeta(reportId: number): LibraryMeta {
  return { reportId, tags: [], lastOpenedAt: 0 };
}
function noteIndex(record: NoteRecord): NoteIndex {
  const document = new DOMParser().parseFromString(record.html, 'text/html');
  document.querySelectorAll('script,style').forEach(element => element.remove());
  const noteText = (document.body.textContent || '').replace(/\s+/g, ' ').trim();
  return { reportId: record.reportId, noteText, hasNote: !!noteText || !!document.querySelector('img'), updatedAt: record.updatedAt };
}
function slideIndex(record: StoredSlide): SlideIndex {
  return {
    id: record.id, reportId: record.reportId, name: record.name, order: record.order,
    createdAt: record.createdAt, updatedAt: record.updatedAt ?? record.createdAt,
    annotation: record.annotation || '', important: !!record.important,
  };
}
function recordingIndex(record: StoredRecording): RecordingIndex {
  return { id: record.id, reportId: record.reportId, title: record.title, createdAt: record.createdAt };
}

let notesDatabasePromise: Promise<IDBDatabase> | null = null;

function requestResult<T>(request: IDBRequest<T>) {
  const { promise, resolve, reject } = deferred<T>();
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'));
  return promise;
}

function transactionComplete(transaction: IDBTransaction) {
  const { promise, resolve, reject } = deferred<void>();
  transaction.oncomplete = () => resolve();
  transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed.'));
  transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction was aborted.'));
  // A failed request can reject before its caller reaches the commit await.
  void promise.catch(() => {});
  return promise;
}

function openNotesDatabase() {
  if (notesDatabasePromise) return notesDatabasePromise;
  const { promise, resolve, reject } = deferred<IDBDatabase>();
  notesDatabasePromise = promise;
  let blocked = false;
  const request = indexedDB.open(NOTES_DATABASE, 3);
  request.onupgradeneeded = () => {
    const database = request.result;
    if (!database.objectStoreNames.contains(NOTES_STORE)) {
      database.createObjectStore(NOTES_STORE, { keyPath: 'reportId' });
    }
    if (!database.objectStoreNames.contains(RECORDINGS_STORE)) {
      const store = database.createObjectStore(RECORDINGS_STORE, { keyPath: 'id' });
      store.createIndex('reportId', 'reportId');
    }
    if (!database.objectStoreNames.contains(SLIDES_STORE)) {
      const store = database.createObjectStore(SLIDES_STORE, { keyPath: 'id' });
      store.createIndex('reportId', 'reportId');
    }
    const transaction = request.transaction!;
    if (!database.objectStoreNames.contains(THUMBNAILS_STORE)) database.createObjectStore(THUMBNAILS_STORE, { keyPath: 'id' });
    for (const [source, target, keyPath, project] of [
      [NOTES_STORE, NOTE_INDEX, 'reportId', noteIndex],
      [SLIDES_STORE, SLIDE_INDEX, 'id', slideIndex],
      [RECORDINGS_STORE, RECORDING_INDEX, 'id', recordingIndex],
    ] as const) {
      if (database.objectStoreNames.contains(target)) continue;
      const index = database.createObjectStore(target, { keyPath });
      if (target !== NOTE_INDEX) index.createIndex('reportId', 'reportId');
      const cursor = transaction.objectStore(source).openCursor();
      cursor.onsuccess = () => {
        if (!cursor.result) return;
        index.put(project(cursor.result.value));
        if (source === SLIDES_STORE) {
          const slide: StoredSlide = cursor.result.value;
          transaction.objectStore(THUMBNAILS_STORE).put({ id: slide.id, blob: slide.mode === 'processed' ? slide.processedThumbnail ?? slide.thumbnail : slide.thumbnail });
        }
        cursor.result.continue();
      };
    }
    if (!database.objectStoreNames.contains(META_STORE)) database.createObjectStore(META_STORE, { keyPath: 'reportId' });
  };
  request.onsuccess = () => {
    const database = request.result;
    if (blocked) { database.close(); return; }
    database.onversionchange = () => { database.close(); notesDatabasePromise = null; };
    database.onclose = () => { notesDatabasePromise = null; };
    resolve(database);
  };
  request.onerror = () => reject(request.error ?? new Error('Unable to open note storage.'));
  request.onblocked = () => {
    blocked = true;
    reject(new Error('请关闭其他已打开的神经病学年会页面，再重试载入本机资料。'));
  };
  void notesDatabasePromise.catch(() => {
    notesDatabasePromise = null;
  });
  return notesDatabasePromise;
}

async function readNoteRecord(reportId: number) {
  const database = await openNotesDatabase();
  const transaction = database.transaction(NOTES_STORE, 'readonly');
  return requestResult(transaction.objectStore(NOTES_STORE).get(reportId)) as Promise<NoteRecord | undefined>;
}

async function writeNoteRecord(record: NoteRecord) {
  const database = await openNotesDatabase();
  const transaction = database.transaction([NOTES_STORE, NOTE_INDEX], 'readwrite');
  const completed = transactionComplete(transaction);
  try {
    transaction.objectStore(NOTES_STORE).put(record);
    transaction.objectStore(NOTE_INDEX).put(noteIndex(record));
  } catch (error) {
    transaction.abort();
    await completed.catch(() => {});
    throw error;
  }
  await completed;
  changed([record.reportId]);
}

export async function readRecordingRecords(reportId: number) {
  const database = await openNotesDatabase();
  const transaction = database.transaction(RECORDINGS_STORE, 'readonly');
  const index = transaction.objectStore(RECORDINGS_STORE).index('reportId');
  const records = await requestResult(index.getAll(IDBKeyRange.only(reportId))) as StoredRecording[];
  return records.sort((left, right) => left.createdAt - right.createdAt);
}

export async function writeRecordingRecord(record: StoredRecording) {
  const database = await openNotesDatabase();
  const transaction = database.transaction([RECORDINGS_STORE, RECORDING_INDEX], 'readwrite');
  const completed = transactionComplete(transaction);
  try {
    transaction.objectStore(RECORDINGS_STORE).put(record);
    transaction.objectStore(RECORDING_INDEX).put(recordingIndex(record));
  } catch (error) {
    transaction.abort();
    await completed.catch(() => {});
    throw error;
  }
  await completed;
  changed([record.reportId]);
}

export async function removeRecordingRecord(id: string) {
  const database = await openNotesDatabase();
  const transaction = database.transaction([RECORDINGS_STORE, RECORDING_INDEX], 'readwrite');
  const completed = transactionComplete(transaction);
  const previous = await requestResult(transaction.objectStore(RECORDING_INDEX).get(id)) as RecordingIndex | undefined;
  transaction.objectStore(RECORDINGS_STORE).delete(id);
  transaction.objectStore(RECORDING_INDEX).delete(id);
  await completed;
  changed(previous ? [previous.reportId] : []);
}

export async function readSlideRecords(reportId: number): Promise<StoredSlide[]> {
  const database = await openNotesDatabase();
  const transaction = database.transaction(SLIDES_STORE, 'readonly');
  const index = transaction.objectStore(SLIDES_STORE).index('reportId');
  const records = await requestResult(index.getAll(IDBKeyRange.only(reportId))) as StoredSlide[];
  return records.sort((left, right) => left.order - right.order || left.createdAt - right.createdAt || left.id.localeCompare(right.id));
}

export async function writeSlideRecords(records: StoredSlide[]): Promise<void> {
  if (!records.length) return;
  const database = await openNotesDatabase();
  const transaction = database.transaction([SLIDES_STORE, SLIDE_INDEX, THUMBNAILS_STORE], 'readwrite');
  const completed = transactionComplete(transaction);
  try {
    const store = transaction.objectStore(SLIDES_STORE);
    for (const record of records) {
      const updated = { ...record, updatedAt: Date.now() };
      store.put(updated);
      transaction.objectStore(SLIDE_INDEX).put(slideIndex(updated));
      transaction.objectStore(THUMBNAILS_STORE).put({ id: record.id, blob: record.mode === 'processed' ? record.processedThumbnail ?? record.thumbnail : record.thumbnail });
    }
  } catch (error) {
    transaction.abort();
    await completed.catch(() => {});
    throw error;
  }
  await completed;
  changed([...new Set(records.map(record => record.reportId))]);
}

export async function removeSlideRecord(id: string): Promise<void> {
  await removeSlideRecords([id]);
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function plainTextToHtml(value: string) {
  const paragraphs = value.split(/\n{2,}/).map((paragraph) => (
    `<p>${escapeHtml(paragraph).replaceAll('\n', '<br>')}</p>`
  ));
  return paragraphs.join('') || '<p></p>';
}

function fallbackRecord(reportId: number): NoteRecord | undefined {
  const value = localStorage.getItem(`${FALLBACK_NOTE_KEY}${reportId}`);
  if (!value) return undefined;
  try {
    const record = JSON.parse(value);
    if (typeof record.html === 'string' && Number.isFinite(record.updatedAt)) return {reportId, html: record.html, updatedAt: record.updatedAt};
  } catch { /* Prior versions stored raw HTML. */ }
  return {reportId, html:value, updatedAt:0, legacyFallback:true};
}

export async function loadStoredNote(reportId: number) {
  let primary: NoteRecord | undefined, fallback: NoteRecord | undefined;
  let primaryReadable = false, fallbackReadable = false;
  try { primary = await readNoteRecord(reportId); primaryReadable = true; } catch { /* use fallback */ }
  try { fallback = fallbackRecord(reportId); fallbackReadable = true; } catch { /* primary still works */ }
  if (fallback && (fallback.legacyFallback || !primary || fallback.updatedAt >= primary.updatedAt)) return {...fallback, migrated:true};
  if (primary) return {...primary, migrated:false};
  if (!primaryReadable && !fallbackReadable) throw new Error('Note storage is unavailable.');
  let legacy = '';
  try { legacy = localStorage.getItem(`${LEGACY_NOTE_KEY}${reportId}`) ?? ''; } catch { /* no readable legacy data */ }
  return { reportId, html:plainTextToHtml(legacy), updatedAt:0, migrated:Boolean(legacy) };
}

let lastTimestamp = 0;
const nextTimestamp = () => (lastTimestamp = Math.max(Date.now(), lastTimestamp + 1));

export function stageStoredNote(reportId: number, html: string) {
  const record = { reportId, html, updatedAt:nextTimestamp() };
  localStorage.setItem(`${FALLBACK_NOTE_KEY}${reportId}`, JSON.stringify(record));
  changed([reportId]);
  return record;
}

const pendingSaves = new Map<number, Promise<unknown>>();
export function persistStoredNote(reportId: number, html: string) {
  const record = { reportId, html, updatedAt:nextTimestamp() };
  const operation = (pendingSaves.get(reportId) ?? Promise.resolve()).catch(() => {}).then(async () => {
    try {
      await writeNoteRecord(record);
    } catch {
      // A successful fallback is a save; if both stores fail, reject to the UI.
      const fallback = fallbackRecord(reportId);
      if (!fallback || fallback.legacyFallback || fallback.updatedAt <= record.updatedAt) {
        localStorage.setItem(`${FALLBACK_NOTE_KEY}${reportId}`, JSON.stringify(record));
      }
      changed([reportId]);
      return record.updatedAt;
    }
    try {
      const fallback = fallbackRecord(reportId);
      if (!fallback || fallback.legacyFallback || fallback.updatedAt <= record.updatedAt) localStorage.removeItem(`${FALLBACK_NOTE_KEY}${reportId}`);
      localStorage.removeItem(`${LEGACY_NOTE_KEY}${reportId}`);
    } catch { /* Cleanup failure cannot turn a committed IDB write into a failed save. */ }
    return record.updatedAt;
  });
  pendingSaves.set(reportId, operation);
  void operation.then(() => { if (pendingSaves.get(reportId) === operation) pendingSaves.delete(reportId); }, () => { if (pendingSaves.get(reportId) === operation) pendingSaves.delete(reportId); });
  return operation;
}

export async function readSlideRecord(id: string): Promise<StoredSlide | undefined> {
  const database = await openNotesDatabase();
  return requestResult(database.transaction(SLIDES_STORE).objectStore(SLIDES_STORE).get(id));
}

export async function readSlideThumbnail(id: string): Promise<Blob | undefined> {
  const database = await openNotesDatabase();
  const thumbnail = await requestResult(database.transaction(THUMBNAILS_STORE).objectStore(THUMBNAILS_STORE).get(id)) as { id: string; blob: Blob } | undefined;
  return thumbnail?.blob;
}

export async function readLibraryMeta(reportId: number): Promise<LibraryMeta> {
  const database = await openNotesDatabase();
  const record = await requestResult(database.transaction(META_STORE).objectStore(META_STORE).get(reportId)) as LibraryMeta | undefined;
  return record ?? defaultMeta(reportId);
}

export async function updateLibraryMeta(reportId: number, patch: Partial<Omit<LibraryMeta, 'reportId' | 'reading'>> & { reading?: Partial<LibraryReading> }): Promise<void> {
  const database = await openNotesDatabase();
  const transaction = database.transaction(META_STORE, 'readwrite');
  const completed = transactionComplete(transaction);
  const store = transaction.objectStore(META_STORE);
  const previous = await requestResult(store.get(reportId)) as LibraryMeta | undefined;
  const next: LibraryMeta = { ...(previous ?? defaultMeta(reportId)), ...patch, reportId,
    reading: patch.reading ? { section: 'slides', updatedAt: Date.now(), ...previous?.reading, ...patch.reading } : previous?.reading };
  if (patch.tags) {
    next.tags = [...new Set(patch.tags.map(tag => tag.trim()).filter(Boolean))].slice(0, 30);
    next.updatedAt = Date.now();
  }
  store.put(next);
  await completed;
  changed([reportId], patch.tags ? 'meta' : 'reading');
}

function localNoteIds(): number[] {
  const ids = new Set<number>();
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    const match = key?.match(/^neuro2026-report-note-(?:html-)?(\d+)$/);
    if (match && Number(match[1]) > 0) ids.add(Number(match[1]));
  }
  return [...ids];
}

export async function readLibrarySummaries(): Promise<LibrarySummary[]> {
  const database = await openNotesDatabase();
  const transaction = database.transaction([NOTE_INDEX, SLIDE_INDEX, RECORDING_INDEX, META_STORE]);
  const [notes, slides, recordings, metadata] = await Promise.all([
    requestResult(transaction.objectStore(NOTE_INDEX).getAll()) as Promise<NoteIndex[]>,
    requestResult(transaction.objectStore(SLIDE_INDEX).getAll()) as Promise<SlideIndex[]>,
    requestResult(transaction.objectStore(RECORDING_INDEX).getAll()) as Promise<RecordingIndex[]>,
    requestResult(transaction.objectStore(META_STORE).getAll()) as Promise<LibraryMeta[]>,
  ]);
  const noteMap = new Map(notes.map(note => [note.reportId, note]));
  // Historical localStorage notes and emergency saves remain readable without moving or deleting them.
  let fallbackIds: number[] = [];
  try { fallbackIds = localNoteIds(); } catch { /* IndexedDB remains authoritative when browser denies localStorage. */ }
  for (const reportId of fallbackIds) {
    const note = await loadStoredNote(reportId);
    noteMap.set(reportId, noteIndex(note));
  }
  const entries = new Map<number, LibrarySummary>();
  const get = (reportId: number) => {
    let entry = entries.get(reportId);
    if (!entry) {
      entry = { reportId, noteText: '', hasNote: false, updatedAt: 0, slideCount: 0,
        recordingCount: 0, annotationText: '', meta: defaultMeta(reportId), slides: [] };
      entries.set(reportId, entry);
    }
    return entry;
  };
  for (const note of noteMap.values()) Object.assign(get(note.reportId), note);
  for (const slide of slides) {
    const entry = get(slide.reportId);
    entry.slides.push(slide);
    entry.slideCount++;
    entry.updatedAt = Math.max(entry.updatedAt, slide.updatedAt);
  }
  for (const recording of recordings) {
    const entry = get(recording.reportId);
    entry.recordingCount++;
    entry.updatedAt = Math.max(entry.updatedAt, recording.createdAt);
  }
  for (const meta of metadata) {
    const entry = get(meta.reportId);
    entry.meta = meta;
    entry.updatedAt = Math.max(entry.updatedAt, meta.updatedAt ?? 0);
  }
  for (const entry of entries.values()) {
    entry.slides.sort((a, b) => a.order - b.order || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    entry.firstSlideId = entry.slides[0]?.id;
    entry.annotationText = entry.slides.map(slide => slide.annotation).filter(Boolean).join('\n');
  }
  return [...entries.values()].filter(entry => entry.hasNote || entry.slideCount || entry.recordingCount);
}

export async function removeSlideRecords(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const database = await openNotesDatabase();
  const transaction = database.transaction([SLIDES_STORE, SLIDE_INDEX, THUMBNAILS_STORE], 'readwrite');
  const completed = transactionComplete(transaction);
  const reportIds = new Set<number>();
  for (const id of new Set(ids)) {
    const prior = await requestResult(transaction.objectStore(SLIDE_INDEX).get(id)) as SlideIndex | undefined;
    if (prior) reportIds.add(prior.reportId);
    transaction.objectStore(SLIDES_STORE).delete(id);
    transaction.objectStore(SLIDE_INDEX).delete(id);
    transaction.objectStore(THUMBNAILS_STORE).delete(id);
  }
  await completed;
  changed([...reportIds]);
}

export async function moveSlideRecords(ids: string[], toReportId: number): Promise<void> {
  if (!ids.length) return;
  if (!Number.isSafeInteger(toReportId) || toReportId <= 0) throw new Error('请选择有效的目标报告。');
  const database = await openNotesDatabase();
  const transaction = database.transaction([SLIDES_STORE, SLIDE_INDEX], 'readwrite');
  const completed = transactionComplete(transaction);
  try {
    const store = transaction.objectStore(SLIDES_STORE);
    const index = transaction.objectStore(SLIDE_INDEX);
    const destination = await requestResult(index.index('reportId').getAll(toReportId)) as SlideIndex[];
    let order = destination.reduce((max, slide) => Math.max(max, slide.order), -1) + 1;
    const moving: StoredSlide[] = [];
    for (const id of new Set(ids)) {
      const record = await requestResult(store.get(id)) as StoredSlide | undefined;
      if (!record) throw new Error('部分照片已被删除，请刷新后重新选择。');
      if (record.reportId !== toReportId) moving.push(record);
    }
    moving.sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
    const reportIds = new Set([toReportId]);
    for (const record of moving) {
      reportIds.add(record.reportId);
      const next = { ...record, reportId: toReportId, order: order++, updatedAt: Date.now() };
      store.put(next);
      index.put(slideIndex(next));
    }
    await completed;
    changed([...reportIds]);
  } catch (error) {
    try { transaction.abort(); } catch { /* Transaction already aborted. */ }
    await completed.catch(() => {});
    throw error;
  }
}

export async function readLibrarySnapshot(): Promise<LibrarySnapshot> {
  await Promise.all([...pendingSaves.values()]);
  const database = await openNotesDatabase();
  const transaction = database.transaction([NOTES_STORE, SLIDES_STORE, RECORDINGS_STORE, META_STORE]);
  const [notes, slides, recordings, meta] = await Promise.all([
    requestResult(transaction.objectStore(NOTES_STORE).getAll()) as Promise<NoteRecord[]>,
    requestResult(transaction.objectStore(SLIDES_STORE).getAll()) as Promise<StoredSlide[]>,
    requestResult(transaction.objectStore(RECORDINGS_STORE).getAll()) as Promise<StoredRecording[]>,
    requestResult(transaction.objectStore(META_STORE).getAll()) as Promise<LibraryMeta[]>,
  ]);
  const noteMap = new Map(notes.map(note => [note.reportId, note]));
  let ids: number[] = [];
  try { ids = localNoteIds(); } catch { /* No readable fallback notes. */ }
  for (const id of ids) noteMap.set(id, await loadStoredNote(id));
  return { notes: [...noteMap.values()], slides, recordings, meta };
}

export async function restoreLibrarySnapshot(snapshot: LibrarySnapshot, policy: 'keep' | 'replace'): Promise<{ restored: number; skipped: number }> {
  if (policy !== 'keep' && policy !== 'replace') throw new Error('请选择恢复冲突处理方式。');
  await Promise.all([...pendingSaves.values()]);
  const incomingIds = new Set([...snapshot.notes, ...snapshot.slides, ...snapshot.recordings, ...snapshot.meta].map(record => record.reportId));
  for (const id of incomingIds) if (!Number.isSafeInteger(id) || id <= 0) throw new Error('备份中的报告编号无效。');
  let localIds: number[] = [];
  try { localIds = localNoteIds(); } catch { /* IndexedDB still available. */ }
  const database = await openNotesDatabase();
  const transaction = database.transaction(ALL_STORES, 'readwrite');
  const completed = transactionComplete(transaction);
  try {
    const [notes, slides, recordings, metas] = await Promise.all([
      requestResult(transaction.objectStore(NOTE_INDEX).getAll()) as Promise<NoteIndex[]>,
      requestResult(transaction.objectStore(SLIDE_INDEX).getAll()) as Promise<SlideIndex[]>,
      requestResult(transaction.objectStore(RECORDING_INDEX).getAll()) as Promise<RecordingIndex[]>,
      requestResult(transaction.objectStore(META_STORE).getAll()) as Promise<LibraryMeta[]>,
    ]);
    const existingIds = new Set([...notes.filter(note => note.hasNote), ...slides, ...recordings].map(record => record.reportId));
    for (const id of localIds) existingIds.add(id);
    const restoring = new Set([...incomingIds].filter(id => policy === 'replace' || !existingIds.has(id)));
    const checkCollision = (incoming: { id: string; reportId: number }[], current: { id: string; reportId: number }[]) => {
      const currentById = new Map(current.map(item => [item.id, item]));
      const seen = new Set<string>();
      for (const item of incoming) {
        if (seen.has(item.id)) throw new Error('备份含重复资料编号，未写入任何内容。');
        seen.add(item.id);
        const collision = currentById.get(item.id);
        if (restoring.has(item.reportId) && collision && !restoring.has(collision.reportId)) {
          throw new Error('备份中的资料已移动到另一场本机报告。为避免覆盖，请保留现有资料后再整理备份。');
        }
      }
    };
    checkCollision(snapshot.slides, slides);
    checkCollision(snapshot.recordings, recordings);
    for (const note of notes) if (restoring.has(note.reportId)) {
      transaction.objectStore(NOTES_STORE).delete(note.reportId);
      transaction.objectStore(NOTE_INDEX).delete(note.reportId);
    }
    for (const slide of slides) if (restoring.has(slide.reportId)) {
      transaction.objectStore(SLIDES_STORE).delete(slide.id);
      transaction.objectStore(SLIDE_INDEX).delete(slide.id);
      transaction.objectStore(THUMBNAILS_STORE).delete(slide.id);
    }
    for (const recording of recordings) if (restoring.has(recording.reportId)) {
      transaction.objectStore(RECORDINGS_STORE).delete(recording.id);
      transaction.objectStore(RECORDING_INDEX).delete(recording.id);
    }
    for (const meta of metas) if (restoring.has(meta.reportId)) transaction.objectStore(META_STORE).delete(meta.reportId);
    for (const record of snapshot.notes) if (restoring.has(record.reportId)) {
      const restored = { reportId: record.reportId, html: record.html, updatedAt: nextTimestamp() };
      transaction.objectStore(NOTES_STORE).put(restored);
      transaction.objectStore(NOTE_INDEX).put(noteIndex(restored));
    }
    for (const record of snapshot.slides) if (restoring.has(record.reportId)) {
      transaction.objectStore(SLIDES_STORE).put(record);
      transaction.objectStore(SLIDE_INDEX).put(slideIndex(record));
      transaction.objectStore(THUMBNAILS_STORE).put({ id: record.id, blob: record.mode === 'processed' ? record.processedThumbnail ?? record.thumbnail : record.thumbnail });
    }
    for (const record of snapshot.recordings) if (restoring.has(record.reportId)) {
      transaction.objectStore(RECORDINGS_STORE).put(record);
      transaction.objectStore(RECORDING_INDEX).put(recordingIndex(record));
    }
    for (const record of snapshot.meta) if (restoring.has(record.reportId)) transaction.objectStore(META_STORE).put(record);
    await completed;
    for (const id of restoring) {
      try { localStorage.removeItem(`${FALLBACK_NOTE_KEY}${id}`); localStorage.removeItem(`${LEGACY_NOTE_KEY}${id}`); }
      catch { window.dispatchEvent(new Event('neuro2026:storage-warning')); }
    }
    changed([...restoring]);
    return { restored: restoring.size, skipped: incomingIds.size - restoring.size };
  } catch (error) {
    try { transaction.abort(); } catch { /* Transaction already aborted. */ }
    await completed.catch(() => {});
    throw error;
  }
}
