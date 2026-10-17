import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { PARAM_SUBSYSTEMS, subsystemSchema } from '@oviiai/contracts';
import type { Request } from 'express';
import { z } from 'zod';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequirePerm } from '../auth/perm.decorator';
import type { Principal } from '../auth/principal';
import { ZodPipe } from '../common/zod.pipe';
import { OpLog } from '../oplog/oplog.decorator';
import { ParamsService } from './params.service';

/** 子系統的值依 contracts 的 PARAM_SCHEMA 驗證（前端表單用同一份） */
const SaveBody = z
  .object({ subsystem: z.enum(PARAM_SUBSYSTEMS), values: z.record(z.unknown()) })
  .strict()
  .superRefine((b, ctx) => {
    const r = subsystemSchema(b.subsystem).safeParse(b.values);
    if (!r.success) for (const i of r.error.issues) ctx.addIssue({ ...i, path: ['values', ...i.path] } as z.IssueData);
  });
const ApplyBody = z.object({ fromRobotId: z.string().uuid(), floorId: z.string().min(1).max(8), subsystem: z.enum(PARAM_SUBSYSTEMS) }).strict();

const robotTarget = (req: Request) => `robot:${req.params.id}`;

/**
 * 機器人參數（介面規格：GET params、PUT／套用同樓層 params＋op.config；T-27）。
 * 儲存一次一個子系統（原型「儲存參數」只存目前畫面的子系統）。
 */
@Controller('robots')
export class ParamsController {
  constructor(private readonly params: ParamsService) {}

  @Get(':id/params')
  @RequirePerm('params')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.params.get(id);
  }

  @Put(':id/params')
  @RequirePerm('params', 'op.config')
  @OpLog((req) => `robot.params.${(req.body as { subsystem?: string })?.subsystem ?? 'unknown'}`, robotTarget)
  save(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(SaveBody)) b: z.infer<typeof SaveBody>, @CurrentUser() user: Principal) {
    return this.params.save(id, b.subsystem, b.values, user.sub);
  }

  @Post('params/apply-floor')
  @HttpCode(200)
  @RequirePerm('params', 'op.config')
  @OpLog((req) => `robot.params.apply_floor.${(req.body as { subsystem?: string })?.subsystem ?? 'unknown'}`, (req) => `floor:${(req.body as { floorId?: string })?.floorId}`)
  applyFloor(@Body(new ZodPipe(ApplyBody)) b: z.infer<typeof ApplyBody>, @CurrentUser() user: Principal) {
    return this.params.applyFloor(b.fromRobotId, b.floorId, b.subsystem, user.sub);
  }
}
