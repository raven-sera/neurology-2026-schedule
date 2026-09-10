'use client';

import { useId, useLayoutEffect, useRef, useState } from 'react';
import { publicPath } from '../lib/sitePaths';
import { MAP_FLOORS, MAP_REGIONS, REGION_BY_ID, type Floor } from '../lib/venueLocations';
import './venue-map.css';

type VenueMapProps = {
  floor: Floor;
  selectedRegionId: string | null;
  onSelectRegion: (id: string) => void;
};
type ViewControls = {
  zoom: (factor: number) => void;
  reset: () => void;
  center: (id: string) => void;
};
type TrackedPointer = { x: number; y: number; startX: number; startY: number; target: HTMLElement };
const MAX_ZOOM = 5;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export default function VenueMap(props: VenueMapProps) {
  // Each floor owns its image load state and gesture lifetime; no adjacent images are preloaded.
  return <FloorMap key={props.floor} {...props} />;
}

function FloorMap({ floor, selectedRegionId, onSelectRegion }: VenueMapProps) {
  const floorInfo = MAP_FLOORS.find(item => item.id === floor)!;
  const regions = MAP_REGIONS.filter(region => region.floor === floor);
  const viewportRef = useRef<HTMLDivElement>(null);
  const planeRef = useRef<HTMLDivElement>(null);
  const zoomLabelRef = useRef<HTMLOutputElement>(null);
  const controlsRef = useRef<ViewControls | null>(null);
  const selectionRef = useRef(selectedRegionId);
  const [imageState, setImageState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [retry, setRetry] = useState(0);
  const [showFacilities, setShowFacilities] = useState(false);
  const helpId = useId();
  const imageUrl = publicPath(floorInfo.imagePath);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const plane = planeRef.current;
    if (!viewport || !plane) return;
    const pointers = new Map<number, TrackedPointer>();
    let width = 0;
    let height = 0;
    let imageWidth = 0;
    let imageHeight = 0;
    let scale = 1;
    let x = 0;
    let y = 0;
    let frame = 0;
    let moved = false;
    let lastGestureEnd = -Infinity;

    function constrain() {
      const w = imageWidth * scale;
      const h = imageHeight * scale;
      // Short axes stay centered; long axes retain the image with only a small edge margin.
      x = w <= width ? (width - w) / 2 : clamp(x, width - w - 32, 32);
      y = h <= height ? (height - h) / 2 : clamp(y, height - h - 32, 32);
    }
    function paint() {
      frame = 0;
      plane!.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${scale})`;
      plane!.style.setProperty('--venueMap-inverse-scale', String(1 / scale));
      if (zoomLabelRef.current) zoomLabelRef.current.value = `${Math.round(scale * 100)}%`;
    }
    function schedulePaint() {
      if (!frame) frame = requestAnimationFrame(paint);
    }
    function center(id: string) {
      const region = REGION_BY_ID[id];
      if (!region || region.floor !== floor || !width || !height) return;
      scale = Math.max(scale, 2.2);
      x = width / 2 - imageWidth * scale * region.x / 100;
      y = height / 2 - imageHeight * scale * region.y / 100;
      constrain();
      schedulePaint();
    }
    function reset() {
      scale = 1;
      x = (width - imageWidth) / 2;
      y = (height - imageHeight) / 2;
      schedulePaint();
    }
    function zoomAt(nextScale: number, anchorX: number, anchorY: number) {
      const previousScale = scale;
      scale = clamp(nextScale, 1, MAX_ZOOM);
      x = anchorX - (anchorX - x) * scale / previousScale;
      y = anchorY - (anchorY - y) * scale / previousScale;
    }
    function zoom(factor: number) {
      zoomAt(scale * factor, width / 2, height / 2);
      constrain();
      schedulePaint();
    }
    function measure() {
      const nextWidth = viewport!.clientWidth;
      const nextHeight = viewport!.clientHeight;
      if (!nextWidth || !nextHeight || (nextWidth === width && nextHeight === height)) return;
      const firstMeasure = !width || !height;
      const centerX = imageWidth ? (width / 2 - x) / (imageWidth * scale) : 0.5;
      const centerY = imageHeight ? (height / 2 - y) / (imageHeight * scale) : 0.5;
      width = nextWidth;
      height = nextHeight;
      const fit = Math.min(width / floorInfo.width, height / floorInfo.height);
      imageWidth = floorInfo.width * fit;
      imageHeight = floorInfo.height * fit;
      plane!.style.width = `${imageWidth}px`;
      plane!.style.height = `${imageHeight}px`;
      x = width / 2 - centerX * imageWidth * scale;
      y = height / 2 - centerY * imageHeight * scale;
      constrain();
      if (firstMeasure && selectionRef.current) center(selectionRef.current);
      schedulePaint();
    }
    function pointerDown(event: PointerEvent) {
      if (event.button !== 0 || pointers.size >= 2) return;
      if (!pointers.size) moved = false;
      const target = event.target instanceof HTMLElement && event.target.closest('button')
        ? event.target.closest('button')! : viewport!;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, target });
      target.setPointerCapture(event.pointerId);
      if (pointers.size === 2) moved = true;
      viewport!.classList.add('venueMapDragging');
    }
    function pointerMove(event: PointerEvent) {
      const pointer = pointers.get(event.pointerId);
      if (!pointer) return;
      event.preventDefault();
      if (Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY) > 5) moved = true;
      if (pointers.size === 2) {
        const iterator = pointers.values();
        const first = iterator.next().value!;
        const second = iterator.next().value!;
        const oldDistance = Math.hypot(first.x - second.x, first.y - second.y);
        const oldMidX = (first.x + second.x) / 2;
        const oldMidY = (first.y + second.y) / 2;
        pointer.x = event.clientX;
        pointer.y = event.clientY;
        const distance = Math.hypot(first.x - second.x, first.y - second.y);
        const bounds = viewport!.getBoundingClientRect();
        if (oldDistance > 1) zoomAt(scale * distance / oldDistance, oldMidX - bounds.left, oldMidY - bounds.top);
        x += (first.x + second.x) / 2 - oldMidX;
        y += (first.y + second.y) / 2 - oldMidY;
      } else {
        x += event.clientX - pointer.x;
        y += event.clientY - pointer.y;
        pointer.x = event.clientX;
        pointer.y = event.clientY;
      }
      constrain();
      schedulePaint();
    }
    function pointerEnd(event: PointerEvent) {
      const pointer = pointers.get(event.pointerId);
      if (!pointer) return;
      pointers.delete(event.pointerId);
      if (pointer.target.hasPointerCapture(event.pointerId)) pointer.target.releasePointerCapture(event.pointerId);
      if (!pointers.size) {
        viewport!.classList.remove('venueMapDragging');
        if (moved || event.type !== 'pointerup') lastGestureEnd = performance.now();
      }
    }
    function preventDragClick(event: MouseEvent) {
      // A drag ending on a room must not select it; keyboard activation remains available.
      if (event.detail !== 0 && moved && performance.now() - lastGestureEnd < 400) {
        event.preventDefault();
        event.stopPropagation();
      }
    }
    function wheel(event: WheelEvent) {
      event.preventDefault();
      const bounds = viewport!.getBoundingClientRect();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? height : 1);
      zoomAt(scale * Math.exp(-clamp(delta, -200, 200) * 0.003), event.clientX - bounds.left, event.clientY - bounds.top);
      constrain();
      schedulePaint();
    }
    function keyDown(event: KeyboardEvent) {
      if (event.target !== viewport) return;
      switch (event.key) {
        case '+': case '=': zoom(1.25); break;
        case '-': case '_': zoom(0.8); break;
        case '0': case 'Home': reset(); break;
        case 'ArrowLeft': x += 48; break;
        case 'ArrowRight': x -= 48; break;
        case 'ArrowUp': y += 48; break;
        case 'ArrowDown': y -= 48; break;
        default: return;
      }
      event.preventDefault();
      constrain();
      schedulePaint();
    }

    controlsRef.current = { zoom, reset, center };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    viewport.addEventListener('pointerdown', pointerDown);
    viewport.addEventListener('pointermove', pointerMove);
    viewport.addEventListener('pointerup', pointerEnd);
    viewport.addEventListener('pointercancel', pointerEnd);
    viewport.addEventListener('lostpointercapture', pointerEnd);
    viewport.addEventListener('click', preventDragClick, true);
    viewport.addEventListener('wheel', wheel, { passive: false });
    viewport.addEventListener('keydown', keyDown);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      controlsRef.current = null;
      viewport.removeEventListener('pointerdown', pointerDown);
      viewport.removeEventListener('pointermove', pointerMove);
      viewport.removeEventListener('pointerup', pointerEnd);
      viewport.removeEventListener('pointercancel', pointerEnd);
      viewport.removeEventListener('lostpointercapture', pointerEnd);
      viewport.removeEventListener('click', preventDragClick, true);
      viewport.removeEventListener('wheel', wheel);
      viewport.removeEventListener('keydown', keyDown);
      for (const [id, pointer] of pointers) {
        if (pointer.target.hasPointerCapture(id)) pointer.target.releasePointerCapture(id);
      }
      pointers.clear();
    };
  }, [floor, floorInfo]);

  useLayoutEffect(() => {
    selectionRef.current = selectedRegionId;
    if (selectedRegionId) controlsRef.current?.center(selectedRegionId);
    else controlsRef.current?.reset();
  }, [selectedRegionId]);

  return (
    <figure className="venueMap">
      <div className="venueMapToolbar" aria-label="地图操作">
        <span className="venueMapFloorLabel">{floor}F <span>{floorInfo.label}原图</span></span>
        <div className="venueMapZoomControls">
          <button type="button" aria-label="缩小地图" onClick={() => controlsRef.current?.zoom(0.8)}>−</button>
          <output ref={zoomLabelRef} aria-label="地图缩放比例">100%</output>
          <button type="button" aria-label="放大地图" onClick={() => controlsRef.current?.zoom(1.25)}>+</button>
        </div>
        <button type="button" className="venueMapReset" onClick={() => controlsRef.current?.reset()}>全图</button>
        <button type="button" className="venueMapFacilities" aria-pressed={showFacilities} onClick={() => setShowFacilities(value => !value)}>厅区 / 设施</button>
        <a className="venueMapOriginal" href={imageUrl} target="_blank" rel="noreferrer">查看原图 ↗</a>
      </div>
      <div className="venueMapCanvas">
        <div
          ref={viewportRef}
          className="venueMapViewport"
          tabIndex={0}
          role="region"
          aria-label={`西安国际会议中心${floorInfo.label}交互地图`}
          aria-describedby={helpId}
          aria-busy={imageState === 'loading'}
        >
          <div ref={planeRef} className="venueMapPlane" style={{ visibility: imageState === 'ready' ? 'visible' : 'hidden' }}>
            <img
              key={retry}
              src={retry ? `${imageUrl}?retry=${retry}` : imageUrl}
              width={floorInfo.width}
              height={floorInfo.height}
              alt={`西安国际会议中心${floorInfo.label}提供的原始平面图；原图注释可能与本届会场配置不同`}
              draggable={false}
              onLoad={() => setImageState('ready')}
              onError={() => setImageState('error')}
            />
            {regions.filter(region => region.kind === 'room' || showFacilities || region.id === selectedRegionId).map(region => (
              <button
                key={region.id}
                type="button"
                className={`venueMapMarker venueMapMarker-${region.kind}`}
                style={{ left: `${region.x}%`, top: `${region.y}%` }}
                aria-label={`${region.label}，${region.note}`}
                aria-pressed={selectedRegionId === region.id}
                title={`${region.label}：${region.note}`}
                onClick={() => onSelectRegion(region.id)}
                onFocus={event => {
                  if (event.currentTarget.matches(':focus-visible')) controlsRef.current?.center(region.id);
                }}
              ><span>{region.label.replace('（原图）', '').replace('（原图用餐区）', '·用餐区').replace('多功能厅', '厅')}</span></button>
            ))}
          </div>
        </div>
        {imageState === 'loading' && <div className="venueMapStatus" role="status"><strong>正在载入{floorInfo.label}原图…</strong></div>}
        {imageState === 'error' && (
          <div className="venueMapStatus venueMapError" role="alert">
            <strong>楼层原图未能载入</strong>
            <p>当前无法显示可靠的图上位置，请重试或打开原图。</p>
            <div>
              <button type="button" onClick={() => { setImageState('loading'); setRetry(value => value + 1); }}>重新载入</button>
              <a href={imageUrl} target="_blank" rel="noreferrer">查看原图 ↗</a>
            </div>
          </div>
        )}
      </div>
      <figcaption className="venueMapCaption">
        <p id={helpId}>拖动平移 · 滚轮 / 双指缩放 · 键盘聚焦地图后用方向键平移、+/− 缩放、0 复位；Tab 选择区域。</p>
        <p><span className="venueMapLegendRoom">编号会场</span><span className="venueMapLegendService">原图厅区 / 服务设施</span><span>示意点不代表门位或推荐路线；原图箭头与文字不一定是本届配置。</span></p>
      </figcaption>
    </figure>
  );
}
