import { createHmac } from 'node:crypto';
import { topics } from '@oviiai/contracts';

/**
 * EMQX 帳號與權限（安全收尾 e）：EMQX 以 JWT 認證（HMAC，金鑰 EMQX_JWT_SECRET 與後端共用），
 * 權限放在 JWT 的 acl claim，沒列到的主題一律拒絕（authorization.no_match = deny）。
 * - 後端：帳號 backend，可發布、訂閱 rms/#
 * - 轉接器：帳號＝轉接器名稱，只能發布自己機器人的 telemetry／event／ack／online 與自己的心跳，
 *   只能訂閱自己機器人的 cmd／teleop。憑證由 GET /adapter-config/{name} 核發（轉接器金鑰驗證）。
 * EMQX 設定 verify_claims.username = ${username}：JWT 只能用在它簽給的那個帳號。
 * disconnect_after_expire = false：效期只在連線當下檢查，連線中不會因過期被斷。
 */
export const MQTT_TOKEN_TTL_SEC = 24 * 3600;

export interface AclRule {
  permission: 'allow';
  action: 'publish' | 'subscribe' | 'all';
  topic: string;
}

/** 沒設定就是 EMQX 沒開認證（沒有 .env 的測試環境）；正式環境必填（deploy.md），沒設定不啟動 */
export function mqttJwtSecret(nodeEnv = process.env.NODE_ENV): string | null {
  const s = process.env.EMQX_JWT_SECRET ?? '';
  if (s.length >= 32) return s;
  if (nodeEnv === 'production') throw new Error('EMQX_JWT_SECRET 未設定或少於 32 字元，請用 openssl rand -hex 32 產生（EMQX 與後端共用）');
  return null;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export function signMqttToken(username: string, acl: AclRule[], secret: string, ttlSec = MQTT_TOKEN_TTL_SEC, now = Date.now()): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ username, iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + ttlSec, acl }));
  const sig = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

export function backendAcl(): AclRule[] {
  return [{ permission: 'allow', action: 'all', topic: 'rms/#' }];
}

const SAFE_CODE = /^[A-Za-z0-9_-]+$/;

export function adapterAcl(name: string, codes: readonly string[]): AclRule[] {
  const rule = (action: AclRule['action'], topic: string): AclRule => ({ permission: 'allow', action, topic });
  return [
    rule('publish', topics.adapterStatus(name)),
    // 代碼含 MQTT 萬用字元或斜線（不該發生，代碼有格式檢查）就不給，免得變成萬用權限
    ...codes.filter((c) => SAFE_CODE.test(c)).flatMap((c) => [
      rule('publish', topics.telemetry(c)),
      rule('publish', topics.event(c)),
      rule('publish', topics.ack(c)),
      rule('publish', topics.online(c)),
      rule('subscribe', topics.cmd(c)),
      rule('subscribe', topics.teleop(c)),
    ]),
  ];
}
