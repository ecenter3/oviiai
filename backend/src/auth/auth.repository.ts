import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { KYSELY, type Database } from '../db/database.module';

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  passwordHash: string;
  enabled: boolean;
  lockedUntil: Date | null;
  roleId: string;
  roleName: string;
  /** 系統角色（系統管理員）成員：可強制接管遙控 */
  isSystem: boolean;
  perms: string[];
  /** 管理員建立帳號或重設密碼後為 true：改密碼前只能用 /me、改密碼、登出 */
  mustChangePassword: boolean;
}

export interface LockoutPolicy {
  maxFailedLogins: number;
  lockMinutes: number;
}

const DEFAULT_LOCKOUT: LockoutPolicy = { maxFailedLogins: 5, lockMinutes: 15 };

@Injectable()
export class AuthRepository {
  constructor(@Inject(KYSELY) private readonly db: Database) {}

  private userQuery() {
    return this.db
      .selectFrom('users as u')
      .innerJoin('roles as r', 'r.id', 'u.role_id')
      .select([
        'u.id',
        'u.username',
        'u.display_name as displayName',
        'u.password_hash as passwordHash',
        'u.enabled',
        'u.locked_until as lockedUntil',
        'r.id as roleId',
        'r.name as roleName',
        'r.is_system as isSystem',
        'r.perms',
        'u.must_change_password as mustChangePassword',
      ]);
  }

  async findByUsername(username: string): Promise<AuthUser | undefined> {
    return this.userQuery().where('u.username', '=', username).executeTakeFirst();
  }

  async findById(id: string): Promise<AuthUser | undefined> {
    return this.userQuery().where('u.id', '=', id).executeTakeFirst();
  }

  async lockoutPolicy(): Promise<LockoutPolicy> {
    const rows = await this.db
      .selectFrom('settings')
      .select(['key', 'value'])
      .where('key', 'in', ['auth.maxFailedLogins', 'auth.lockMinutes'])
      .execute();
    const v = Object.fromEntries(rows.map((r) => [r.key, Number(r.value)]));
    return {
      maxFailedLogins: v['auth.maxFailedLogins'] || DEFAULT_LOCKOUT.maxFailedLogins,
      lockMinutes: v['auth.lockMinutes'] || DEFAULT_LOCKOUT.lockMinutes,
    };
  }

  /** 失敗次數 +1；達上限時鎖定並歸零（單一 UPDATE，併發登入也不會漏算） */
  async recordFailure(userId: string, p: LockoutPolicy): Promise<{ lockedUntil: Date | null }> {
    const reached = sql<boolean>`failed_logins + 1 >= ${p.maxFailedLogins}`;
    const row = await this.db
      .updateTable('users')
      .set({
        failed_logins: sql`CASE WHEN ${reached} THEN 0 ELSE failed_logins + 1 END`,
        locked_until: sql`CASE WHEN ${reached} THEN now() + make_interval(mins => ${p.lockMinutes}) ELSE locked_until END`,
      })
      .where('id', '=', userId)
      .returning('locked_until')
      .executeTakeFirstOrThrow();
    const lockedUntil = row.locked_until ? new Date(row.locked_until) : null;
    return { lockedUntil: lockedUntil && lockedUntil > new Date() ? lockedUntil : null };
  }

  async recordSuccess(userId: string): Promise<void> {
    await this.db
      .updateTable('users')
      .set({ failed_logins: 0, locked_until: null, last_login_at: sql`now()` })
      .where('id', '=', userId)
      .execute();
  }

  async insertRefreshToken(userId: string, tokenHash: string, expiresAt: Date): Promise<void> {
    await this.db
      .insertInto('refresh_tokens')
      .values({ user_id: userId, token_hash: tokenHash, expires_at: expiresAt })
      .execute();
  }

  /** 撤銷舊 token 並發新的；舊 token 無效（不存在、已撤銷、過期）回 undefined */
  async rotateRefreshToken(oldHash: string, newHash: string, expiresAt: Date): Promise<string | undefined> {
    return this.db.transaction().execute(async (tx) => {
      const row = await tx
        .updateTable('refresh_tokens')
        .set({ revoked_at: sql`now()` })
        .where('token_hash', '=', oldHash)
        .where('revoked_at', 'is', null)
        .where('expires_at', '>', sql<Date>`now()`)
        .returning('user_id')
        .executeTakeFirst();
      if (!row) return undefined;
      await tx
        .insertInto('refresh_tokens')
        .values({ user_id: row.user_id, token_hash: newHash, expires_at: expiresAt })
        .execute();
      return row.user_id;
    });
  }

  async revokeRefreshToken(tokenHash: string): Promise<void> {
    await this.db
      .updateTable('refresh_tokens')
      .set({ revoked_at: sql`now()` })
      .where('token_hash', '=', tokenHash)
      .where('revoked_at', 'is', null)
      .execute();
  }

  /** 撤銷該使用者其他所有 refresh token（改密碼後其他裝置需重新登入） */
  async revokeOtherRefreshTokens(userId: string, keepHash: string | null): Promise<void> {
    let q = this.db
      .updateTable('refresh_tokens')
      .set({ revoked_at: sql`now()` })
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null);
    if (keepHash) q = q.where('token_hash', '<>', keepHash);
    await q.execute();
  }

  async updatePassword(userId: string, passwordHash: string): Promise<void> {
    await this.db.updateTable('users').set({ password_hash: passwordHash, must_change_password: false }).where('id', '=', userId).execute();
  }
}
