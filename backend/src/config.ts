import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** 開發時讀 repo 根目錄的 .env；正式環境由 Docker 注入環境變數。已存在的變數不覆蓋。 */
export function loadEnv(): void {
  for (const p of [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../.env')]) {
    if (existsSync(p)) {
      process.loadEnvFile(p);
      return;
    }
  }
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`環境變數 ${name} 未設定`);
  return v;
}

/** '15m'、'7d'、'30s'、'12h' → 秒 */
export function parseDurationSec(s: string): number {
  const m = /^(\d+)\s*([smhd])$/.exec(s.trim());
  if (!m) throw new Error(`無法解析時間長度：${s}`);
  return Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[m[2] as 's' | 'm' | 'h' | 'd'];
}

export interface AuthConfig {
  jwtSecret: string;
  accessTtlSec: number;
  refreshTtlSec: number;
  /** 正式環境走 HTTPS，cookie 要加 Secure；本機 http 開發時關掉 */
  cookieSecure: boolean;
}

/** .env.example 與文件裡出現過的預設值，正式環境不得沿用 */
const DEFAULT_JWT_SECRETS = new Set(['please-generate-a-long-random-string', 'change-me', 'secret', 'changeme']);

/** 回傳 JWT_SECRET 的問題清單；空陣列代表可用 */
export function jwtSecretProblems(secret: string): string[] {
  const problems: string[] = [];
  if (DEFAULT_JWT_SECRETS.has(secret.trim().toLowerCase())) problems.push('仍是預設值');
  if (secret.length < 32) problems.push(`長度 ${secret.length}，至少需 32 字元`);
  return problems;
}

let warnedWeakSecret = false;

/** NODE_ENV=production 時 JWT_SECRET 不安全就拒絕啟動；開發環境只警告一次 */
export function assertJwtSecret(secret: string, nodeEnv = process.env.NODE_ENV): void {
  const problems = jwtSecretProblems(secret);
  if (!problems.length) return;
  const msg = `JWT_SECRET 不安全：${problems.join('、')}。請用 openssl rand -base64 48 產生`;
  if (nodeEnv === 'production') throw new Error(msg);
  if (!warnedWeakSecret) {
    warnedWeakSecret = true;
    console.warn(`[警告] ${msg}（非正式環境，仍繼續啟動）`);
  }
}

export function authConfig(): AuthConfig {
  const jwtSecret = required('JWT_SECRET');
  assertJwtSecret(jwtSecret);
  return {
    jwtSecret,
    accessTtlSec: parseDurationSec(process.env.JWT_ACCESS_TTL ?? '15m'),
    refreshTtlSec: parseDurationSec(process.env.JWT_REFRESH_TTL ?? '7d'),
    cookieSecure: process.env.COOKIE_SECURE !== 'false',
  };
}

export function databaseUrl(): string {
  return required('DATABASE_URL');
}
