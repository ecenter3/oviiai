import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequireAnyPerm, RequirePerm } from '../auth/perm.decorator';
import type { Principal } from '../auth/principal';
import { ZodPipe } from '../common/zod.pipe';
import { OpLog } from '../oplog/oplog.decorator';
import { COMMAND_PERMS, USER_COMMAND_TYPES } from './command-spec';
import { CommandsService } from './commands.service';

const CommandBody = z.object({
  type: z.enum(USER_COMMAND_TYPES),
  args: z.record(z.unknown()).optional(),
});
const AcquireBody = z.object({ force: z.boolean().optional() }).strict().optional();

const robotTarget = (req: Request) => `robot:${req.params.id}`;

@Controller('robots/:id')
export class CommandsController {
  constructor(private readonly commands: CommandsService) {}

  /**
   * 介面規格 §3：回 202 {cmdId, status:'sent'}，結果以 WebSocket `robot.cmdResult` 推送。
   * 路由層只要求「有任一指令權限」，實際所需權限依指令類型在 service 檢查。
   */
  @Post('commands')
  @HttpCode(202)
  @RequireAnyPerm(...COMMAND_PERMS)
  @OpLog((req) => `robot.${(req.body as { type?: string })?.type ?? 'command'}`, robotTarget)
  async send(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(CommandBody)) body: z.infer<typeof CommandBody>,
    @CurrentUser() actor: Principal,
  ) {
    const rec = await this.commands.issue(id, body.type, body.args, actor);
    return { cmdId: rec.cmdId, status: rec.status };
  }

  @Post('teleop/acquire')
  @HttpCode(200)
  @RequirePerm('op.remote')
  @OpLog('robot.teleop_acquire', robotTarget)
  acquire(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(AcquireBody)) body: z.infer<typeof AcquireBody>,
    @CurrentUser() actor: Principal,
  ) {
    return this.commands.acquire(id, actor, body?.force ?? false);
  }

  @Post('teleop/release')
  @HttpCode(204)
  @RequirePerm('op.remote')
  @OpLog('robot.teleop_release', robotTarget)
  async release(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: Principal) {
    await this.commands.release(id, actor);
  }
}
