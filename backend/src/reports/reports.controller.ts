import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { z } from 'zod';
import { RequireAnyPerm, RequirePerm } from '../auth/perm.decorator';
import { PageQuery } from '../common/pagination';
import { ZodPipe } from '../common/zod.pipe';
import { ReportsService } from './reports.service';

const when = z.string().datetime({ offset: true }).transform((s) => new Date(s));
const RangeQuery = z.object({ from: when, to: when });
const ReportQuery = RangeQuery.merge(PageQuery).extend({
  floorId: z.string().max(32).optional(),
  robotId: z.string().uuid().optional(),
  q: z.string().trim().max(64).optional(),
});

/** T-39 第二期：能耗管理、任務報告、運行日誌（只讀） */
@Controller()
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  /** 能耗：電量、電壓、電流、耗電量曲線＋區間內的充電紀錄與統計 */
  @Get('energy/:robotId')
  @RequirePerm('energy')
  energy(@Param('robotId', ParseUUIDPipe) id: string, @Query(new ZodPipe(RangeQuery)) q: z.infer<typeof RangeQuery>) {
    return this.reports.energy(id, q);
  }

  /** 介面規格：軌跡（telemetry 降採樣）。歷史視頻（第二期）與任務報告共用 */
  @Get('robots/:id/track')
  @RequireAnyPerm('history', 'reports')
  track(@Param('id', ParseUUIDPipe) id: string, @Query(new ZodPipe(RangeQuery)) q: z.infer<typeof RangeQuery>) {
    return this.reports.track(id, q);
  }

  /** 任務報告列表：已結束的任務，依開始時間篩選 */
  @Get('reports/tasks')
  @RequirePerm('reports')
  list(@Query(new ZodPipe(ReportQuery)) q: z.infer<typeof ReportQuery>) {
    return this.reports.taskReports({ from: q.from, to: q.to, floor: q.floorId, robot: q.robotId, q: q.q || undefined }, q.page, q.size);
  }

  /** 單筆任務報告：軌跡、里程、告警與抓拍數、事件 */
  @Get('reports/tasks/:id')
  @RequirePerm('reports')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.reports.taskReport(id);
  }

  /** 運行日誌：狀態時間軸 */
  @Get('runlog/:robotId')
  @RequirePerm('runlog')
  runlog(@Param('robotId', ParseUUIDPipe) id: string, @Query(new ZodPipe(RangeQuery)) q: z.infer<typeof RangeQuery>) {
    return this.reports.runlog(id, q);
  }
}
