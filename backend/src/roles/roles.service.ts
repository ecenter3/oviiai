import { Inject, Injectable } from '@nestjs/common';
import { assertWithinOwnPerms } from '../auth/escalation';
import type { Principal } from '../auth/principal';
import { AppError } from '../common/errors';
import { PG_UNIQUE_VIOLATION, pgCode } from '../common/pg-errors';
import { KYSELY, type Database } from '../db/database.module';
import { ALL_PERMS, type PermCode } from '@oviiai/contracts';

export interface RoleView {
  id: string;
  name: string;
  description: string | null;
  perms: string[];
  isSystem: boolean;
  memberCount: number;
  createdAt: string;
}

export interface SaveRole {
  name: string;
  description?: string | null;
  perms: PermCode[];
}

const DUP_NAME = () => new AppError('VALIDATION_FAILED', '角色名稱已存在', { fields: { name: '角色名稱已存在' } });

@Injectable()
export class RolesService {
  constructor(@Inject(KYSELY) private readonly db: Database) {}

  async list(): Promise<RoleView[]> {
    const rows = await this.query().orderBy('r.is_system', 'desc').orderBy('r.created_at').execute();
    return rows.map(view);
  }

  async get(id: string): Promise<RoleView> {
    const row = await this.query().where('r.id', '=', id).executeTakeFirst();
    if (!row) throw new AppError('NOT_FOUND', '找不到角色');
    return view(row);
  }

  async create(dto: SaveRole, actor: Principal): Promise<RoleView> {
    assertWithinOwnPerms(actor, dto.perms, '角色的權限');
    try {
      const { id } = await this.db
        .insertInto('roles')
        .values({ name: dto.name, description: dto.description ?? null, perms: normalize(dto.perms) })
        .returning('id')
        .executeTakeFirstOrThrow();
      return this.get(id);
    } catch (e) {
      if (pgCode(e) === PG_UNIQUE_VIOLATION) throw DUP_NAME();
      throw e;
    }
  }

  /** 改名、改權限；系統角色（系統管理員）固定擁有全部權限，避免把自己鎖在門外 */
  async update(id: string, dto: Partial<SaveRole>, actor: Principal): Promise<RoleView> {
    const role = await this.get(id);
    const perms = dto.perms && normalize(dto.perms);
    // 只檢查新加入的權限：移除自己沒有的權限不算提升
    if (perms) assertWithinOwnPerms(actor, perms.filter((p) => !role.perms.includes(p)), '新增的權限');
    if (role.isSystem && perms && perms.join() !== normalize(role.perms as PermCode[]).join()) {
      throw new AppError('INVALID_STATE', '系統角色的權限不可修改');
    }
    try {
      await this.db
        .updateTable('roles')
        .set({
          ...(dto.name !== undefined && { name: dto.name }),
          ...(dto.description !== undefined && { description: dto.description }),
          ...(perms && !role.isSystem && { perms }),
        })
        .where('id', '=', id)
        .execute();
    } catch (e) {
      if (pgCode(e) === PG_UNIQUE_VIOLATION) throw DUP_NAME();
      throw e;
    }
    return this.get(id);
  }

  async remove(id: string): Promise<void> {
    const role = await this.get(id);
    if (role.isSystem) throw new AppError('INVALID_STATE', '系統角色不可刪除');
    if (role.memberCount > 0) {
      throw new AppError('INVALID_STATE', `尚有 ${role.memberCount} 個帳號使用此角色，請先改派`, {
        memberCount: role.memberCount,
      });
    }
    await this.db.deleteFrom('roles').where('id', '=', id).execute();
  }

  private query() {
    return this.db
      .selectFrom('roles as r')
      .leftJoin('users as u', 'u.role_id', 'r.id')
      .select((eb) => [
        'r.id',
        'r.name',
        'r.description',
        'r.perms',
        'r.is_system',
        'r.created_at',
        eb.fn.count<string>('u.id').as('member_count'),
      ])
      .groupBy('r.id');
  }
}

/** 去重並依權限樹順序排列 */
function normalize(perms: PermCode[]): PermCode[] {
  const set = new Set(perms);
  return ALL_PERMS.filter((p) => set.has(p));
}

function view(r: {
  id: string;
  name: string;
  description: string | null;
  perms: string[];
  is_system: boolean;
  created_at: Date;
  member_count: string;
}): RoleView {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    perms: r.perms,
    isSystem: r.is_system,
    memberCount: Number(r.member_count),
    createdAt: r.created_at.toISOString(),
  };
}
