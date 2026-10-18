import { Controller, Get, Inject, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { RequirePerm } from '../auth/perm.decorator';
import { ZodPipe } from '../common/zod.pipe';
import { KYSELY, type Database } from '../db/database.module';
import { StatsService } from './stats.service';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式 YYYY-MM-DD');
const StatsQuery = z.object({
  from: day,
  to: day,
  floorId: z.string().max(32).optional(),
  robotId: z.string().uuid().optional(),
});

/** T-40 數據統計（介面規格 GET /stats/summary；第二期）。日期為台北日期，含兩端 */
@Controller('stats')
@RequirePerm('stats')
export class StatsController {
  constructor(
    private readonly stats: StatsService,
    @Inject(KYSELY) private readonly db: Database,
  ) {}

  @Get('summary')
  summary(@Query(new ZodPipe(StatsQuery)) q: z.infer<typeof StatsQuery>) {
    return this.stats.summary(q);
  }

  /** 匯出 Excel（總覽、每日、各機器人） */
  @Get('export')
  async export(@Query(new ZodPipe(StatsQuery)) q: z.infer<typeof StatsQuery>, @Res() res: Response) {
    const [floor, robot] = await Promise.all([
      q.floorId ? this.db.selectFrom('floors').select('name').where('id', '=', q.floorId).executeTakeFirst() : undefined,
      q.robotId ? this.db.selectFrom('robots').select('code').where('id', '=', q.robotId).executeTakeFirst() : undefined,
    ]);
    const buf = await this.stats.xlsx(q, { floorName: floor?.name, robotCode: robot?.code });
    const name = `stats-${q.from.replace(/-/g, '')}-${q.to.replace(/-/g, '')}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.send(buf);
  }
}
