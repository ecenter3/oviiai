/**
 * 平面圖座標換算。
 *
 * 平台座標（MQTT、資料庫、API 一律用這個）：公尺，原點在平面圖左下角，x 向右、y 向上，
 * 朝向 yaw 為弧度、逆時針為正。與機器人地圖（ROS 慣例）同為右手座標，座標校正的仿射轉換不需要鏡射。
 * 螢幕座標：像素，原點在元件左上角，y 向下。換算時 y 翻轉一次。
 */
export interface Pt {
  x: number;
  y: number;
}

/** 螢幕 = (x × scale + tx, (H − y) × scale + ty)；scale 單位為像素／公尺 */
export interface Viewport {
  scale: number;
  tx: number;
  ty: number;
}

export interface Size {
  w: number;
  h: number;
}

export const ZOOM_MIN = 0.5; // 相對於「剛好放進畫面」的倍率
export const ZOOM_MAX = 12;

export function toScreen(p: Pt, heightM: number, vp: Viewport): Pt {
  return { x: p.x * vp.scale + vp.tx, y: (heightM - p.y) * vp.scale + vp.ty };
}

export function fromScreen(s: Pt, heightM: number, vp: Viewport): Pt {
  return { x: (s.x - vp.tx) / vp.scale, y: heightM - (s.y - vp.ty) / vp.scale };
}

/** 整張平面圖剛好放進畫面並置中 */
export function fit(floor: Size, view: Size, pad = 24): Viewport {
  const scale = Math.max(0.01, Math.min((view.w - 2 * pad) / floor.w, (view.h - 2 * pad) / floor.h));
  return { scale, tx: (view.w - floor.w * scale) / 2, ty: (view.h - floor.h * scale) / 2 };
}

/** 以螢幕上某一點為中心縮放（滑鼠滾輪、按鈕以畫面中心），倍率限制在 fitScale × [ZOOM_MIN, ZOOM_MAX] */
export function zoomAt(vp: Viewport, factor: number, at: Pt, fitScale: number): Viewport {
  const scale = clamp(vp.scale * factor, fitScale * ZOOM_MIN, fitScale * ZOOM_MAX);
  const k = scale / vp.scale;
  return { scale, tx: at.x - (at.x - vp.tx) * k, ty: at.y - (at.y - vp.ty) * k };
}

export function pan(vp: Viewport, dx: number, dy: number): Viewport {
  return { ...vp, tx: vp.tx + dx, ty: vp.ty + dy };
}

/** 平台 yaw（逆時針弧度）→ SVG rotate 角度（順時針度數） */
export function yawToSvgDeg(yaw: number): number {
  return (-yaw * 180) / Math.PI;
}

/**
 * 樓層尚未設定尺寸（地圖管理 T-25）時，以畫面上所有點位估算範圍：
 * 原點固定在 (0,0)，右上角取最大座標再留 20%，至少 20 × 15 公尺。
 */
export function estimateSize(points: Pt[]): Size {
  const maxX = Math.max(0, ...points.map((p) => p.x));
  const maxY = Math.max(0, ...points.map((p) => p.y));
  return { w: Math.max(20, Math.ceil(maxX * 1.2)), h: Math.max(15, Math.ceil(maxY * 1.2)) };
}

/** 依目前比例選格線間距：線距至少約 24 像素 */
export function gridStep(scale: number): number {
  for (const step of [0.5, 1, 2, 5, 10, 20, 50]) if (step * scale >= 24) return step;
  return 100;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** 機器人在地圖上的顏色分類（原型：執行中藍、待命綠、充電橘、手動紫、急停紅閃爍） */
export type RobotTone = 'working' | 'idle' | 'charge' | 'manual' | 'estop' | 'fault' | 'paused' | 'offline';

export function robotTone(state: string, online: boolean): RobotTone {
  if (!online || state === 'offline') return 'offline';
  switch (state) {
    case 'estop':
      return 'estop';
    case 'fault':
      return 'fault';
    case 'teleop':
      return 'manual';
    case 'charging':
    case 'returning':
      return 'charge';
    case 'idle':
      return 'idle';
    case 'paused':
      return 'paused';
    default:
      return 'working';
  }
}
