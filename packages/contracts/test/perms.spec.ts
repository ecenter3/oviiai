import { describe, expect, it } from 'vitest';
import { ALL_PERMS, isPermCode } from '../src';

describe('權限碼', () => {
  it('不重複，共 29 個頁面＋7 個操作（後端邏輯 §6；op.media 為 PR #12 審查新增）', () => {
    expect(new Set(ALL_PERMS).size).toBe(ALL_PERMS.length);
    expect(ALL_PERMS.filter((p) => p.startsWith('op.'))).toHaveLength(7);
    expect(ALL_PERMS.filter((p) => !p.startsWith('op.'))).toHaveLength(29);
  });
  it('isPermCode', () => {
    expect(isPermCode('op.estop')).toBe(true);
    expect(isPermCode('root')).toBe(false);
  });
});
