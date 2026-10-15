import { io, type Socket } from 'socket.io-client';
import { getToken, refresh } from '../api/session';
import { type CmdResult, type RobotLive, useRealtime } from '../stores/realtime';

let socket: Socket | null = null;
let floorsProvider: () => string[] = () => [];

/**
 * 單一 Socket.IO 連線（前端架構：即時資料）。
 * - 每次（重新）連線都用目前記憶體裡的 access token
 * - 後端以 token 到期主動斷線（auth.expired）或連線時回 TOKEN_EXPIRED → refresh 後重連
 * - 連上後訂閱上方列選的樓層；換樓層重送 subscribe
 */
export function connectRealtime(floors: () => string[]): void {
  floorsProvider = floors;
  if (socket) return;
  const rt = useRealtime.getState();
  rt.setConn('connecting');

  socket = io({
    path: '/ws',
    transports: ['websocket'],
    auth: (cb) => cb({ token: getToken() }),
    reconnectionDelayMax: 5_000,
  });

  socket.on('connect', () => {
    useRealtime.getState().setConn('connected');
    void resubscribe();
  });

  socket.on('connect_error', (err: Error & { data?: { code?: string } }) => {
    const code = err.data?.code;
    if (code === 'FORBIDDEN') {
      useRealtime.getState().setConn('forbidden');
      return;
    }
    useRealtime.getState().setConn('disconnected');
    // 中介層拒絕（驗證失敗）時 Socket.IO 不會自動重連：換 token 後手動重連
    if (code === 'TOKEN_EXPIRED' || code === 'UNAUTHENTICATED') void reauth();
  });

  socket.on('disconnect', (reason) => {
    useRealtime.getState().setConn('disconnected');
    // 伺服器主動斷線（token 到期）不會自動重連
    if (reason === 'io server disconnect') void reauth();
  });

  socket.on('robot.state', (m: RobotLive) => {
    const s = useRealtime.getState();
    if (s.floor === 'all' || s.floor === m.floor) s.upsert(m);
  });
  socket.on('robot.online', (m: { code: string; online: boolean; removed?: boolean }) =>
    useRealtime.getState().setOnline(m.code, m.online, m.removed),
  );
  socket.on('robot.cmdResult', (m: CmdResult) => useRealtime.getState().addCmdResult(m));
}

async function reauth() {
  const token = await refresh().catch(() => null);
  if (token && socket && !socket.connected) socket.connect();
}

/** 換樓層後呼叫 */
export async function resubscribe(): Promise<void> {
  if (!socket?.connected) return;
  await socket.emitWithAck('subscribe', { floors: floorsProvider() });
}

export function disconnectRealtime(): void {
  socket?.removeAllListeners();
  socket?.disconnect();
  socket = null;
  useRealtime.getState().clear();
}

/** 遙控速度（實時遙控頁 T-30 使用）：每 100 ms 一筆 */
export function sendTeleop(m: { robotId: string; lockId: string; vx: number; vy: number; wz: number }): void {
  socket?.volatile.emit('teleop.cmd', m);
}
