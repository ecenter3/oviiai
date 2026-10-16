/**
 * 導航與巡邏排程的純函式（工程開發手冊 後端邏輯 §4），方便測試。
 */
export type Repeat = 'daily' | 'weekdays' | 'weekends' | 'once';
export const REPEATS: Repeat[] = ['daily', 'weekdays', 'weekends', 'once'];

/** 排程遲到超過這個時間就不補跑（技術設計文件：BullMQ 補跑遲到 30 分鐘內的工作） */
export const LATE_LIMIT_MS = 30 * 60_000;
/** 指定的機器人不能執行時，任務最多留在佇列這麼久，之後 failed（後端邏輯 §4） */
export const PINNED_WAIT_MS = 30 * 60_000;

/** 'HH:MM' 或 'HH:MM:SS' → [時, 分] */
export function parseTime(t: string): [number, number] {
  const m = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(t);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`時間格式錯誤：${t}`);
  return [Number(m[1]), Number(m[2])];
}

/** 重複方式 → cron（Asia/Taipei 解讀）；僅一次回 null */
export function cronOf(startTime: string, repeat: Repeat): string | null {
  const [h, m] = parseTime(startTime);
  switch (repeat) {
    case 'daily':
      return `${m} ${h} * * *`;
    case 'weekdays':
      return `${m} ${h} * * 1-5`;
    case 'weekends':
      return `${m} ${h} * * 0,6`;
    case 'once':
      return null;
  }
}

/** 僅一次：台北時間 onceDate startTime → UTC 毫秒 */
export function onceAt(onceDate: string, startTime: string): number {
  const [h, m] = parseTime(startTime);
  return Date.parse(`${onceDate}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+08:00`);
}

export interface Waypoint {
  x: number;
  y: number;
  yaw?: number;
  dwellSec?: number;
  action?: string;
}

/** 路徑長度（公尺，相鄰航點直線距離總和，取到小數一位） */
export function pathLength(points: Pick<Waypoint, 'x' | 'y'>[]): number {
  let d = 0;
  for (let i = 1; i < points.length; i++) d += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  return Math.round(d * 10) / 10;
}

/** 點都在樓層範圍內（樓層沒設尺寸就只檢查非負） */
export function inFloor(points: { x: number; y: number }[], floor: { w: number | null; h: number | null }): boolean {
  return points.every((p) => p.x >= 0 && p.y >= 0 && (floor.w === null || p.x <= floor.w) && (floor.h === null || p.y <= floor.h));
}

/**
 * 指定機器人的排程任務為什麼不能派（null = 可以）：離線、急停、故障、遙控中、電量低於接單門檻。
 * 回傳的文字放進延後告警。
 */
export function unavailableReason(
  r: { online: boolean; state: string; battery: number; teleopLocked: boolean } | null,
  minAccept: number,
): string | null {
  if (!r || !r.online) return '離線';
  if (r.state === 'estop') return '急停中';
  if (r.state === 'fault') return '故障';
  if (r.teleopLocked || r.state === 'teleop') return '遙控中';
  if (r.battery < minAccept) return `電量 ${r.battery.toFixed(0)}% 低於接單門檻 ${minAccept}%`;
  return null;
}
