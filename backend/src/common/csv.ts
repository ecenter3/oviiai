/** CSV 欄位跳脫；開頭為 = + - @ 的值前面加 ' ，避免在 Excel 被當成公式執行 */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvRow(cells: unknown[]): string {
  return cells.map(csvCell).join(',') + '\r\n';
}

/** Excel 開 UTF-8 CSV 需要 BOM，否則中文亂碼 */
export const CSV_BOM = '﻿';

const taipei = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Taipei',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/** 匯出給人看的時間：台北時間並標示時區，例 2026-10-15 16:45:01+08:00 */
export function formatTaipei(d: Date): string {
  return `${taipei.format(d)}+08:00`;
}
