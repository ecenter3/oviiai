import { useEffect } from 'react';
import { lastActive, markActive } from '../api/activity';
import { useAuth } from '../stores/auth';

const EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const;
/** 多久檢查一次、多久寫一次共用的最後操作時間 */
export const IDLE_CHECK_MS = 10_000;
const WRITE_EVERY_MS = 5_000;

/**
 * 閒置自動登出（安全收尾 d）：滑鼠、鍵盤、觸控都沒有動作超過規則頁設定的分鐘數就登出（0＝不登出）。
 * 即時資料更新不算操作。關掉瀏覽器再開、閒置已超過時間的，重新整理後也直接登出。
 */
export function useIdleLogout() {
  const minutes = useAuth((s) => s.idleMinutes);
  useEffect(() => {
    if (!minutes) return;
    const limit = minutes * 60_000;
    const stored = lastActive();
    if (stored && Date.now() - stored >= limit) {
      void useAuth.getState().idleLogout();
      return;
    }
    let last = Date.now();
    let written = last;
    markActive(last);
    const onActivity = () => {
      last = Date.now();
      if (last - written >= WRITE_EVERY_MS) {
        written = last;
        markActive(last);
      }
    };
    for (const e of EVENTS) window.addEventListener(e, onActivity, { capture: true, passive: true });
    const timer = setInterval(() => {
      if (Date.now() - Math.max(last, lastActive() ?? 0) >= limit) {
        clearInterval(timer);
        void useAuth.getState().idleLogout();
      }
    }, IDLE_CHECK_MS);
    return () => {
      clearInterval(timer);
      for (const e of EVENTS) window.removeEventListener(e, onActivity, { capture: true });
    };
  }, [minutes]);
}
