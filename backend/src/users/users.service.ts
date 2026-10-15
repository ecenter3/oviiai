import { Inject, Injectable } from '@nestjs/common';
import type { Transaction } from 'kysely';
import { AuthRepository } from '../auth/auth.repository';
import { hashPassword } from '../auth/password';
import type { Principal } from '../auth/principal';
import { AppError } from '../common/errors';
import type { Paged } from '../common/pagination';
import { PG_FK_VIOLATION, PG_UNIQUE_VIOLATION, pgCode } from '../common/pg-errors';
import { KYSELY, type Database } from '../db/database.module';
import type { DB } from '../db/types';
import { tempPassword } from './temp-password';

export interface UserView {
  id: string;
  username: string;
  displayName: string;
  role: { id: string; name: string };
  phone: string | null;
  email: string | null;
  enabled: boolean;
  lockedUntil: string | null;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface UserFilter {
  q?: string;
  roleId?: string;
  enabled?: boolean;
}

export interface CreateUser {
  username: string;
  displayName: string;
  password: string;
  roleId: string;
  phone?: string | null;
  email?: string | null;
}

export type UpdateUser = Partial<Omit<CreateUser, 'username' | 'password'>> & { enabled?: boolean };

const LAST_ADMIN = '至少需保留一位啟用中的系統管理員';

@Injectable()
export class UsersService {
  constructor(
    @Inject(KYSELY) private readonly db: Database,
    private readonly auth: AuthRepository,
  ) {}

