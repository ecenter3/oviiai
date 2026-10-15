import { describe, expect, it } from 'vitest';
import { csvCell, csvRow, formatTaipei } from './csv';

describe('csv', () => {
  it('含逗號、引號、換行時加引號並跳脫', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('a\nb')).toBe('"a\nb"');
  });
  it('擋 Excel 公式注入', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-1')).toBe("'-1");
    expect(csvCell('@SUM')).toBe("'@SUM");
  });
  it('物件轉 JSON、null 為空字串', () => {
    expect(csvRow([null, { ok: true }, 3])).toBe(',"{""ok"":true}",3\r\n');
  });
  it('時間轉台北時間並標時區', () => {
    expect(formatTaipei(new Date('2026-10-15T08:45:01Z'))).toBe('2026-10-15 16:45:01+08:00');
    expect(formatTaipei(new Date('2026-12-31T16:00:00Z'))).toBe('2027-01-01 00:00:00+08:00');
  });
});
