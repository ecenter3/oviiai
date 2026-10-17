import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * 播放憑證（影像與整合 §1）：前端向 /streams/:key/token 取得，60 秒內有效，只能播指定的那一路。
 * 格式 base64url(payload).base64url(hmac)；MediaMTX 回呼 /internal/media/auth 時驗證。
 */
export const TOKEN_TTL_SEC = Number(process.env.STREAM_TOKEN_TTL_SEC || 60);

interface Payload {
  /** MediaMTX 路徑 */
  p: string;
  /** 使用者 id */
  u: string;
  /** 到期（秒） */
  e: number;
}

const key = () => `stream-token:${process.env.JWT_SECRET ?? ''}`;
const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const sign = (body: string) => createHmac('sha256', key()).update(body).digest();

export function issueStreamToken(path: string, userId: string, now = Date.now()): { token: string; expiresAt: number } {
  const e = Math.floor(now / 1000) + TOKEN_TTL_SEC;
  const body = b64(JSON.stringify({ p: path, u: userId, e } satisfies Payload));
  return { token: `${body}.${b64(sign(body))}`, expiresAt: e * 1000 };
}

/** 驗證；正確且未過期、路徑相符才回 payload */
export function verifyStreamToken(token: string | undefined, path: string, now = Date.now()): Payload | null {
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const want = sign(body);
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Payload;
    if (p.p !== path || p.e * 1000 < now) return null;
    return p;
  } catch {
    return null;
  }
}
