import {
  forwardRef,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { t } from '../../i18n';
import {
  estimateSize,
  fit,
  fromScreen,
  gridStep,
  pan,
  type Pt,
  robotTone,
  type Size,
  toScreen,
  type Viewport,
  yawToSvgDeg,
  zoomAt,
} from './geometry';

export interface MapRobot {
  id: string;
  code: string;
  x: number;
  y: number;
  yaw: number;
  state: string;
  online: boolean;
  battery: number;
  /** 滑鼠移上去顯示的說明（例：B2-001 · 巡邏中 · 82%） */
  tip?: string;
}
export interface MapCamera {
  id: string;
  name: string;
  x: number;
  y: number;
}
export interface MapCharger {
  id: string;
  code: string;
  x: number;
  y: number;
  occupiedBy?: string | null;
}
export interface MapPath {
  id: string;
  points: Pt[];
  color?: string;
}
export interface MapZone {
  id: string;
  kind: 'forbidden' | 'slow' | 'silent';
  polygon: Pt[];
}
export interface MapAlarm {
  id: string;
  x: number;
  y: number;
  label?: string;
}

export interface FloorMapProps {
  /** 樓層實際尺寸（公尺）；未設定時以點位估算 */
  widthM?: number | null;
  heightM?: number | null;
  /** 平面圖網址；沒有就畫公尺格線 */
  planUrl?: string | null;
  robots?: MapRobot[];
  cameras?: MapCamera[];
  chargers?: MapCharger[];
  paths?: MapPath[];
  zones?: MapZone[];
  alarms?: MapAlarm[];
  selectedRobotId?: string | null;
  onRobotClick?: (id: string) => void;
  onCameraClick?: (id: string) => void;
  onChargerClick?: (id: string) => void;
  /** 點選取座標模式（導航管理、座標校正）：點地圖回傳平台座標 */
  pickMode?: boolean;
  onPick?: (p: Pt) => void;
  /** 換樓層時給不同的 key，視角會重新置中 */
  viewKey?: string;
  /** 疊在地圖上方的內容（樓層標籤、圖例） */
  children?: ReactNode;
  className?: string;
}

export interface FloorMapHandle {
  zoomIn(): void;
  zoomOut(): void;
  fit(): void;
}

const DRAG_PX = 4;
const FALLBACK: Size = { w: 800, h: 600 };

/**
 * 平面圖元件（前端頁面 §2、T-13）。
 * 底圖、格線、區域、路徑畫在公尺座標；點位標記畫在螢幕座標，縮放時大小不變。
 * 滾輪以游標為中心縮放、拖曳平移；pickMode 時點一下回傳平台座標。
 */
export const FloorMap = forwardRef<FloorMapHandle, FloorMapProps>(function FloorMap(props, ref) {
  const {
    planUrl,
    robots = [],
    cameras = [],
    chargers = [],
    paths = [],
    zones = [],
    alarms = [],
    selectedRobotId,
    pickMode,
    viewKey,
  } = props;

  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<Size>(FALLBACK);
  const [hover, setHover] = useState<string | null>(null);
  const [interacting, setInteracting] = useState(false);
  const drag = useRef<{ x: number; y: number; moved: boolean; id: number } | null>(null);

  const floor: Size = useMemo(() => {
    if (props.widthM && props.heightM) return { w: props.widthM, h: props.heightM };
    return estimateSize([...robots, ...cameras, ...chargers, ...alarms]);
    // 未設定尺寸時只在換樓層時估一次，避免機器人移動時整張圖一直縮放
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.widthM, props.heightM, viewKey]);

  const fitted = useMemo(() => fit(floor, view), [floor, view]);
  const [vp, setVp] = useState<Viewport>(fitted);

  // 換樓層、改尺寸、改視窗大小：重新置中
  useEffect(() => setVp(fitted), [fitted, viewKey]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      if (el.clientWidth > 0 && el.clientHeight > 0) setView({ w: el.clientWidth, h: el.clientHeight });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const zoomBy = useCallback(
    (factor: number, at?: Pt) => {
      setInteracting(true);
      setVp((v) => zoomAt(v, factor, at ?? { x: view.w / 2, y: view.h / 2 }, fitted.scale));
    },
    [view, fitted.scale],
  );

  useImperativeHandle(ref, () => ({
    zoomIn: () => zoomBy(1.25),
    zoomOut: () => zoomBy(0.8),
    fit: () => setVp(fitted),
  }));

  // React 的 onWheel 是 passive，不能 preventDefault；改用原生事件
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomBy(Math.exp(-e.deltaY * 0.0015), { x: e.clientX - r.left, y: e.clientY - r.top });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomBy]);

  // 縮放、拖曳時暫停標記的移動動畫，否則標記會跟不上地圖
  useEffect(() => {
    if (!interacting) return;
    const id = setTimeout(() => setInteracting(false), 200);
    return () => clearTimeout(id);
  }, [interacting, vp]);

  function onPointerDown(e: ReactPointerEvent) {
    if (e.button !== 0) return;
    drag.current = { x: e.clientX, y: e.clientY, moved: false, id: e.pointerId };
  }
  function onPointerMove(e: ReactPointerEvent) {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < DRAG_PX) return;
    if (!d.moved) (e.currentTarget as Element).setPointerCapture?.(d.id);
    d.moved = true;
    d.x = e.clientX;
    d.y = e.clientY;
    setInteracting(true);
    setVp((v) => pan(v, dx, dy));
  }
  function onPointerUp(e: ReactPointerEvent) {
    const d = drag.current;
    drag.current = null;
    if (!d || d.moved || !pickMode || !props.onPick) return;
    // 點在標記上是選取標記，不是取座標
    if ((e.target as Element).closest?.('.fm-robot, .fm-cam, .fm-dock')) return;
    const r = (e.currentTarget as Element).getBoundingClientRect();
    const p = fromScreen({ x: e.clientX - r.left, y: e.clientY - r.top }, floor.h, vp);
    props.onPick({ x: round2(p.x), y: round2(p.y) });
  }

  const sc = (p: Pt) => toScreen(p, floor.h, vp);
  const meters = `translate(${vp.tx} ${vp.ty}) scale(${vp.scale})`;
  const flipY = (p: Pt) => `${p.x},${floor.h - p.y}`;
  const step = gridStep(vp.scale);
  const hovered = robots.find((r) => r.id === (hover ?? selectedRobotId));

  return (
    <div
      ref={box}
      className={`floormap${pickMode ? ' picking' : ''}${interacting ? ' interacting' : ''} ${props.className ?? ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => (drag.current = null)}
    >
      <svg width={view.w} height={view.h} role="img" aria-label={t('page.monitor')}>
        <g transform={meters}>
          <rect className="fm-floor" x={0} y={0} width={floor.w} height={floor.h} />
          {planUrl ? (
            <image href={planUrl} x={0} y={0} width={floor.w} height={floor.h} preserveAspectRatio="none" />
          ) : (
            <g className="fm-grid">
              {range(0, floor.w, step).map((x) => (
                <line key={`x${x}`} x1={x} y1={0} x2={x} y2={floor.h} className={x % (step * 5) === 0 ? 'major' : ''} />
              ))}
              {range(0, floor.h, step).map((y) => (
                <line key={`y${y}`} x1={0} y1={floor.h - y} x2={floor.w} y2={floor.h - y} className={y % (step * 5) === 0 ? 'major' : ''} />
              ))}
            </g>
          )}
          {zones.map((z) => (
            <polygon key={z.id} className={`fm-zone ${z.kind}`} points={z.polygon.map(flipY).join(' ')} />
          ))}
          {paths.map((p) => (
            <polyline key={p.id} className="fm-path" points={p.points.map(flipY).join(' ')} style={p.color ? { stroke: p.color } : undefined} />
          ))}
        </g>

        {cameras.map((c) => {
          const s = sc(c);
          return (
            <g
              key={c.id}
              className="fm-cam"
              transform={`translate(${s.x} ${s.y})`}
              role="button"
              aria-label={t('map.camera', { name: c.name })}
              onClick={() => props.onCameraClick?.(c.id)}
            >
              <title>{t('map.camera', { name: c.name })}</title>
              <path d="M0,-8 L8,6 L-8,6 Z" />
            </g>
          );
        })}

        {chargers.map((c) => {
          const s = sc(c);
          const label = c.occupiedBy ? t('map.chargerBusy', { code: c.code, robot: c.occupiedBy }) : t('map.charger', { code: c.code });
          return (
            <g
              key={c.id}
              className={`fm-dock${c.occupiedBy ? ' busy' : ''}`}
              transform={`translate(${s.x} ${s.y})`}
              role="button"
              aria-label={label}
              onClick={() => props.onChargerClick?.(c.id)}
            >
              <title>{label}</title>
              <rect x={-11} y={-9} width={22} height={18} rx={3} />
              <text y={4}>⚡</text>
            </g>
          );
        })}

        {alarms.map((a) => {
          const s = sc(a);
          return (
            <g key={a.id} className="fm-alarm" transform={`translate(${s.x} ${s.y})`}>
              <title>{a.label ?? ''}</title>
              <rect x={-9} y={-7} width={18} height={14} rx={3} />
            </g>
          );
        })}

        {robots.map((r) => {
          const s = sc(r);
          const tone = robotTone(r.state, r.online);
          const sel = r.id === selectedRobotId;
          return (
            <g
              key={r.id}
              className={`fm-robot tone-${tone}${sel ? ' sel' : ''}`}
              style={{ transform: `translate(${s.x}px, ${s.y}px)` }}
              role="button"
              tabIndex={0}
              aria-label={t('map.robot', { code: r.code })}
              aria-pressed={sel}
              data-robot={r.code}
              onClick={() => props.onRobotClick?.(r.id)}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && props.onRobotClick?.(r.id)}
              onPointerEnter={() => setHover(r.id)}
              onPointerLeave={() => setHover((h) => (h === r.id ? null : h))}
            >
              {/* 朝向：膠囊外的三角形指向機器人前方 */}
              <g className="fm-heading" transform={`rotate(${yawToSvgDeg(r.yaw)})`}>
                <path d="M19,0 L13,-5 L13,5 Z" />
              </g>
              <rect className="fm-body" x={-15} y={-9} width={30} height={18} rx={9} />
              <text y={3.5}>{Math.round(r.battery)}%</text>
            </g>
          );
        })}
      </svg>

      {hovered && (
        <div className="fm-tip" style={{ left: sc(hovered).x, top: sc(hovered).y }}>
          {hovered.tip ?? hovered.code}
        </div>
      )}
      {props.children}
    </div>
  );
});

function range(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  for (let v = from; v <= to + 1e-9; v += step) out.push(Math.round(v * 1000) / 1000);
  return out;
}

const round2 = (v: number) => Math.round(v * 100) / 100;
