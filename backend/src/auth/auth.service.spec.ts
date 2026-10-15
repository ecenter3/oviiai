import { JwtService } from '@nestjs/jwt';
import { beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../common/errors';
import type { OpLogEntry, OpLogService } from '../oplog/oplog.service';
import type { AuthRepository, AuthUser, LockoutPolicy } from './auth.repository';
import { AuthService } from './auth.service';
import { hashPassword } from './password';

/** 與 AuthRepository 行為相同的記憶體版，只測商業邏輯 */
class FakeRepo {
  users = new Map<string, AuthUser & { failedLogins: number }>();
  tokens = new Map<string, { userId: string; expiresAt: Date; revoked: boolean }>();
  policy: LockoutPolicy = { maxFailedLogins: 5, lockMinutes: 15 };

  async findByUsername(n: string) {
    return [...this.users.values()].find((u) => u.username === n);
  }
  async findById(id: string) {
    return this.users.get(id);
  }
  async lockoutPolicy() {
    return this.policy;
  }
  async recordFailure(id: string, p: LockoutPolicy) {
    const u = this.users.get(id)!;
    if (u.failedLogins + 1 >= p.maxFailedLogins) {
      u.failedLogins = 0;
      u.lockedUntil = new Date(Date.now() + p.lockMinutes * 60_000);
      return { lockedUntil: u.lockedUntil };
    }
    u.failedLogins += 1;
    return { lockedUntil: null };
  }
  async recordSuccess(id: string) {
    const u = this.users.get(id)!;
    u.failedLogins = 0;
    u.lockedUntil = null;
  }
  async insertRefreshToken(userId: string, hash: string, expiresAt: Date) {
    this.tokens.set(hash, { userId, expiresAt, revoked: false });
  }
  async rotateRefreshToken(oldHash: string, newHash: string, expiresAt: Date) {
    const t = this.tokens.get(oldHash);
    if (!t || t.revoked || t.expiresAt <= new Date()) return undefined;
    t.revoked = true;
    this.tokens.set(newHash, { userId: t.userId, expiresAt, revoked: false });
    return t.userId;
  }
  async revokeRefreshToken(hash: string) {
    const t = this.tokens.get(hash);
    if (t) t.revoked = true;
  }
  async revokeOtherRefreshTokens(userId: string, keep: string | null) {
    for (const [h, t] of this.tokens) if (t.userId === userId && h !== keep) t.revoked = true;
  }
  async updatePassword(id: string, hash: string) {
    this.users.get(id)!.passwordHash = hash;
  }
}

const cfg = { jwtSecret: 'x'.repeat(32), accessTtlSec: 900, refreshTtlSec: 7 * 86400, cookieSecure: false };

async function errorOf(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof AppError) return e;
    throw e;
  }
  throw new Error('預期丟出 AppError');
}

