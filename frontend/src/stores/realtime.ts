import { create } from 'zustand';

/** WebSocket robot.state（與後端 fleet LiveState 相同） */
export interface RobotLive {
  robotId: string;
  code: string;
  floor: string;
  online: boolean;
  ts: number;
  x: number;
  y: number;
  yaw: number;
  battery: number;
  charging: boolean;
  state: string;
  speed: number | null;
  taskId: string | null;
  rssi: number | null;
  faults: { code: string; level: 1 | 2 | 3; msg: string }[];
}

export interface CmdResult {
  cmdId: string;
  robotId: string;
  code: string;
  type: string;
  status: 'accepted' | 'rejected' | 'done' | 'failed';
  error?: { code: string; msg: string };
  result?: Record<string, unknown>;
}

/** WebSocket stats.tick（系統規格書 §4.1 統計卡） */
export interface Stats {
  ts: number;
  total: number;
  online: number;
  working: number;
  charging: number;
  fault: number;
  todayTasks: number;
  openAlarms: number;
}

export type Conn = 'connecting' | 'connected' | 'disconnected' | 'forbidden';

interface RealtimeState {
  conn: Conn;
  /** 目前頁面需要即時狀態的樓層；WebSocket 只訂閱這些（介面規格 §4：只收關心樓層） */
  watch: string[];
  robots: Record<string, RobotLive>;
  cmdResults: CmdResult[];
  stats: Stats | null;
  setConn(c: Conn): void;
  setWatch(floors: string[]): void;
  upsert(r: RobotLive): void;
  setOnline(code: string, online: boolean, removed?: boolean): void;
  addCmdResult(r: CmdResult): void;
  setStats(s: Stats): void;
  clear(): void;
}

export const useRealtime = create<RealtimeState>((set) => ({
  conn: 'disconnected',
  watch: [],
  robots: {},
  cmdResults: [],
  stats: null,
  setConn: (conn) => set({ conn }),
  setWatch: (watch) =>
    set((s) => {
      if (watch.join() === s.watch.join()) return s;
      // 不再關心的樓層從畫面移除；新樓層的全量狀態由訂閱回應補上
      const robots = Object.fromEntries(Object.entries(s.robots).filter(([, r]) => watch.includes(r.floor)));
      return { watch, robots };
    }),
  upsert: (r) => set((s) => (s.watch.includes(r.floor) ? { robots: { ...s.robots, [r.code]: r } } : s)),
  setOnline: (code, online, removed) =>
    set((s) => {
      if (removed) {
        const { [code]: _, ...rest } = s.robots;
        return { robots: rest };
      }
      const r = s.robots[code];
      return r ? { robots: { ...s.robots, [code]: { ...r, online } } } : s;
    }),
  addCmdResult: (r) => set((s) => ({ cmdResults: [r, ...s.cmdResults].slice(0, 50) })),
  setStats: (stats) => set({ stats }),
  clear: () => set({ robots: {}, cmdResults: [], stats: null, conn: 'disconnected' }),
}));
