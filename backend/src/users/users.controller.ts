import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser } from '../auth/current-user.decorator';
import { PasswordPolicy } from '../auth/password';
import { RequirePerm } from '../auth/perm.decorator';
import type { Principal } from '../auth/principal';
import { PageQuery } from '../common/pagination';
import { ZodPipe } from '../common/zod.pipe';
import { OpLog } from '../oplog/oplog.decorator';
import { UsersService } from './users.service';

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((s) => s || null)
    .nullable()
    .optional();

const UserQuery = PageQuery.extend({
  q: z.string().trim().min(1).max(64).optional(),
  roleId: z.string().uuid().optional(),
  enabled: z.enum(['true', 'false']).transform((s) => s === 'true').optional(),
});

const CreateUserBody = z.object({
  username: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9._-]{3,32}$/, '帳號為 3–32 碼英數字或 . _ -'),
  displayName: z.string().trim().min(1).max(64),
  password: PasswordPolicy,
  roleId: z.string().uuid(),
  phone: optionalText(32),
  email: z.string().trim().email().max(128).nullable().optional(),
});

const UpdateUserBody = z
  .object({
    displayName: z.string().trim().min(1).max(64),
    roleId: z.string().uuid(),
    phone: optionalText(32),
    email: z.string().trim().email().max(128).nullable(),
    enabled: z.boolean(),
  })
  .partial()
  .strict();

const userTarget = (id: unknown) => (id ? `user:${id}` : null);

@Controller('users')
@RequirePerm('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  list(@Query(new ZodPipe(UserQuery)) q: z.infer<typeof UserQuery>) {
    return this.users.list({ q: q.q, roleId: q.roleId, enabled: q.enabled }, q.page, q.size);
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.users.get(id);
  }

  @Post()
  @OpLog('user.create', (_req, res) => userTarget((res as { id?: string } | undefined)?.id))
  create(@Body(new ZodPipe(CreateUserBody)) body: z.infer<typeof CreateUserBody>, @CurrentUser() actor: Principal) {
    return this.users.create(body, actor);
  }

  @Patch(':id')
  @OpLog('user.update', (req) => userTarget(req.params.id))
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(UpdateUserBody)) body: z.infer<typeof UpdateUserBody>,
    @CurrentUser() actor: Principal,
  ) {
    return this.users.update(id, body, actor);
  }

  @Delete(':id')
  @HttpCode(204)
  @OpLog('user.delete', (req) => userTarget(req.params.id))
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: Principal) {
    await this.users.remove(id, actor);
  }

  @Post(':id/reset-password')
  @HttpCode(200)
  @OpLog('user.reset_password', (req) => userTarget(req.params.id))
  resetPassword(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: Principal) {
    return this.users.resetPassword(id, actor);
  }
}
