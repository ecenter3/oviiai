import { create } from 'zustand';

/** WebSocket teleop.revoked（被接管、急停）與 teleop.error（鎖失效、離線…）：實時遙控頁據此停止送速度 */
export interface TeleopRevoked {
  robotId: string;
  code: string;
  by: string;
  reason: 'takeover' | 'estop';
  at: number;
}
export interface TeleopError {
  code: string;
  reason: 'not_holder' | 'not_found' | 'offline' | 'forbidden' | 'estop' | 'rate_limited';
  at: number;
}

interface TeleopState {
  revoked: TeleopRevoked | null;
  error: TeleopError | null;
  setRevoked(r: Omit<TeleopRevoked, 'at'>): void;
  setError(e: Omit<TeleopError, 'at'>): void;
}

export const useTeleopEvents = create<TeleopState>((set) => ({
  revoked: null,
  error: null,
  setRevoked: (r) => set({ revoked: { ...r, at: Date.now() } }),
  setError: (e) => set({ error: { ...e, at: Date.now() } }),
}));
