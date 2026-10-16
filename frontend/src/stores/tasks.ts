import { create } from 'zustand';

/** 與後端 TaskView 相同 */
export interface Task {
  id: string;
  code: string;
  kind: string;
  priority: 'P1' | 'P2' | 'P3' | 'P4';
  source: string;
  floorId: string;
  target: { poiId: string } | { pathId: string } | { x: number; y: number; yaw?: number };
  robotId: string | null;
  robotCode: string | null;
  pinnedRobot: boolean;
  status: 'pending_approval' | 'queued' | 'assigned' | 'running' | 'paused' | 'done' | 'cancelled' | 'failed' | 'rejected';
  note: string | null;
  createdBy?: string | null;
  createdByName?: string | null;
  approvedByName?: string | null;
  approvedAt?: string | null;
  rejectReason?: string | null;
  /** 被哪筆 P1 中斷 */
  preemptedBy?: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  failReason: string | null;
  progress: { pausedBy?: string | null; noRobotAt?: number | null };
}

/** GET /dispatch/mode */
export interface DispatchMode {
  approval: boolean;
  approvalSetting: boolean;
  approvalUntil: string | null;
  p1Preempt: boolean;
  /** 待審批筆數 */
  pending: number;
}

export const ACTIVE_STATUSES: Task['status'][] = ['pending_approval', 'queued', 'assigned', 'running', 'paused'];

interface TasksState {
  /** 進行中的任務（未結束），依 id；結束的會移除 */
  active: Record<string, Task>;
  /** 第一次載入（GET /tasks）完成 */
  loaded: boolean;
  load(tasks: Task[]): void;
  update(t: Task): void;
}

/** WebSocket task.updated 寫入；實時監控、機器人狀態頁共用 */
export const useTasks = create<TasksState>((set) => ({
  active: {},
  loaded: false,
  load: (tasks) => set({ active: Object.fromEntries(tasks.filter((t) => ACTIVE_STATUSES.includes(t.status)).map((t) => [t.id, t])), loaded: true }),
  update: (t) =>
    set((s) => {
      if (ACTIVE_STATUSES.includes(t.status)) return { active: { ...s.active, [t.id]: t } };
      if (!s.active[t.id]) return s;
      const { [t.id]: _, ...rest } = s.active;
      return { active: rest };
    }),
}));
