import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequirePerm } from '../auth/perm.decorator';
import type { Principal } from '../auth/principal';
import { PageQuery } from '../common/pagination';
import { ZodPipe } from '../common/zod.pipe';
import { OpLog } from '../oplog/oplog.decorator';
import { RobotLogsService, SUBSYSTEMS } from './robot-logs.service';

const ListQuery = PageQuery.extend({ robotId: z.string().uuid().optional(), subsystem: z.enum(SUBSYSTEMS).optional() });
const RequestBody = z.object({ robotId: z.string().uuid(), subsystem: z.enum(SUBSYSTEMS) }).strict();

/** 日誌管理（T-42，權限 logs）：向機器人要日誌、列出、下載 */
@Controller('robot-logs')
@RequirePerm('logs')
export class RobotLogsController {
  constructor(private readonly logs: RobotLogsService) {}

  @Get()
  list(@Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.logs.list({ robotId: q.robotId, subsystem: q.subsystem }, q.page, q.size);
  }

  @Post()
  @OpLog('robot.logs_request', (req: Request) => `robot:${String((req.body as { robotId?: string })?.robotId ?? '')}`)
  request(@Body(new ZodPipe(RequestBody)) b: z.infer<typeof RequestBody>, @CurrentUser() user: Principal) {
    return this.logs.request(b.robotId, b.subsystem, user.sub);
  }

  /** 5 分鐘預簽名下載網址 */
  @Get(':id/url')
  url(@Param('id', ParseUUIDPipe) id: string) {
    return this.logs.downloadUrl(id);
  }
}
