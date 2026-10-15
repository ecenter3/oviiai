import { zhTW, type MessageKey } from './zh-TW';

export type { MessageKey };

/** 取得介面文字；{name} 以 vars 取代。目前只有 zh-TW，結構保留日後加語系 */
export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  const s: string = zhTW[key];
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;
}

const taipei = new Intl.DateTimeFormat('zh-TW', {
  timeZone: 'Asia/Taipei',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/** 時間一律以 Asia/Taipei 顯示（後端以 UTC 傳） */
export function formatTime(v: string | number | Date): string {
  return taipei.format(new Date(v));
}
