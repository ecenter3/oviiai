/**
 * 充電排程的判斷（工程開發手冊 後端邏輯 §3），純函式方便測試。
 */
export interface ChargeSettings {
  /** 回充門檻（%）：電量 ≤ 這個值且沒在充電 → 回充 */
  returnAt: number;
  /** 充電完成（%）：充到這個值、有人排隊就離樁讓位 */
  resumeAt: number;
}

export interface ChargerInfo {
  id: string;
  code: string;
  floor: string;
  x: number;
  y: number;
  /** 只供該品牌使用（資料值比對，不寫死品牌） */
  brand: string;
  enabled: boolean;
  robotDock: unknown;
}

export interface RobotChargeView {
  robotId: string;
  code: string;
  floor: string;
  brand: string;
  online: boolean;
  state: string;
  battery: number;
  x: number;
  y: number;
  teleopLocked: boolean;
}

/** 電量 ≤ returnAt 且未在充電、不在急停／故障、沒被遙控 → 需要回充 */
export function needsCharge(r: RobotChargeView, s: ChargeSettings): boolean {
  return (
    r.online &&
    r.battery <= s.returnAt &&
    !['charging', 'returning', 'estop', 'fault', 'teleop'].includes(r.state) &&
    !r.teleopLocked
  );
}

/** 可用的樁：同樓層、同品牌、啟用中 */
export function compatible(r: Pick<RobotChargeView, 'floor' | 'brand'>, c: ChargerInfo): boolean {
  return c.enabled && c.floor === r.floor && c.brand === r.brand;
}

/** 同樓層、同品牌、未佔用的樁中選最近者 */
export function pickCharger(r: RobotChargeView, chargers: ChargerInfo[], occupied: ReadonlySet<string>): ChargerInfo | null {
  const free = chargers.filter((c) => compatible(r, c) && !occupied.has(c.id));
  return nearest(r, free);
}

export function nearest<T extends { x: number; y: number }>(p: { x: number; y: number }, list: T[]): T | null {
  let best: T | null = null;
  let d = Infinity;
  for (const c of list) {
    const dd = Math.hypot(c.x - p.x, c.y - p.y);
    if (dd < d) [best, d] = [c, dd];
  }
  return best;
}

/** 排隊順序：電量由低到高（同電量先排先充） */
export function queueOrder(a: { battery: number; since: number }, b: { battery: number; since: number }): number {
  return a.battery - b.battery || a.since - b.since;
}

/**
 * 樁旁等候點：從樁往樓層中心方向退 1.5 公尺，排第 n 個再往外 1 公尺，避免擠在一起。
 * 樓層沒設尺寸時往 +x 方向。
 */
export function waitPoint(c: Pick<ChargerInfo, 'x' | 'y'>, floor: { w: number | null; h: number | null }, index = 0): { x: number; y: number } {
  const cx = floor.w ? floor.w / 2 : c.x + 10;
  const cy = floor.h ? floor.h / 2 : c.y;
  const dx = cx - c.x;
  const dy = cy - c.y;
  const len = Math.hypot(dx, dy) || 1;
  const d = 1.5 + index;
  const clamp = (v: number, max: number | null) => Math.max(0, max ? Math.min(max, v) : v);
  return { x: round2(clamp(c.x + (dx / len) * d, floor.w)), y: round2(clamp(c.y + (dy / len) * d, floor.h)) };
}

/** 充到 resumeAt 且有同品牌的機器人在排隊 → 離樁讓位 */
export function shouldYield(battery: number, s: ChargeSettings, waitingSameBrand: number): boolean {
  return battery >= s.resumeAt && waitingSameBrand > 0;
}

/** 人工充電（換電池）完成判斷：電量比開始時跳升 20 個百分點以上，或已達 resumeAt */
export function manualDone(startPct: number, battery: number, s: ChargeSettings): boolean {
  return battery - startPct >= 20 || battery >= s.resumeAt;
}

const round2 = (v: number) => Math.round(v * 100) / 100;
