import * as argon2 from 'argon2';
import { z } from 'zod';

/** 系統規格書 §3：至少 8 碼，含英文與數字 */
export const PasswordPolicy = z
  .string()
  .min(8, '密碼至少 8 碼')
  .max(128, '密碼最多 128 碼')
  .regex(/[A-Za-z]/, '密碼須含英文字母')
  .regex(/[0-9]/, '密碼須含數字');

export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

// 帳號不存在時也跑一次驗證，讓回應時間與密碼錯誤相近，避免以時間差探測帳號
let dummyHash: Promise<string> | undefined;
export function dummyVerify(plain: string): Promise<boolean> {
  dummyHash ??= hashPassword('dummy-password-0');
  return dummyHash.then((h) => verifyPassword(h, plain));
}
