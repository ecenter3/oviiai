import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../api/client';
import { sendTeleop } from '../../realtime/socket';
import { useRealtime } from '../../stores/realtime';
import { useTeleopEvents } from '../../stores/teleop';

/** 每 100 ms 一筆（介面規格 teleop.cmd）；轉接器 500 ms 沒收到就停車 */
export const TELEOP_PERIOD_MS = 100;
/** 搖桿推到底的速度。轉接器再依參數「導航速度」限制，這裡只是上限 */
export const V_MAX = 1.0;
export const WZ_MAX = 1.0;
/** 沒在動時每 10 秒送一筆零速度，讓遙控鎖（TTL 30 秒）續期 */
export const KEEPALIVE_MS = 10_000;

export type LockState =
  | { s: 'none' }
  | { s: 'acquiring' }
  | { s: 'held'; lockId: string }
  | { s: 'locked'; holder: string; canForce: boolean }
  | { s: 'error'; message: string };

/** 搖桿向量（螢幕方向，-1..1：x 向右、y 向下）→ 機器人速度：上推前進、右推右轉（wz 為負） */
export function toVelocity(x: number, y: number): { vx: number; vy: number; wz: number } {
  const z = (n: number) => (Math.abs(n) < 0.05 ? 0 : n);
  return { vx: z(-y) * V_MAX, vy: 0, wz: z(-x) * WZ_MAX };
}

/**
 * 實時遙控（T-30）：取鎖、每 100 ms 送速度、放開即停、離開釋鎖。
 * - 放開搖桿（向量歸零）立刻送一筆零速度，之後停止送；轉接器 500 ms 沒收到也會停車（斷訊保護）。
 * - 被接管、急停、鎖失效（teleop.revoked／teleop.error）或 WebSocket 斷線：搖桿歸零、狀態改為未持有。
 * - 換機器人、離開頁面：釋鎖（關分頁用 keepalive 請求）。
 */
export function useTeleop(robotId: string | null) {
  const [lock, setLock] = useState<LockState>({ s: 'none' });
  const vec = useRef({ x: 0, y: 0 });
  const moving = useRef(false);
  const lastSent = useRef(0);
  const lockRef = useRef(lock);
  lockRef.current = lock;
  const conn = useRealtime((s) => s.conn);

  const lockId = lock.s === 'held' ? lock.lockId : null;

  const send = useCallback(
    (x: number, y: number) => {
      if (!robotId || !lockId) return;
      sendTeleop({ robotId, lockId, ...toVelocity(x, y) });
      lastSent.current = Date.now();
    },
    [robotId, lockId],
  );

  /** 搖桿或鍵盤更新向量；歸零時立刻送零速度（放開即停） */
  const setVector = useCallback(
    (x: number, y: number) => {
      vec.current = { x, y };
      const now = x !== 0 || y !== 0;
      if (!now && moving.current) send(0, 0);
      moving.current = now;
    },
    [send],
  );

  // 送速度迴圈
  useEffect(() => {
    if (!lockId) return;
    const timer = setInterval(() => {
      const { x, y } = vec.current;
      if (x !== 0 || y !== 0) send(x, y);
      else if (Date.now() - lastSent.current > KEEPALIVE_MS) send(0, 0);
    }, TELEOP_PERIOD_MS);
    return () => clearInterval(timer);
  }, [lockId, send]);

  const drop = useCallback((next: LockState) => {
    vec.current = { x: 0, y: 0 };
    moving.current = false;
    setLock(next);
  }, []);

  // 被接管、急停、鎖失效
  const revoked = useTeleopEvents((s) => s.revoked);
  const error = useTeleopEvents((s) => s.error);
  useEffect(() => {
    if (revoked && revoked.robotId === robotId && lockRef.current.s === 'held') drop({ s: 'none' });
  }, [revoked, robotId, drop]);
  useEffect(() => {
    if (error && lockRef.current.s === 'held' && ['not_holder', 'offline', 'estop', 'not_found', 'forbidden'].includes(error.reason)) drop({ s: 'none' });
  }, [error, drop]);
  // WebSocket 斷線：速度送不出去，轉接器 500 ms 後自己停車；畫面上搖桿也歸零
  useEffect(() => {
    if (conn !== 'connected') {
      vec.current = { x: 0, y: 0 };
      moving.current = false;
    }
  }, [conn]);

  const acquire = useCallback(
    async (force = false) => {
      if (!robotId) return;
      setLock({ s: 'acquiring' });
      try {
        const r = await api<{ lockId: string }>(`/robots/${robotId}/teleop/acquire`, { method: 'POST', json: force ? { force: true } : {} });
        lastSent.current = Date.now();
        setLock({ s: 'held', lockId: r.lockId });
      } catch (e) {
        if (e instanceof ApiError && e.code === 'TELEOP_LOCKED') {
          const d = e.details as { holder?: string; canForce?: boolean };
          setLock({ s: 'locked', holder: d.holder ?? '', canForce: !!d.canForce });
        } else setLock({ s: 'error', message: e instanceof Error ? e.message : String(e) });
      }
    },
    [robotId],
  );

  const release = useCallback(async () => {
    const held = lockRef.current.s === 'held';
    if (held) send(0, 0);
    drop({ s: 'none' });
    if (held && robotId) await api(`/robots/${robotId}/teleop/release`, { method: 'POST' }).catch(() => undefined);
  }, [robotId, send, drop]);

  // 換機器人或離開頁面：釋鎖；關分頁：keepalive 請求（頁面卸載後仍會送出）
  useEffect(() => {
    if (!robotId) return;
    const onHide = () => {
      if (lockRef.current.s === 'held') void api(`/robots/${robotId}/teleop/release`, { method: 'POST', keepalive: true }).catch(() => undefined);
    };
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      if (lockRef.current.s === 'held') {
        sendTeleop({ robotId, lockId: (lockRef.current as { lockId: string }).lockId, vx: 0, vy: 0, wz: 0 });
        void api(`/robots/${robotId}/teleop/release`, { method: 'POST' }).catch(() => undefined);
      }
      vec.current = { x: 0, y: 0 };
      moving.current = false;
      setLock({ s: 'none' });
    };
  }, [robotId]);

  return { lock, acquire, release, setVector, connected: conn === 'connected' };
}
