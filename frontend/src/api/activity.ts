/**
 * 最後操作時間（閒置自動登出用）：存在 localStorage，所有分頁共用——任一分頁有人操作都算。
 * 讀寫失敗（隱私模式、封鎖網站資料）時只看本分頁。
 */
const KEY = 'oviiai.lastActive';

export function lastActive(): number | null {
  try {
    const v = Number(localStorage.getItem(KEY));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

export function markActive(at = Date.now()): void {
  try {
    localStorage.setItem(KEY, String(at));
  } catch {
    /* 只看本分頁 */
  }
}
