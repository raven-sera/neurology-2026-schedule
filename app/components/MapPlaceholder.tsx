'use client';

import { useDialog } from '../lib/useDialog';

export default function MapPlaceholder({ location, onClose }: { location?: string; onClose: () => void }) {
  useDialog('.mapPlaceholderOverlay', onClose);

  return (
    <div className="mapPlaceholderOverlay" role="dialog" aria-modal="true" aria-labelledby="map-placeholder-title">
      <section className="mapPlaceholder">
        <header>
          <h2 id="map-placeholder-title">会场地图</h2>
          <button type="button" onClick={onClose} aria-label="关闭会场地图">关闭</button>
        </header>
        {location && <p>原表会场：{location}</p>}
        <div className="mapPlaceholderCanvas"><p>地图区域暂留空</p></div>
      </section>
    </div>
  );
}
