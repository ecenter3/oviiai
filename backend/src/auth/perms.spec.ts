import { describe, expect, it } from 'vitest';
import * as shared from '../../../packages/contracts/src/perms';
import { satisfies } from './perm.decorator';
import { ALL_PERMS, PERM_TREE } from './perms';

describe('權限碼', () => {
  it('後端副本與 packages/contracts 一致', () => {
    expect(PERM_TREE).toEqual(shared.PERM_TREE);
    expect(ALL_PERMS).toEqual(shared.ALL_PERMS);
  });

  it('權限碼不重複，共 29 個頁面＋6 個操作（後端邏輯 §6）', () => {
    expect(new Set(ALL_PERMS).size).toBe(ALL_PERMS.length);
    expect(ALL_PERMS.filter((p) => p.startsWith('op.'))).toHaveLength(6);
    expect(ALL_PERMS.filter((p) => !p.startsWith('op.'))).toHaveLength(29);
  });
});

describe('satisfies', () => {
  it('all：全部都要有', () => {
    expect(satisfies(['settings', 'op.config'], { mode: 'all', codes: ['settings', 'op.config'] })).toBe(true);
    expect(satisfies(['settings'], { mode: 'all', codes: ['settings', 'op.config'] })).toBe(false);
  });
  it('any：有一個就好', () => {
    expect(satisfies(['bizalarm'], { mode: 'any', codes: ['sysalarm', 'bizalarm'] })).toBe(true);
    expect(satisfies(['monitor'], { mode: 'any', codes: ['sysalarm', 'bizalarm'] })).toBe(false);
  });
});
