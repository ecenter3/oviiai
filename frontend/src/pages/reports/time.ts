import { t } from '../../i18n';

/** 台北日期（YYYY-MM-DD） */
const ymd = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' });

export function taipeiDate(d: Date | number = Date.now()): string {
  return ymd.format(new Date(d));
}

/** 台北的日期＋時間（HH:mm）→ UTC ISO */
export function taipeiIso(date: string, time = '00:00'): string {
  return new Date(`${date}T${time}:00+08:00`).toISOString();
}

/** 日期加減天數（台北日期字串） */
export function addDays(date: string, n: number): string {
  return taipeiDate(new Date(`${date}T12:00:00+08:00`).getTime() + n * 86400_000);
}

/** 時間範圍：同一天 from～to；to 含該分鐘（23:59 → 隔天 00:00） */
export function dayRange(date: string, from = '00:00', to = '23:59'): { from: string; to: string } {
  const a = new Date(taipeiIso(date, from)).getTime();
  const b = Math.max(a + 60_000, new Date(taipeiIso(date, to)).getTime() + 60_000);
  return { from: new Date(a).toISOString(), to: new Date(b).toISOString() };
}

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h} 小時 ${m} 分` : m ? `${m} 分 ${sec} 秒` : `${sec} 秒`;
}

/** 動態組成的文字鍵（狀態、種類、原因）：沒有翻譯就用 fallback */
export function tr(key: string, fallback: string): string {
  const v = (t as (k: string) => string | undefined)(key);
  return v === undefined || v === key ? fallback : v;
}
