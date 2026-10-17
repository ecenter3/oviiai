import { io, type Socket } from 'socket.io-client';
import { api } from '../api/client';
import { getToken, refresh } from '../api/session';
import { t } from '../i18n';
import { type AlarmNew, type AlarmUpdated, useAlarms } from '../stores/alarms';
import { type ChargingFloor, useCharging } from '../stores/charging';
import { type ActiveRecording, useMedia } from '../stores/media';
import { type CmdResult, type RobotLive, type Stats, useRealtime } from '../stores/realtime';
import { type Task, useTasks } from '../stores/tasks';
import { type TeleopError, type TeleopRevoked, useTeleopEvents } from '../stores/teleop';
import { useToast } from '../stores/toast';
import { playAlarm } from './sound';

let socket: Socket | null = null;
let unwatch: (() => void) | null = null;

/**
 * 單一 Socket.IO 連線（前端架構：即時資料）。
 * - 每次（重新）連線都用目前記憶體裡的 access token
 * - 後端以 token 到期主動斷線（auth.expired）或連線時回 TOKEN_EXPIRED → refresh 後重連
 * - 訂閱的樓層由頁面決定（useWatchFloors）；改變時重送 subscribe
 */
export function connectRealtime(): void {
  if (socket) return;
  useRealtime.getState().setConn('connecting');

  socket = io({
    path: '/ws',
    transports: ['websocket'],
    auth: (cb) => cb({ token: getToken() }),
    reconnectionDelayMax: 5_000,
  });

  socket.on('connect', () => {
    useRealtime.getState().setConn('connected');
    void loadRecordings();
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

  socket.on('robot.state', (m: RobotLive) => useRealtime.getState().upsert(m));
  socket.on('robot.online', (m: { code: string; online: boolean; removed?: boolean }) =>
    useRealtime.getState().setOnline(m.code, m.online, m.removed),
  );
  socket.on('robot.cmdResult', (m: CmdResult) => useRealtime.getState().addCmdResult(m));
  socket.on('stats.tick', (m: Stats) => useRealtime.getState().setStats(m));
  socket.on('task.updated', (m: Task) => useTasks.getState().update(m));
  socket.on('charger.updated', (m: ChargingFloor) => useCharging.getState().update(m));
  // 告警：依告警設置響鈴、彈窗（一級預設彈窗＋響鈴）
  socket.on('alarm.new', onAlarmNew);
  socket.on('alarm.updated', (m: AlarmUpdated) => useAlarms.getState().update(m));
  // 抓拍、錄影（T-28）
  socket.on('media.new', () => useMedia.getState().bump());
  socket.on('media.recording', (m: { active: ActiveRecording[] }) => useMedia.getState().setRecordings(m.active));
  socket.on('teleop.revoked', (m: Omit<TeleopRevoked, 'at'>) => {
    useTeleopEvents.getState().setRevoked(m);
    useToast.getState().show(m.reason === 'estop' ? t('teleop.revoked.estop', { code: m.code }) : t('teleop.revoked.takeover', m), 'warn');
  });
  socket.on('teleop.error', (m: Omit<TeleopError, 'at'>) => useTeleopEvents.getState().setError(m));

  let last = useRealtime.getState().watch;
  unwatch = useRealtime.subscribe((s) => {
    if (s.watch !== last) {
      last = s.watch;
      void resubscribe();
    }
  });
}

/** alarm.new：加入告警日誌與彈窗佇列；告警設置開了「音效提醒」就響鈴 */
export function onAlarmNew(m: AlarmNew): void {
  useAlarms.getState().add(m);
  if (m.notify.sound) playAlarm(m.alarm.level);
}

/** 連線後先取一次目前錄影中的清單，之後靠 media.recording 更新 */
async function loadRecordings() {
  try {
    useMedia.getState().setRecordings(await api<ActiveRecording[]>('/media/recordings/active'));
  } catch {
    /* 沒有權限或後端沒開 */
  }
}

async function reauth() {
  const token = await refresh().catch(() => null);
  if (token && socket && !socket.connected) socket.connect();
}

async function resubscribe(): Promise<void> {
  if (!socket?.connected) return;
  await socket.emitWithAck('subscribe', { floors: useRealtime.getState().watch });
}

export function disconnectRealtime(): void {
  unwatch?.();
  unwatch = null;
  socket?.removeAllListeners();
  socket?.disconnect();
  socket = null;
  useRealtime.getState().clear();
  useAlarms.getState().clear();
}

/** 遙控速度（實時遙控頁 T-30 使用）：每 100 ms 一筆 */
export function sendTeleop(m: { robotId: string; lockId: string; vx: number; vy: number; wz: number }): void {
  socket?.volatile.emit('teleop.cmd', m);
}
