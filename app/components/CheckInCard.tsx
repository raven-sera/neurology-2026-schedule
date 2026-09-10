'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useDialog } from '../lib/useDialog';
const html2canvas: typeof import('html2canvas').default = async (...args) => (await import('html2canvas')).default(...args);
import type { CheckInRecord } from '../lib/checkIn';

type CheckInCardProps = {
  location: string;
  record: CheckInRecord;
  isFresh: boolean;
  onClose: () => void;
};

type ArtworkMark = CSSProperties & {
  '--mark-x': string;
  '--mark-y': string;
  '--mark-size': string;
  '--mark-delay': string;
};

type CardArtworkStyle = CSSProperties & {
  '--checkin-hue': string;
  '--checkin-hue-alt': string;
  '--checkin-tilt': string;
};

function formatCheckInTime(checkedAt: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(checkedAt)).replaceAll('/', '.');
}

export default function CheckInCard({ location, record, isFresh, onClose }: CheckInCardProps) {
  const cardRef = useRef<HTMLElement>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  useDialog('.checkInOverlay', onClose);
  const checkedAt = formatCheckInTime(record.checkedAt);
  const artworkStyle = useMemo<CardArtworkStyle>(() => ({
    '--checkin-hue': String(record.visualSeed % 20 + 220),
    '--checkin-hue-alt': String((record.visualSeed >>> 8) % 20 + 210),
    '--checkin-tilt': `${((record.visualSeed >>> 16) % 13) - 6}deg`,
  }), [record.visualSeed]);
  const artworkMarks = useMemo<ArtworkMark[]>(() => Array.from({ length: 11 }, (_, index) => {
    const shifted = (record.visualSeed >>> (index % 24)) ^ (index * 2654435761);
    return {
      '--mark-x': `${8 + Math.abs(shifted % 84)}%`,
      '--mark-y': `${7 + Math.abs((shifted >>> 7) % 86)}%`,
      '--mark-size': `${8 + Math.abs((shifted >>> 13) % 30)}px`,
      '--mark-delay': `${(index % 6) * 70}ms`,
    };
  }), [record.visualSeed]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  const saveCard = async () => {
    const card = cardRef.current;
    if (!card || busy) return;
    setBusy(true);
    setSaved(false);
    setError('');
    try {
      await document.fonts?.ready;
      const exportScale = 1080 / Math.max(1, card.getBoundingClientRect().width);
      const canvas = await html2canvas(card, {
        scale: exportScale,
        backgroundColor: null,
        logging: false,
        useCORS: true,
      });
      const link = document.createElement('a');
      const stamp = record.checkedAt.slice(0, 16).replaceAll(/[-:T]/g, '');
      link.download = `CMANCN 2026-现场打卡-${stamp}.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();
      setSaved(true);
    } catch {
      setError('卡片生成失败，请稍后重试。');
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className={`checkInOverlay ${isFresh ? 'isCelebrating' : ''}`} role="dialog" aria-modal="true" aria-labelledby="checkin-card-title">
      <div className="checkInConfetti" aria-hidden>
        {artworkMarks.slice(0, 8).map((style, index) => <i style={style} key={index} />)}
      </div>
      <section className="checkInModal">{error && <p role="alert">{error}</p>}
        <header className="checkInModalHeader">
          <div><small>ATTENDANCE MOMENT</small><h2 id="checkin-card-title">神经病学年会现场打卡</h2></div>
          <button type="button" onClick={onClose} aria-label="关闭打卡卡片">×</button>
        </header>
        <figure className="checkInCard" data-artwork={record.visualSeed % 3} style={artworkStyle} ref={cardRef}>
          <header className="checkInCardHeader">
            <span><b>CMANCN</b><small>2026 · ON SITE</small></span>
            <i>CHECKED IN</i>
          </header>
          <main className="checkInCardScene">
            <div className="checkInArtwork" aria-hidden>
              <span className="checkInOrbit" />
              <span className="checkInSun" />
              {artworkMarks.map((style, index) => <i style={style} key={index} />)}
            </div>
            <blockquote>{record.phrase}</blockquote>
            <small>此刻，已在场</small>
          </main>
          <footer className="checkInCardFooter">
            <dl>
              <div><dt>打卡时间</dt><dd>{checkedAt}</dd></div>
              <div><dt>打卡地点</dt><dd>{location || '地点待公布'}</dd></div>
            </dl>
            <span>CMANCN 2026 · ATTENDANCE MEMORY</span>
          </footer>
        </figure>
        <footer className="checkInModalActions">
          <p aria-live="polite">{saved ? '✓ 打卡卡片已保存' : '随机打卡话已生成专属画面'}</p>
          <button type="button" onClick={onClose}>返回我的日程</button>
          <button className="checkInSaveButton" type="button" onClick={saveCard} disabled={busy}>{busy ? '正在生成…' : '保存打卡卡片 ↓'}</button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
