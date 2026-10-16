import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequireAnyPerm } from '../auth/perm.decorator';
import type { Principal } from '../auth/principal';
import { AppError } from '../common/errors';
import { ZodPipe } from '../common/zod.pipe';
import { OpLog } from '../oplog/oplog.decorator';
import { ChargingService } from './charging.service';

const FloorQuery = z.object({ floor: z.string().regex(/^[a-z0-9]{1,8}$/).optional() });

@Controller()
export class ChargingController {
  constructor(private readonly charging: ChargingService) {}

  /** 各樓層充電樁佔用、排隊、等人工充電的機器人 */
  @Get('charging')
  @RequireAnyPerm('monitor', 'robots', 'maps')
  view(@Query(new ZodPipe(FloorQuery)) q: z.infer<typeof FloorQuery>) {
    return this.charging.view(q.floor);
  }

  /** 人工充電模式：人員充好電或換好電池後按「完成充電」（後端邏輯 §3） */
  @Post('robots/:id/charge-complete')
  @HttpCode(204)
  @RequireAnyPerm('op.config', 'op.remote')
  @OpLog('robot.charge_complete', (req) => `robot:${req.params.id}`)
  async complete(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: Principal) {
    if (!(await this.charging.completeManual(id, actor.username))) {
      throw new AppError('INVALID_STATE', '這台機器人沒有在等人工充電');
    }
  }
}
