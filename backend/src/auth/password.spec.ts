import { describe, expect, it } from 'vitest';
import { PasswordPolicy } from './password';

describe('PasswordPolicy', () => {
  it.each(['Secret12', 'abc12345', 'A1b2C3d4e5'])('接受 %s', (p) => {
    expect(PasswordPolicy.safeParse(p).success).toBe(true);
  });
  it.each(['Sec12', 'abcdefgh', '12345678', ''])('拒絕 %s', (p) => {
    expect(PasswordPolicy.safeParse(p).success).toBe(false);
  });
});
