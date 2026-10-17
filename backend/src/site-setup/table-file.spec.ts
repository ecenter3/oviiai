import { describe, expect, it } from 'vitest';
import { AppError } from '../common/errors';
import { type Column, parseTable, readCsv } from './table-file';

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
