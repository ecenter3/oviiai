import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequireAnyPerm, RequirePerm } from '../auth/perm.decorator';
import type { Principal } from '../auth/principal';
import { AppError } from '../common/errors';
import { ZodPipe } from '../common/zod.pipe';
import { KYSELY, type Database } from '../db/database.module';
import { PRIORITIES } from '../dispatch/task-state';
import { OpLog } from '../oplog/oplog.decorator';
import { onceAt, REPEATS } from './nav-plan';
import { PatrolService, type ScheduleRow } from './patrol.service';

const Body0 = z.object({
  name: z.string().trim().min(1).max(32),
  pathId: z.string().uuid(),
  /** null = 由派工選車 */
  robotId: z.string().uuid().nullable().default(null),
  startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, '時間格式 HH:MM'),
  repeat: z.enum(REPEATS as [string, ...string[]]),
  onceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  loops: z.number().int().min(1).max(100).default(1),
  priority: z.enum(PRIORITIES).default('P3'),
  enabled: z.boolean().default(true),
});
const CreateBody = Body0.strict();
const UpdateBody = Body0.partial().strict();

const Q = z.object({ floor: z.string().regex(/^[a-z0-9]{1,8}$/).optional() });
const target = (req: Request, res?: unknown) => `patrol:${String(req.params.id ?? (res as { id?: string } | undefined)?.id ?? '')}`;

/**
 * 巡邏排程（介面規格 CRUD /patrol-schedules，權限 nav；立即執行 op.dispatch）。
 * 建立排程即視為已審批（後端邏輯 §4），觸發的任務不再進審批。
 */
@Controller('patrol-schedules')
export class PatrolController {
  constructor(
    @Inject(KYSELY) private readonly db: Database,
    private readonly patrol: PatrolService,
  ) {}

  @Get()
  @RequireAnyPerm('nav', 'dispatch')
  async list(@Query(new ZodPipe(Q)) q: z.infer<typeof Q>) {
    let query = this.db
      .selectFrom('patrol_schedules as s')
      .innerJoin('paths as p', 'p.id', 's.path_id')
      .leftJoin('robots as r', 'r.id', 's.robot_id')
      .leftJoin('tasks as t', 't.id', 's.last_task_id')
      .leftJoin('users as u', 'u.id', 's.created_by')
      .selectAll('s')
      .select(['p.name as path_name', 'p.floor_id', 'r.code as robot_code', 't.code as last_task_code', 't.status as last_task_status', 'u.display_name as created_by_name'])
      .orderBy('s.start_time')
      .orderBy('s.name');
    if (q.floor) query = query.where('p.floor_id', '=', q.floor);
    const rows = await query.execute();
    return Promise.all(
      rows.map(async (s) => ({
        id: s.id,
        name: s.name,
        pathId: s.path_id,
        pathName: s.path_name,
        floorId: s.floor_id,
        robotId: s.robot_id,
        robotCode: s.robot_code,
        startTime: s.start_time.slice(0, 5),
        repeat: s.repeat,
        onceDate: s.once_date,
        loops: s.loops,
        priority: s.priority,
        enabled: s.enabled,
        createdByName: s.created_by_name,
        lastRunAt: s.last_run_at?.toISOString() ?? null,
        lastTask: s.last_task_code ? { id: s.last_task_id, code: s.last_task_code, status: s.last_task_status } : null,
        nextRunAt: await this.patrol.nextRun(s as ScheduleRow).then((n) => (n ? new Date(n).toISOString() : null)),
      })),
    );
  }

  @Post()
  @RequirePerm('nav')
  @OpLog('patrol.create', target)
  async create(@Body(new ZodPipe(CreateBody)) b: z.infer<typeof CreateBody>, @CurrentUser() user: Principal) {
    await this.validate(b);
    const row = (await this.db
      .insertInto('patrol_schedules')
      .values({
        name: b.name,
        path_id: b.pathId,
        robot_id: b.robotId,
        start_time: b.startTime,
        repeat: b.repeat as ScheduleRow['repeat'],
        once_date: b.repeat === 'once' ? b.onceDate : null,
        loops: b.loops,
        priority: b.priority,
        enabled: b.enabled,
        created_by: user.sub,
      })
      .returningAll()
      .executeTakeFirstOrThrow()) as ScheduleRow;
    await this.patrol.apply(row);
    return { id: row.id, nextRunAt: await this.next(row) };
  }

