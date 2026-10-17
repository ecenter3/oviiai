import { describe, expect, it } from 'vitest';
import { AppError } from '../common/errors';
import ExcelJS from 'exceljs';
import { zipSync } from 'fflate';
import { boundedXlsx, type Column, parseTable, readCsv } from './table-file';

const cols: Column[] = [
  { key: 'code', label: '代碼', required: true, hint: '', example: '' },
  { key: 'name', label: '名稱', aliases: ['name'], hint: '', example: '' },
];

describe('readCsv', () => {
  it('雙引號內的逗號、換行與跳脫的引號；CRLF；列號是試算表上的列號', () => {
    const rows = readCsv(Buffer.from('a,b\r\n"x, y","第一行\n第二行"\r\n"say ""hi""",z\n'));
    expect(rows).toEqual([
      { rowNo: 1, cells: ['a', 'b'] },
      { rowNo: 2, cells: ['x, y', '第一行\n第二行'] },
      { rowNo: 4, cells: ['say "hi"', 'z'] },
    ]);
  });

  it('Tab 分隔（從試算表複製貼上）；BOM', () => {
    expect(readCsv(Buffer.from('﻿代碼\t名稱\nA\tB'))).toEqual([
      { rowNo: 1, cells: ['代碼', '名稱'] },
      { rowNo: 2, cells: ['A', 'B'] },
    ]);
  });
});

describe('parseTable', () => {
  it('標題對應（label、key、別名，忽略大小寫與空白）、略過空白列與不認得的欄位', async () => {
    const rows = await parseTable(Buffer.from('備註, 代碼 ,NAME\n\n x ,A,B\n,,\n'), 'a.csv', cols);
    expect(rows).toEqual([{ rowNo: 3, values: { code: 'A', name: 'B' } }]);
  });

  it('缺必填標題、超過列數上限', async () => {
    await expect(parseTable(Buffer.from('名稱\nA'), 'a.csv', cols)).rejects.toThrow(AppError);
    const many = '代碼\n' + Array.from({ length: 1001 }, (_, i) => `C${i}`).join('\n');
    await expect(parseTable(Buffer.from(many), 'a.csv', cols)).rejects.toMatchObject({ response: { error: { message: '一次最多 1000 列，這個檔案有 1001 列' } } });
  });
});

describe('Excel 解壓縮上限（PR #14 審查第 3 點）', () => {
  it('宣告的解壓縮總大小超過上限就拒絕，不交給 exceljs', async () => {
    const bomb = Buffer.from(zipSync({ 'xl/worksheets/sheet1.xml': new Uint8Array(60 * 1024 * 1024) }, { level: 9 }));
    expect(bomb.length).toBeLessThan(200_000);
    await expect(parseTable(bomb, 'bomb.xlsx', cols)).rejects.toMatchObject({ response: { error: { message: 'Excel 檔解壓縮後超過 50 MB，請分批匯入' } } });
  });

  it('謊報大小：只解到宣告的長度（截斷），讀不出來就回格式錯誤', async () => {
    const z = Buffer.from(zipSync({ 'a.xml': new Uint8Array(5_000_000) }, { level: 9 }));
    let i = z.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    z.writeUInt32LE(100, i + 22);
    i = z.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    z.writeUInt32LE(100, i + 24);
    expect(boundedXlsx(z).length).toBeLessThan(1000);
    await expect(parseTable(z, 'x.xlsx', cols)).rejects.toThrow(AppError);
  });

  it('正常的 Excel 照常讀取', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('a');
    ws.addRow(['代碼', '名稱']);
    ws.addRow(['A-1', '甲']);
    const rows = await parseTable(Buffer.from(await wb.xlsx.writeBuffer()), 'a.xlsx', cols);
    expect(rows).toEqual([{ rowNo: 2, values: { code: 'A-1', name: '甲' } }]);
  });
});