describe('AuthService', () => {
  let repo: FakeRepo;
  let logs: OpLogEntry[];
  let svc: AuthService;
  const jwt = new JwtService({ secret: cfg.jwtSecret });

  beforeEach(async () => {
    repo = new FakeRepo();
    logs = [];
    const oplog = { write: async (e: OpLogEntry) => void logs.push(e) } as unknown as OpLogService;
    svc = new AuthService(repo as unknown as AuthRepository, jwt, oplog, cfg);
    repo.users.set('u1', {
      id: 'u1',
      username: 'guard1',
      displayName: '警衛一',
      passwordHash: await hashPassword('Secret123'),
      enabled: true,
      lockedUntil: null,
      roleId: 'r1',
      roleName: '警衛',
      perms: ['monitor', 'op.estop'],
      failedLogins: 0,
    });
  });

  it('登入成功回傳 access token、使用者、權限碼，並記操作日誌', async () => {
    const r = await svc.login('guard1', 'Secret123', '10.0.0.5');
    expect(r.user).toEqual({ id: 'u1', username: 'guard1', displayName: '警衛一', role: { id: 'r1', name: '警衛' } });
    expect(r.perms).toEqual(['monitor', 'op.estop']);
    const payload = jwt.verify(r.accessToken);
    expect(payload).toMatchObject({ sub: 'u1', username: 'guard1', rid: 'r1' });
    expect(payload.exp - payload.iat).toBe(900);
    expect(logs.at(-1)).toMatchObject({ action: 'auth.login', userId: 'u1', ip: '10.0.0.5' });
  });

  it('帳號不存在與密碼錯誤回同一個訊息', async () => {
    const a = await errorOf(svc.login('nobody', 'Secret123', null));
    const b = await errorOf(svc.login('guard1', 'wrong', null));
    expect([a.code, b.code]).toEqual(['UNAUTHENTICATED', 'UNAUTHENTICATED']);
    expect(a.message).toBe(b.message);
  });

  it('連續 5 次失敗鎖定 15 分鐘，鎖定期間正確密碼也不能登入', async () => {
    for (let i = 0; i < 4; i++) expect((await errorOf(svc.login('guard1', 'bad', null))).code).toBe('UNAUTHENTICATED');
    const fifth = await errorOf(svc.login('guard1', 'bad', null));
    expect(fifth.code).toBe('ACCOUNT_LOCKED');
    expect(fifth.getStatus()).toBe(423);
    const until = new Date(fifth.details.lockedUntil as string).getTime();
    expect(until - Date.now()).toBeGreaterThan(14.9 * 60_000);
    expect(until - Date.now()).toBeLessThanOrEqual(15 * 60_000);
    expect(logs.at(-1)?.action).toBe('auth.locked');

    expect((await errorOf(svc.login('guard1', 'Secret123', null))).code).toBe('ACCOUNT_LOCKED');
  });

  it('鎖定到期後可登入，成功後失敗次數歸零', async () => {
    repo.users.get('u1')!.lockedUntil = new Date(Date.now() - 1000);
    await svc.login('guard1', 'Secret123', null);
    expect(repo.users.get('u1')).toMatchObject({ failedLogins: 0, lockedUntil: null });
  });

  it('成功登入會清掉先前的失敗次數', async () => {
    for (let i = 0; i < 4; i++) await errorOf(svc.login('guard1', 'bad', null));
    await svc.login('guard1', 'Secret123', null);
    expect((await errorOf(svc.login('guard1', 'bad', null))).code).toBe('UNAUTHENTICATED');
  });

  it('停用帳號不能登入', async () => {
    repo.users.get('u1')!.enabled = false;
    expect((await errorOf(svc.login('guard1', 'Secret123', null))).code).toBe('UNAUTHENTICATED');
  });

  it('refresh 換新 access token 並輪替 refresh token，舊的不能再用', async () => {
    const { refreshToken } = await svc.login('guard1', 'Secret123', null);
    const r = await svc.refresh(refreshToken);
    expect(jwt.verify(r.accessToken).sub).toBe('u1');
    expect(r.refreshToken).not.toBe(refreshToken);
    expect((await errorOf(svc.refresh(refreshToken))).code).toBe('UNAUTHENTICATED');
    await svc.refresh(r.refreshToken);
  });

  it('帳號停用後 refresh 失敗', async () => {
    const { refreshToken } = await svc.login('guard1', 'Secret123', null);
    repo.users.get('u1')!.enabled = false;
    expect((await errorOf(svc.refresh(refreshToken))).code).toBe('UNAUTHENTICATED');
  });

  it('登出撤銷 refresh token', async () => {
    const { refreshToken } = await svc.login('guard1', 'Secret123', null);
    await svc.logout({ sub: 'u1', username: 'guard1', rid: 'r1' }, refreshToken, null);
    expect((await errorOf(svc.refresh(refreshToken))).code).toBe('UNAUTHENTICATED');
    expect(logs.at(-1)?.action).toBe('auth.logout');
  });

  it('改密碼：舊密碼錯誤回 400；成功後其他裝置的 refresh token 失效', async () => {
    const actor = { sub: 'u1', username: 'guard1', rid: 'r1' };
    const here = await svc.login('guard1', 'Secret123', null);
    const other = await svc.login('guard1', 'Secret123', null);

    expect((await errorOf(svc.changePassword(actor, 'nope', 'NewPass456', here.refreshToken, null))).code).toBe(
      'VALIDATION_FAILED',
    );

    await svc.changePassword(actor, 'Secret123', 'NewPass456', here.refreshToken, null);
    expect((await errorOf(svc.refresh(other.refreshToken))).code).toBe('UNAUTHENTICATED');
    await svc.refresh(here.refreshToken);
    await svc.login('guard1', 'NewPass456', null);
  });
});
