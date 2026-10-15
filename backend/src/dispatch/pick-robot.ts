/**
 * 選車（工程開發手冊 後端邏輯 §2「選車演算法」），純函式，方便測試。
 * 距離為主（第一期用直線距離），同距離選電量高：score = 距離 − 電量 × 0.01。
 */
import type { Priority } from './task-state';

export interface Candidate {
  robotId: string;
  code: string;
  floor: string;
  online: boolean;
  /** 資料庫啟用中（registry 有登記） */
  enabled: boolean;
  state: string;
  battery: number;
  x: number;
  y: number;
  caps: string[];
  teleopLocked: boolean;
  /** 已有 assigned／running 的任務（機器人狀態可能還沒從遙測反映出來） */
  busy: boolean;
  /** 手上任務的優先級（P1 插隊選對象用）；沒有任務為 null */
  taskPriority?: Priority | null;
}

export interface QueuedTask {
  id: string;
  priority: Priority;
  createdAt: Date;
  floorId: string;
  /** 指定機器人（pinned）或上次執行的機器人（暫停後續做時優先派回） */
  robotId: string | null;
  pinnedRobot: boolean;
  target: { x: number; y: number };
  requiredCaps: string[];
  /** 續做時保留給 robotId 到這個時間（ms）；期間只派原本那台（PR #6 審查第 2 點） */
  reservedUntil?: number | null;
}

export interface PickSettings {
  minAccept: number;
}

export function eligible(r: Candidate, task: QueuedTask, s: PickSettings): boolean {
  return (
    r.floor === task.floorId &&
    r.online &&
    r.enabled &&
    r.state === 'idle' &&
    !r.teleopLocked &&
    !r.busy &&
    r.battery >= s.minAccept &&
    task.requiredCaps.every((c) => r.caps.includes(c))
  );
}

/**
 * 續做時原本那台：除了待命，也接受「暫停」——遙控歸還、插隊結束後機器人可能仍停在 paused，
 * 由派工重新送 navigate／patrol 接續，不靠機器人自己的 resume。
 */
function eligibleToResume(r: Candidate, task: QueuedTask, s: PickSettings): boolean {
  return r.robotId === task.robotId && (eligible(r, task, s) || eligible({ ...r, state: r.state === 'paused' ? 'idle' : r.state }, task, s));
}

export function pickRobot(task: QueuedTask, robots: Candidate[], s: PickSettings, now = Date.now()): Candidate | null {
  if (task.pinnedRobot) return robots.find((r) => r.robotId === task.robotId && eligibleToResume(r, task, s)) ?? null;
  // 保留期內只派原本那台；它暫時不能接（還在遙控剛結束的過渡）就等，不給別台
  if (task.robotId && task.reservedUntil && now < task.reservedUntil) {
    return robots.find((r) => eligibleToResume(r, task, s)) ?? null;
  }
  // 暫停後回到佇列的任務：原本那台可用就派回同一台（從中斷處續做）
  const previous = task.robotId ? robots.find((r) => eligibleToResume(r, task, s)) : undefined;
  if (previous) return previous;
  const cands = robots.filter((r) => eligible(r, task, s));
  if (!cands.length) return null;
  let best = cands[0];
  let bestScore = score(best, task);
  for (const r of cands.slice(1)) {
    const sc = score(r, task);
    if (sc < bestScore) [best, bestScore] = [r, sc];
  }
  return best;
}

function score(r: Candidate, task: QueuedTask): number {
  return Math.hypot(r.x - task.target.x, r.y - task.target.y) - r.battery * 0.01;
}

const PRIO: Record<Priority, number> = { P1: 1, P2: 2, P3: 3, P4: 4 };

/** 佇列順序：P1 > P2 > P3 > P4，同級先建先做 */
export function queueOrder(a: Pick<QueuedTask, 'priority' | 'createdAt'>, b: Pick<QueuedTask, 'priority' | 'createdAt'>): number {
  return PRIO[a.priority] - PRIO[b.priority] || a.createdAt.getTime() - b.createdAt.getTime();
}

/**
 * 一個樓層一輪派工：依佇列順序逐筆選車，選到的機器人在這一輪標為忙碌，
 * 同一輪不會把同一台派給兩筆任務。回傳 [任務, 機器人] 配對。
 */
export function planRound(tasks: QueuedTask[], robots: Candidate[], s: PickSettings, now = Date.now()): [QueuedTask, Candidate][] {
  const pool = robots.map((r) => ({ ...r }));
  const out: [QueuedTask, Candidate][] = [];
  for (const task of [...tasks].sort(queueOrder)) {
    const r = pickRobot(task, pool, s, now);
    if (!r) continue;
    r.busy = true;
    out.push([task, r]);
  }
  return out;
}

/**
 * P1 插隊對象（後端邏輯 §2「P1 插隊」第 2 步）：同樓層、在線、啟用、沒被遙控、
 * 正在執行非 P1 任務、電量 ≥ minAccept、不在急停或故障 → 離 P1 目標最近的那台。
 */
export function pickPreemptVictim(p1: QueuedTask, robots: Candidate[], s: PickSettings): Candidate | null {
  const cands = robots.filter(
    (r) =>
      r.floor === p1.floorId &&
      r.online &&
      r.enabled &&
      !r.teleopLocked &&
      r.busy &&
      !!r.taskPriority &&
      r.taskPriority !== 'P1' &&
      r.battery >= s.minAccept &&
      r.state !== 'estop' &&
      r.state !== 'fault' &&
      p1.requiredCaps.every((c) => r.caps.includes(c)),
  );
  if (!cands.length) return null;
  return cands.reduce((a, b) => (dist(b, p1) < dist(a, p1) ? b : a));
}

const dist = (r: Candidate, t: QueuedTask) => Math.hypot(r.x - t.target.x, r.y - t.target.y);
