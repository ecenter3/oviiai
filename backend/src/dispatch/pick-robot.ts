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

export function pickRobot(task: QueuedTask, robots: Candidate[], s: PickSettings): Candidate | null {
  if (task.pinnedRobot) return robots.find((r) => r.robotId === task.robotId && eligible(r, task, s)) ?? null;
  const cands = robots.filter((r) => eligible(r, task, s));
  if (!cands.length) return null;
  // 暫停後回到佇列的任務：原本那台可用就派回同一台（從中斷處續做）
  const previous = task.robotId && cands.find((r) => r.robotId === task.robotId);
  if (previous) return previous;
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
export function planRound(tasks: QueuedTask[], robots: Candidate[], s: PickSettings): [QueuedTask, Candidate][] {
  const pool = robots.map((r) => ({ ...r }));
  const out: [QueuedTask, Candidate][] = [];
  for (const task of [...tasks].sort(queueOrder)) {
    const r = pickRobot(task, pool, s);
    if (!r) continue;
    r.busy = true;
    out.push([task, r]);
  }
  return out;
}
