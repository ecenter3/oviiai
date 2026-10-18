import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequirePerm } from '../auth/perm.decorator';
import type { Principal } from '../auth/principal';
import { isPermCode, PERM_TREE, type PermCode } from '@oviiai/contracts';
import { ZodPipe } from '../common/zod.pipe';
import { OpLog } from '../oplog/oplog.decorator';
import { RolesService } from './roles.service';

const Perms = z.array(z.string().refine(isPermCode, (s) => ({ message: `未知的權限碼：${s}` }))).max(100);

const CreateRoleBody = z.object({
  name: z.string().trim().min(1).max(32),
  description: z.string().trim().max(200).nullable().optional(),
  perms: Perms,
  /** 不自動登出（例：監看大屏）；PR #16 審查第 1 點 */
  noIdleLogout: z.boolean().optional(),
});
const UpdateRoleBody = CreateRoleBody.partial().strict();

const roleTarget = (id: unknown) => (id ? `role:${id}` : null);

@Controller()
@RequirePerm('roles')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  /** 全部權限碼與中文名稱（樹狀），角色管理頁勾選用 */
  @Get('permissions')
  permissions() {
    return PERM_TREE;
  }

  @Get('roles')
  list() {
    return this.roles.list();
  }

  @Get('roles/:id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.roles.get(id);
  }

  @Post('roles')
  @OpLog('role.create', (_req, res) => roleTarget((res as { id?: string } | undefined)?.id))
  create(@Body(new ZodPipe(CreateRoleBody)) body: z.infer<typeof CreateRoleBody>, @CurrentUser() actor: Principal) {
    return this.roles.create({ ...body, perms: body.perms as PermCode[] }, actor);
  }

  @Patch('roles/:id')
  @OpLog('role.update', (req) => roleTarget(req.params.id))
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(UpdateRoleBody)) body: z.infer<typeof UpdateRoleBody>,
    @CurrentUser() actor: Principal,
  ) {
    return this.roles.update(id, { ...body, perms: body.perms as PermCode[] | undefined }, actor);
  }

  @Delete('roles/:id')
  @HttpCode(204)
  @OpLog('role.delete', (req) => roleTarget(req.params.id))
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: Principal) {
    await this.roles.remove(id, actor);
  }
}
