import ExcelJS from 'exceljs';
import { AppError } from '../common/errors';

/** 上傳檔的一列：rowNo 是試算表上看到的列號（標題是第 1 列），回報錯誤用 */
export interface TableRow {
  rowNo: number;
  values: Record<string, string>;
}

export interface Column {
  key: string;
  label: string;
  /** 標題列可接受的寫法（不分大小寫、忽略空白） */
  aliases?: string[];
  required?: boolean;
  /** 範本「說明」頁的說明 */
  hint: string;
  example: string;
}

export const MAX_ROWS = 1000;
const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase();

/** 依副檔名或內容判斷：xlsx 是 zip（PK 開頭） */
export function isXlsx(buf: Buffer, filename = ''): boolean {
  return /\.xlsx$/i.test(filename) || (buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b);
}

/**
 * 讀 Excel（第一個工作表）或 CSV（UTF-8，可有 BOM；Excel 另存的 CSV）。
 * 第一個非空白列是標題，依 columns 的 label、key、aliases 對應；認不得的欄位忽略，必填欄位缺標題直接拒絕。
 */
export async function parseTable(buf: Buffer, filename: string, columns: Column[]): Promise<TableRow[]> {
  const grid = isXlsx(buf, filename) ? await readXlsx(buf) : readCsv(buf);
  const headerIdx = grid.findIndex((r) => r.cells.some((c) => c.trim() !== ''));
  if (headerIdx < 0) throw new AppError('VALIDATION_FAILED', '檔案是空的');
  const header = grid[headerIdx].cells.map((h) => {
    const n = norm(h);
    return columns.find((c) => [c.label, c.key, ...(c.aliases ?? [])].some((a) => norm(a) === n))?.key ?? null;
  });
  const missing = columns.filter((c) => c.required && !header.includes(c.key)).map((c) => c.label);
  if (missing.length) throw new AppError('VALIDATION_FAILED', `標題列缺少欄位：${missing.join('、')}（請用範本檔）`, { missing });
  const rows: TableRow[] = [];
  for (const r of grid.slice(headerIdx + 1)) {
    if (!r.cells.some((c) => c.trim() !== '')) continue;
    const values: Record<string, string> = {};
    header.forEach((k, i) => {
      if (k) values[k] = (r.cells[i] ?? '').trim();
    });
    rows.push({ rowNo: r.rowNo, values });
  }
  if (rows.length > MAX_ROWS) throw new AppError('VALIDATION_FAILED', `一次最多 ${MAX_ROWS} 列，這個檔案有 ${rows.length} 列`);
  return rows;
}

async function readXlsx(buf: Buffer): Promise<{ rowNo: number; cells: string[] }[]> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
  } catch {
    throw new AppError('VALIDATION_FAILED', '無法讀取 Excel 檔（請存成 .xlsx）');
  }
  const ws = wb.worksheets[0];
  if (!ws) throw new AppError('VALIDATION_FAILED', 'Excel 檔沒有工作表');
  const out: { rowNo: number; cells: string[] }[] = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNo) => {
    const cells: string[] = [];
    for (let i = 1; i <= row.cellCount; i++) cells.push(cellText(row.getCell(i).value));
    out.push({ rowNo, cells });
  });
  return out;
}

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    if ('richText' in v) return v.richText.map((t) => t.text).join('');
    if ('text' in v) return String(v.text);
    if ('result' in v) return v.result === undefined || v.result === null ? '' : String(v.result);
  }
  return String(v);
}

/** RFC 4180：逗號分隔、雙引號跳脫、CRLF／LF；也接受 Tab 分隔（從試算表直接複製貼上存檔） */
export function readCsv(buf: Buffer): { rowNo: number; cells: string[] }[] {
  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.includes('�')) throw new AppError('VALIDATION_FAILED', 'CSV 不是 UTF-8 編碼（Excel 請選「CSV UTF-8」另存，或直接上傳 .xlsx）');
  const firstLine = text.split(/\r?\n/, 1)[0];
  const sep = !firstLine.includes(',') && firstLine.includes('\t') ? '\t' : ',';
  const out: { rowNo: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let cur = '';
  let quoted = false;
  let rowNo = 1;
  let startRow = 1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else {
        if (ch === '\n') rowNo++;
        cur += ch;
      }
      continue;
    }
    if (ch === '"' && cur === '') quoted = true;
    else if (ch === sep) {
      cells.push(cur);
      cur = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      cells.push(cur);
      out.push({ rowNo: startRow, cells });
      cells = [];
      cur = '';
      rowNo++;
      startRow = rowNo;
    } else cur += ch;
  }
  if (cur !== '' || cells.length) {
    cells.push(cur);
    out.push({ rowNo: startRow, cells });
  }
  return out;
}

const csvCell = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** 範本：Excel 有「資料」與「說明」兩個工作表；CSV 只有標題列（UTF-8 BOM，Excel 開啟不會亂碼） */
export async function writeTemplate(columns: Column[], format: 'xlsx' | 'csv', sheetName: string): Promise<Buffer> {
  if (format === 'csv') return Buffer.from('﻿' + columns.map((c) => csvCell(c.label)).join(',') + '\r\n', 'utf8');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'OViiAI';
  const ws = wb.addWorksheet(sheetName);
  ws.columns = columns.map((c) => ({ header: c.label, key: c.key, width: Math.max(12, c.label.length * 2 + 4, c.example.length + 2) }));
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  const help = wb.addWorksheet('說明');
  help.columns = [
    { header: '欄位', key: 'label', width: 16 },
    { header: '必填', key: 'required', width: 8 },
    { header: '說明', key: 'hint', width: 70 },
    { header: '範例', key: 'example', width: 36 },
  ];
  help.getRow(1).font = { bold: true };
  for (const c of columns) help.addRow({ label: c.label, required: c.required ? '是' : '', hint: c.hint, example: c.example });
  help.addRow({});
  help.addRow({ label: '注意', hint: '資料從「' + sheetName + '」工作表第 2 列開始填，一列一筆；代碼已存在的會更新那一筆。' });
  return Buffer.from(await wb.xlsx.writeBuffer());
}
