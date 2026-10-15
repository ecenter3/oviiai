import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/errors';
import { loginError } from './LoginPage';

describe('登入錯誤提示', () => {
  it('鎖定：顯示台北時間的解鎖時間', () => {
    const msg = loginError(new ApiError(423, 'ACCOUNT_LOCKED', '', { lockedUntil: '2026-10-15T08:15:00.000Z' }));
    expect(msg).toContain('16:15:00');
    expect(msg).toContain('鎖定');
  });
  it('帳密錯誤、網路錯誤', () => {
    expect(loginError(new ApiError(401, 'UNAUTHENTICATED', '帳號或密碼錯誤'))).toBe('帳號或密碼錯誤');
    expect(loginError(new TypeError('fetch failed'))).toBe('無法連線到伺服器');
  });
});