  async list(f: UserFilter, page: number, size: number): Promise<Paged<UserView>> {
    let base = this.db.selectFrom('users as u').innerJoin('roles as r', 'r.id', 'u.role_id');
    if (f.q) {
      const like = `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      base = base.where((eb) => eb.or([eb('u.username', 'ilike', like), eb('u.display_name', 'ilike', like)]));
    }
    if (f.roleId) base = base.where('u.role_id', '=', f.roleId);
    if (f.enabled !== undefined) base = base.where('u.enabled', '=', f.enabled);

    const [{ total }, rows] = await Promise.all([
      base.select((eb) => eb.fn.countAll<string>().as('total')).executeTakeFirstOrThrow(),
      base.select(USER_COLUMNS).orderBy('u.username').limit(size).offset((page - 1) * size).execute(),
    ]);
    return { items: rows.map(view), total: Number(total), page, size };
  }

  async get(id: string): Promise<UserView> {
    const row = await this.db
      .selectFrom('users as u')
      .innerJoin('roles as r', 'r.id', 'u.role_id')
      .select(USER_COLUMNS)
      .where('u.id', '=', id)
      .executeTakeFirst();
    if (!row) throw new AppError('NOT_FOUND', '找不到帳號');
    return view(row);
  }

  async create(dto: CreateUser): Promise<UserView> {
    await this.assertRoleExists(dto.roleId);
    try {
      const { id } = await this.db
        .insertInto('users')
        .values({
          username: dto.username,
          display_name: dto.displayName,
          password_hash: await hashPassword(dto.password),
          role_id: dto.roleId,
          phone: dto.phone ?? null,
          email: dto.email ?? null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return this.get(id);
    } catch (e) {
      if (pgCode(e) === PG_UNIQUE_VIOLATION) {
        throw new AppError('VALIDATION_FAILED', '帳號已存在', { fields: { username: '帳號已存在' } });
      }
      throw e;
    }
  }

  async update(id: string, dto: UpdateUser, actor: Principal): Promise<UserView> {
    if (id === actor.sub && (dto.enabled === false || (dto.roleId && dto.roleId !== actor.rid))) {
      throw new AppError('INVALID_STATE', '不能停用自己或變更自己的角色');
    }
    if (dto.roleId) await this.assertRoleExists(dto.roleId);

    await this.db.transaction().execute(async (tx) => {
      const losesAdmin = dto.enabled === false || dto.roleId !== undefined;
      if (losesAdmin) await this.assertKeepsAnAdmin(tx, id, dto.roleId);
      const r = await tx
        .updateTable('users')
        .set({
          ...(dto.displayName !== undefined && { display_name: dto.displayName }),
          ...(dto.roleId !== undefined && { role_id: dto.roleId }),
          ...(dto.phone !== undefined && { phone: dto.phone }),
          ...(dto.email !== undefined && { email: dto.email }),
          ...(dto.enabled !== undefined && { enabled: dto.enabled }),
        })
        .where('id', '=', id)
        .executeTakeFirst();
      if (!r.numUpdatedRows) throw new AppError('NOT_FOUND', '找不到帳號');
    });
    // 停用後所有裝置的 refresh token 失效；access token 由 Guard 在下一個請求擋下
    if (dto.enabled === false) await this.auth.revokeOtherRefreshTokens(id, null);
    return this.get(id);
  }

  async remove(id: string, actor: Principal): Promise<void> {
    if (id === actor.sub) throw new AppError('INVALID_STATE', '不能刪除自己');
    try {
      await this.db.transaction().execute(async (tx) => {
        await this.assertKeepsAnAdmin(tx, id, undefined);
        const r = await tx.deleteFrom('users').where('id', '=', id).executeTakeFirst();
        if (!r.numDeletedRows) throw new AppError('NOT_FOUND', '找不到帳號');
      });
    } catch (e) {
      if (pgCode(e) === PG_FK_VIOLATION) {
        throw new AppError('INVALID_STATE', '帳號已有任務、告警等關聯紀錄，請改用停用');
      }
      throw e;
    }
  }

  /** 系統產生臨時密碼，同時解除鎖定、讓所有裝置登出 */
  async resetPassword(id: string): Promise<{ tempPassword: string }> {
    const pw = tempPassword();
    const r = await this.db
      .updateTable('users')
      .set({ password_hash: await hashPassword(pw), failed_logins: 0, locked_until: null })
      .where('id', '=', id)
      .executeTakeFirst();
    if (!r.numUpdatedRows) throw new AppError('NOT_FOUND', '找不到帳號');
    await this.auth.revokeOtherRefreshTokens(id, null);
    return { tempPassword: pw };
  }

  private async assertRoleExists(roleId: string) {
    const role = await this.db.selectFrom('roles').select('id').where('id', '=', roleId).executeTakeFirst();
    if (!role) throw new AppError('VALIDATION_FAILED', '角色不存在', { fields: { roleId: '角色不存在' } });
  }

  /**
   * 目標帳號若是啟用中的系統管理員，且變更後不再是（停用、刪除、改成非系統角色），
   * 必須還有其他啟用中的系統管理員。鎖住相關列，避免兩人同時停用彼此。
   */
  private async assertKeepsAnAdmin(tx: Transaction<DB>, userId: string, newRoleId: string | undefined) {
    if (newRoleId) {
      const r = await tx.selectFrom('roles').select('is_system').where('id', '=', newRoleId).executeTakeFirst();
      if (r?.is_system) return;
    }
    const admins = await tx
      .selectFrom('users as u')
      .innerJoin('roles as r', 'r.id', 'u.role_id')
      .select('u.id')
      .where('r.is_system', '=', true)
      .where('u.enabled', '=', true)
      .forUpdate()
      .execute();
    if (admins.some((a) => a.id === userId) && admins.length <= 1) throw new AppError('INVALID_STATE', LAST_ADMIN);
  }
}

const USER_COLUMNS = [
  'u.id',
  'u.username',
  'u.display_name',
  'u.phone',
  'u.email',
  'u.enabled',
  'u.locked_until',
  'u.last_login_at',
  'u.created_at',
  'r.id as role_id',
  'r.name as role_name',
] as const;

function iso(d: Date | string | null): string | null {
  return d ? new Date(d).toISOString() : null;
}

function view(r: {
  id: string;
  username: string;
  display_name: string;
  phone: string | null;
  email: string | null;
  enabled: boolean;
  locked_until: Date | string | null;
  last_login_at: Date | string | null;
  created_at: Date;
  role_id: string;
  role_name: string;
}): UserView {
  const lockedUntil = r.locked_until && new Date(r.locked_until) > new Date() ? iso(r.locked_until) : null;
  return {
    id: r.id,
    username: r.username,
    displayName: r.display_name,
    role: { id: r.role_id, name: r.role_name },
    phone: r.phone,
    email: r.email,
    enabled: r.enabled,
    lockedUntil,
    lastLoginAt: iso(r.last_login_at),
    createdAt: r.created_at.toISOString(),
  };
}
