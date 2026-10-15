import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { RequirePerm } from '../auth/perm.decorator';
import { PageQuery } from '../common/pagination';
import { ZodPipe } from '../common/zod.pipe';
import { OpLogService } from './oplog.service';

const OpLogQuery = PageQuery.extend({
  user: z.string().trim().min(1).max(64).optional(),
  action: z.string().trim().min(1).max(64).optional(),
  from: z.string().datetime({ offset: true }).transform((s) => new Date(s)).optional(),
  to: z.string().datetime({ offset: true }).transform((s) => new Date(s)).optional(),
  format: z.enum(['json', 'csv']).default('json'),
});

@Controller('oplogs')
export class OpLogController {
  constructor(private readonly oplog: OpLogService) {}

  /** `?user&action&from&to&page&size`；`?format=csv` 匯出符合條件的全部紀錄 */
  @RequirePerm('oplog')
  @Get()
  async list(@Query(new ZodPipe(OpLogQuery)) q: z.infer<typeof OpLogQuery>, @Res() res: Response) {
    const filter = { user: q.user, action: q.action, from: q.from, to: q.to };
    if (q.format === 'csv') {
      await this.oplog.exportCsv(filter, res);
      return;
    }
    res.json(await this.oplog.list(filter, q.page, q.size));
  }
}
