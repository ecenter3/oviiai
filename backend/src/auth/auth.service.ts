import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { AuthConfig } from '../config';
import { AppError } from '../common/errors';
import { OpLogService } from '../oplog/oplog.service';
import { AuthRepository, type AuthUser } from './auth.repository';
import { dummyVerify, hashPassword, verifyPassword } from './password';
import { hashRefreshToken, newRefreshToken } from './refresh-token';

export const AUTH_CONFIG = Symbol('AUTH_CONFIG');

/** access token 內容。權限不放進 token，由 Guard 每次查，角色改權限才能即時生效（T-05）。 */
export interface AccessPayload {
  sub: string;
  username: string;
  rid: string;
}

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  refreshExpiresAt: Date;
  user: { id: string; username: string; displayName: string; role: { id: string; name: string } };
  perms: string[];
  mustChangePassword: boolean;
}

const BAD_CREDENTIALS = '帳號或密碼錯誤';

@Injectable()
export class AuthService {
  constructor(
    private readonly repo: AuthRepository,
    private readonly jwt: JwtService,
    private readonly oplog: OpLogService,
    @Inject(AUTH_CONFIG) private readonly cfg: AuthConfig,
  ) {}

  async login(username: string, password: string, ip: string | null): Promise<LoginResult> {
    const user = await this.repo.findByUsername(username);
    if (!user) {
      await dummyVerify(password);
      await this.oplog.write({ userId: null, username, action: 'auth.login_failed', detail: { reason: 'no_user' }, ip });
      throw new AppError('UNAUTHENTICATED', BAD_CREDENTIALS);
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw locked(user.lockedUntil);
    }

    if (!(await verifyPassword(user.passwordHash, password))) {
      const { lockedUntil } = await this.repo.recordFailure(user.id, await this.repo.lockoutPolicy());
      await this.oplog.write({
        userId: user.id,
        username: user.username,
        action: lockedUntil ? 'auth.locked' : 'auth.login_failed',
        detail: lockedUntil ? { lockedUntil: lockedUntil.toISOString() } : { reason: 'bad_password' },
        ip,
      });
      if (lockedUntil) throw locked(lockedUntil);
      throw new AppError('UNAUTHENTICATED', BAD_CREDENTIALS);
    }

    if (!user.enabled) {
      throw new AppError('UNAUTHENTICATED', '帳號已停用');
    }

    await this.repo.recordSuccess(user.id);
    const [refreshToken, hash] = newRefreshToken();
    const refreshExpiresAt = new Date(Date.now() + this.cfg.refreshTtlSec * 1000);
    await this.repo.insertRefreshToken(user.id, hash, refreshExpiresAt);
    await this.oplog.write({ userId: user.id, username: user.username, action: 'auth.login', ip });

    return { accessToken: await this.signAccess(user), refreshToken, refreshExpiresAt, ...view(user) };
  }

  /** 以 refresh token 換新 access token，同時輪替 refresh token */
  async refresh(refreshToken: string | undefined) {
    if (!refreshToken) throw new AppError('UNAUTHENTICATED', '請重新登入');
    const [next, nextHash] = newRefreshToken();
    const refreshExpiresAt = new Date(Date.now() + this.cfg.refreshTtlSec * 1000);
    const userId = await this.repo.rotateRefreshToken(hashRefreshToken(refreshToken), nextHash, refreshExpiresAt);
    if (!userId) throw new AppError('UNAUTHENTICATED', '請重新登入');

    const user = await this.repo.findById(userId);
    if (!user || !user.enabled) {
      await this.repo.revokeRefreshToken(nextHash);
      throw new AppError('UNAUTHENTICATED', '請重新登入');
    }
    return { accessToken: await this.signAccess(user), refreshToken: next, refreshExpiresAt };
  }

  async logout(actor: AccessPayload, refreshToken: string | undefined, ip: string | null): Promise<void> {
    if (refreshToken) await this.repo.revokeRefreshToken(hashRefreshToken(refreshToken));
    await this.oplog.write({ userId: actor.sub, username: actor.username, action: 'auth.logout', ip });
  }

  async changePassword(
    actor: AccessPayload,
    oldPassword: string,
    newPassword: string,
    currentRefreshToken: string | undefined,
    ip: string | null,
  ): Promise<void> {
    const user = await this.repo.findById(actor.sub);
    if (!user || !user.enabled) throw new AppError('UNAUTHENTICATED', '請重新登入');
    if (!(await verifyPassword(user.passwordHash, oldPassword))) {
      throw new AppError('VALIDATION_FAILED', '舊密碼錯誤', { fields: { oldPassword: '舊密碼錯誤' } });
    }
    if (newPassword === oldPassword) {
      throw new AppError('VALIDATION_FAILED', '新密碼不能與目前密碼相同', { fields: { newPassword: '新密碼不能與目前密碼相同' } });
    }
    await this.repo.updatePassword(user.id, await hashPassword(newPassword));
    // 其他裝置的登入失效，目前這個保留
    await this.repo.revokeOtherRefreshTokens(user.id, currentRefreshToken ? hashRefreshToken(currentRefreshToken) : null);
    await this.oplog.write({ userId: user.id, username: user.username, action: 'auth.password_change', ip });
  }

  private signAccess(user: AuthUser): Promise<string> {
    const payload: AccessPayload = { sub: user.id, username: user.username, rid: user.roleId };
    return this.jwt.signAsync(payload, { expiresIn: this.cfg.accessTtlSec });
  }
}

function locked(until: Date) {
  return new AppError('ACCOUNT_LOCKED', '登入失敗次數過多，帳號暫時鎖定', { lockedUntil: until.toISOString() });
}

function view(u: AuthUser) {
  return {
    user: { id: u.id, username: u.username, displayName: u.displayName, role: { id: u.roleId, name: u.roleName } },
    perms: u.perms,
    mustChangePassword: u.mustChangePassword,
  };
}
