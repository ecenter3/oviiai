import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * 播放憑證（影像與整合 §1）：前端向 /streams/:key/token 取得，60 秒內有效，只能播指定的那一路。
 * 格式 base64url(payload).base64url(hmac)；MediaMTX 回呼 /internal/media/auth 時驗證。
 */
export const TOKEN_TTL_SEC = Number(process.env.STREAM_TOKEN_TTL_SEC || 60);

/** read：播放、轉接器拉對講音訊；publish：瀏覽器推對講音訊（T-31）。舊憑證沒有 a，視為 read */
export type TokenAction = 'read' | 'publish';

interface Payload {
  /** MediaMTX 路徑 */
  p: string;
  a?: TokenAction;
  /** 使用者 id */
  u: string;
  /** 到期（秒） */
  e: number;
}

const key = () => `stream-token:${process.env.JWT_SECRET ?? ''}`;
const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const sign = (body: string) => createHmac('sha256', key()).update(body).digest();

export function issueStreamToken(
  path: string,
  userId: string,
  now = Date.now(),
  opts: { action?: TokenAction; ttlSec?: number } = {},
): { token: string; expiresAt: number } {
  const e = Math.floor(now / 1000) + (opts.ttlSec ?? TOKEN_TTL_SEC);
  const action = opts.action ?? 'read';
  const body = b64(JSON.stringify({ p: path, u: userId, e, ...(action !== 'read' && { a: action }) } satisfies Payload));
  return { token: `${body}.${b64(sign(body))}`, expiresAt: e * 1000 };
}

/** 驗證；正確且未過期、路徑與動作都相符才回 payload */
export function verifyStreamToken(token: string | undefined, path: string, now = Date.now(), action: TokenAction = 'read'): Payload | null {
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const want = sign(body);
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Payload;
    if (p.p !== path || p.e * 1000 < now || (p.a ?? 'read') !== action) return null;
    return p;
  } catch {
    return null;
  }
}

/**
 * 短憑證：`到期秒.簽章`（約 33 字），給轉接器以 RTSP 帳密（rtsp://talk:<憑證>@…）拉對講音訊用。
 * ffmpeg 的 RTSP 用 128 bytes 存網址裡的「帳號:密碼」，一般憑證（約 150 字）會被截斷而驗證失敗（T-31 實測）。
 * 簽章涵蓋動作、路徑、到期時間，取 HMAC-SHA256 前 128 bits。
 */
const shortSig = (action: TokenAction, path: string, e: number) => b64(sign(`short|${action}|${path}|${e}`).subarray(0, 16));

export function issueShortToken(path: string, action: TokenAction, ttlSec: number, now = Date.now()): string {
  const e = Math.floor(now / 1000) + ttlSec;
  return `${e}.${shortSig(action, path, e)}`;
}

export function verifyShortToken(token: string | undefined, path: string, action: TokenAction, now = Date.now()): boolean {
  const m = /^(\d{9,12})\.([A-Za-z0-9_-]{22})$/.exec(token ?? '');
  if (!m) return false;
  const e = Number(m[1]);
  if (e * 1000 < now) return false;
  const want = Buffer.from(shortSig(action, path, e));
  const got = Buffer.from(m[2]);
  return got.length === want.length && timingSafeEqual(got, want);
}

