import { describe, expect, it } from 'vitest';
import { satisfies } from './perm.decorator';

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
