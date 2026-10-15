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

export type Conn = 'connecting' | 'connected' | 'disconnected' | 'forbidden';

const FLOOR_KEY = 'oviiai.floor';

function loadFloor(): string {
  try {
    return localStorage.getItem(FLOOR_KEY) ?? 'all';
  } catch {
    return 'all';
  }
}

interface RealtimeState {
  conn: Conn;
  /** 'all' 或樓層 id；上方列的樓層選擇，WebSocket 只訂閱這些樓層 */
  floor: string;
  robots: Record<string, RobotLive>;
  cmdResults: CmdResult[];
  setConn(c: Conn): void;
  setFloor(f: string): void;
  upsert(r: RobotLive): void;
  setOnline(code: string, online: boolean, removed?: boolean): void;
  addCmdResult(r: CmdResult): void;
  clear(): void;
}

export const useRealtime = create<RealtimeState>((set) => ({
  conn: 'disconnected',
  floor: loadFloor(),
  robots: {},
  cmdResults: [],
  setConn: (conn) => set({ conn }),
  setFloor: (floor) => {
    try {
      localStorage.setItem(FLOOR_KEY, floor);
    } catch {
      /* 私密模式等情況：不記住也沒關係 */
    }
    set({ floor, robots: {} });
  },
  upsert: (r) => set((s) => ({ robots: { ...s.robots, [r.code]: r } })),
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
  clear: () => set({ robots: {}, cmdResults: [], conn: 'disconnected' }),
}));
