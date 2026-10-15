import { describe, expect, it } from 'vitest';
import { PasswordPolicy } from '../auth/password';
import { tempPassword } from './temp-password';

describe('tempPassword', () => {
  it('一定符合密碼規則、且每次不同', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const p = tempPassword();
      expect(PasswordPolicy.safeParse(p).success).toBe(true);
      seen.add(p);
    }
    expect(seen.size).toBe(200);
  });
});
