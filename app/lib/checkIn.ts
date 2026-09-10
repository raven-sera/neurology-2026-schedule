import phraseCorpus from '../data/check-in-phrases.md?raw';

export type CheckInRecord = {
  reportId: number;
  checkedAt: string;
  phrase: string;
  visualSeed: number;
};

export const CHECK_IN_PHRASES = phraseCorpus
  .split(/\r?\n/)
  .map((line) => line.replace(/^\s*\d+[.)、．]\s*/, '').trim())
  .filter(Boolean);

function randomUint32() {
  const value = new Uint32Array(1);
  globalThis.crypto.getRandomValues(value);
  return value[0];
}

export function createCheckInRecord(reportId: number): CheckInRecord {
  const visualSeed = randomUint32();
  return {
    reportId,
    checkedAt: new Date().toISOString(),
    phrase: CHECK_IN_PHRASES[visualSeed % CHECK_IN_PHRASES.length],
    visualSeed,
  };
}

export function isCheckInRecord(value: unknown): value is CheckInRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<CheckInRecord>;
  return Number.isInteger(record.reportId)
    && typeof record.checkedAt === 'string'
    && !Number.isNaN(Date.parse(record.checkedAt))
    && typeof record.phrase === 'string'
    && Boolean(record.phrase.trim())
    && Number.isInteger(record.visualSeed);
}
