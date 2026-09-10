'use client';

import { useMemo, useRef } from 'react';
import type { CSSProperties, MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { useDialog } from '../lib/useDialog';
import { CHECK_IN_PHRASES, type CheckInRecord } from '../lib/checkIn';

type CheckInAtlasProps = {
  records: CheckInRecord[];
  onClose: () => void;
};

type AtlasCardStyle = CSSProperties & {
  '--atlas-hue': string;
  '--atlas-hue-alt': string;
};

const CARD_HUES = [76, 8, 151, 38, 195, 326];

export default function CheckInAtlas({ records, onClose }: CheckInAtlasProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const collectedCounts = useMemo(() => {
    const counts = new Map<string, number>();
    records.forEach((record) => {
      if (!CHECK_IN_PHRASES.includes(record.phrase)) return;
      counts.set(record.phrase, (counts.get(record.phrase) ?? 0) + 1);
    });
    return counts;
  }, [records]);
  const unlockedCount = collectedCounts.size;
  const completion = CHECK_IN_PHRASES.length
    ? Math.round((unlockedCount / CHECK_IN_PHRASES.length) * 100)
    : 0;

  useDialog('.checkInAtlasOverlay', onClose);
  const closeFromBackdrop = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) onClose();
  };

  return createPortal(
    <div className="checkInAtlasOverlay" role="dialog" aria-modal="true" aria-labelledby="checkin-atlas-title" onMouseDown={closeFromBackdrop}>
      <section className="checkInAtlasModal">
        <header className="checkInAtlasHeader">
          <div>
            <small>CHECK-IN COLLECTION</small>
            <h2 id="checkin-atlas-title">打卡语图鉴</h2>
            <p>每次现场打卡都会随机遇见一句话。收集到后，卡面与内容才会被点亮。</p>
          </div>
          <button ref={closeButtonRef} type="button" onClick={onClose} aria-label="关闭打卡语图鉴">×</button>
        </header>

        <div className="checkInAtlasProgress" aria-label={`图鉴收集进度 ${unlockedCount}/${CHECK_IN_PHRASES.length}`}>
          <div><span>COLLECTION PROGRESS</span><strong>{unlockedCount}<i>/ {CHECK_IN_PHRASES.length}</i></strong></div>
          <div className="checkInAtlasProgressTrack"><i style={{ width: `${completion}%` }} /></div>
          <p>{completion === 100 ? '图鉴已全部点亮' : `还有 ${CHECK_IN_PHRASES.length - unlockedCount} 张等待解锁`}</p>
        </div>

        <div className="checkInAtlasGrid">
          {CHECK_IN_PHRASES.map((phrase, index) => {
            const collectedCount = collectedCounts.get(phrase) ?? 0;
            const unlocked = collectedCount > 0;
            const style: AtlasCardStyle = {
              '--atlas-hue': String(CARD_HUES[index % CARD_HUES.length]),
              '--atlas-hue-alt': String(CARD_HUES[(index + 2) % CARD_HUES.length]),
            };
            return (
              <article
                className={`checkInAtlasCard ${unlocked ? 'isUnlocked' : 'isLocked'}`}
                style={style}
                aria-label={unlocked ? `已解锁：${phrase}` : `第 ${index + 1} 张打卡语尚未解锁`}
                key={phrase}
              >
                <header><span>NO. {String(index + 1).padStart(2, '0')}</span><b>{unlocked ? 'UNLOCKED' : 'LOCKED'}</b></header>
                <div className="checkInAtlasCardBody">
                  <span className="checkInAtlasEmblem" aria-hidden>{unlocked ? 'NEURO' : '?'}</span>
                  <blockquote>{unlocked ? phrase : '尚未相遇'}</blockquote>
                </div>
                <footer>
                  <small>{unlocked ? '打卡语已收集' : '继续打卡，等待解锁'}</small>
                  {unlocked && <b>× {collectedCount}</b>}
                </footer>
              </article>
            );
          })}
        </div>

        <footer className="checkInAtlasFooter">
          <p>重复遇见会累计次数；清空日程不会影响图鉴。</p>
          <button type="button" onClick={onClose}>返回我的日程</button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}

