import { createHash, randomBytes } from 'node:crypto';

export const REFRESH_COOKIE = 'rms_rt';
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

/** 回傳 [給 cookie 的明文, 存 DB 的雜湊]。DB 外洩也無法拿雜湊換 token。 */
export function newRefreshToken(): [string, string] {
  const token = randomBytes(32).toString('base64url');
  return [token, hashRefreshToken(token)];
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