  @Patch(':id')
  @RequirePerm('nav')
  @OpLog('patrol.update', target)
  async update(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(UpdateBody)) b: z.infer<typeof UpdateBody>) {
    const cur = await this.db.selectFrom('patrol_schedules').selectAll().where('id', '=', id).executeTakeFirst();
    if (!cur) throw new AppError('NOT_FOUND', '找不到巡邏排程');
    const merged = {
      name: b.name ?? cur.name,
      pathId: b.pathId ?? cur.path_id,
      robotId: b.robotId !== undefined ? b.robotId : cur.robot_id,
      startTime: b.startTime ?? cur.start_time.slice(0, 5),
      repeat: b.repeat ?? cur.repeat,
      onceDate: b.onceDate !== undefined ? b.onceDate : cur.once_date,
      loops: b.loops ?? cur.loops,
      priority: (b.priority ?? cur.priority) as z.infer<typeof CreateBody>['priority'],
      enabled: b.enabled ?? cur.enabled,
    };
    await this.validate(merged, b.repeat !== undefined || b.onceDate !== undefined || b.startTime !== undefined);
    const row = (await this.db
      .updateTable('patrol_schedules')
      .set({
        name: merged.name,
        path_id: merged.pathId,
        robot_id: merged.robotId,
        start_time: merged.startTime,
        repeat: merged.repeat as ScheduleRow['repeat'],
        once_date: merged.repeat === 'once' ? merged.onceDate : null,
        loops: merged.loops,
        priority: merged.priority,
        enabled: merged.enabled,
      })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow()) as ScheduleRow;
    await this.patrol.apply(row);
    return { id, nextRunAt: await this.next(row) };
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePerm('nav')
  @OpLog('patrol.delete', target)
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    const r = await this.db.deleteFrom('patrol_schedules').where('id', '=', id).executeTakeFirst();
    if (!r.numDeletedRows) throw new AppError('NOT_FOUND', '找不到巡邏排程');
    await this.patrol.unschedule(id);
  }

  /** 立即執行一次（不影響原本的排程時間） */
  @Post(':id/run')
  @RequirePerm('op.dispatch')
  @OpLog('patrol.run', target)
  async run(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: Principal) {
    const t = await this.patrol.trigger(id, Date.now(), { id: user.sub, username: user.username });
    return { taskId: t!.id, taskCode: t!.code, status: t!.status };
  }

  private async next(row: ScheduleRow) {
    const n = await this.patrol.nextRun(row);
    return n ? new Date(n).toISOString() : null;
  }

  /** 路徑存在；指定的機器人啟用中且在路徑的樓層；僅一次要有日期且不在過去 */
  private async validate(b: { pathId: string; robotId: string | null; repeat: string; onceDate: string | null; startTime: string }, checkTime = true) {
    const path = await this.db.selectFrom('paths').select(['floor_id']).where('id', '=', b.pathId).executeTakeFirst();
    if (!path) throw new AppError('VALIDATION_FAILED', '路徑不存在', { fields: { pathId: '路徑不存在' } });
    if (b.robotId) {
      const r = await this.db.selectFrom('robots').select(['floor_id', 'enabled']).where('id', '=', b.robotId).executeTakeFirst();
      if (!r || !r.enabled) throw new AppError('VALIDATION_FAILED', '機器人不存在或已停用', { fields: { robotId: '不存在或已停用' } });
      if (r.floor_id !== path.floor_id) throw new AppError('VALIDATION_FAILED', '機器人不在路徑的樓層', { fields: { robotId: '不在路徑的樓層' } });
    }
    if (b.repeat === 'once') {
      if (!b.onceDate) throw new AppError('VALIDATION_FAILED', '僅一次的排程要指定日期', { fields: { onceDate: '必填' } });
      if (checkTime && onceAt(b.onceDate, b.startTime) < Date.now()) throw new AppError('VALIDATION_FAILED', '執行時間已經過了', { fields: { onceDate: '已過' } });
    }
  }
}
