import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequireAnyPerm, RequirePerm } from '../auth/perm.decorator';
import type { Principal } from '../auth/principal';
import { PageQuery } from '../common/pagination';
import { ZodPipe } from '../common/zod.pipe';
import { CommandBus } from '../commands/command-bus.service';
import { RobotRegistry } from '../fleet/robot-registry';
import { OpLog } from '../oplog/oplog.decorator';
import { OCCUPYING, PRIORITIES, TASK_STATUSES } from './task-state';
import { TasksService } from './tasks.service';

const Target = z.union([
  z.object({ poiId: z.string().uuid() }).strict(),
  z.object({ pathId: z.string().uuid() }).strict(),
  z.object({ x: z.number().finite(), y: z.number().finite(), yaw: z.number().finite().optional() }).strict(),
]);

const CreateTaskBody = z.object({
  kind: z.string().trim().min(1).max(32),
  priority: z.enum(PRIORITIES),
  floorId: z.string().regex(/^[a-z0-9]{1,8}$/),
  target: Target,
  robotId: z.string().uuid().nullable().optional(),
  note: z.string().trim().max(200).nullable().optional(),
});

const TaskQuery = PageQuery.extend({
  status: z
    .string()
    .transform((s) => s.split(',').filter(Boolean))
    .pipe(z.array(z.enum(TASK_STATUSES)))
    .optional(),
  floor: z.string().regex(/^[a-z0-9]{1,8}$/).optional(),
  robot: z.string().uuid().optional(),
  from: z.string().datetime({ offset: true }).transform((s) => new Date(s)).optional(),
  to: z.string().datetime({ offset: true }).transform((s) => new Date(s)).optional(),
});

const RejectBody = z.object({ reason: z.string().trim().min(1).max(200) });

const taskTarget = (id: unknown) => (id ? `task:${id}` : null);

@Controller('tasks')
export class TasksController {
  constructor(
    private readonly tasks: TasksService,
    private readonly bus: CommandBus,
    private readonly registry: RobotRegistry,
  ) {}

  /** 介面規格：dispatch。實時監控頁的「派工任務」面板也要看，讀取放寬為 dispatch 或 monitor */
  @Get()
  @RequireAnyPerm('dispatch', 'monitor')
  list(@Query(new ZodPipe(TaskQuery)) q: z.infer<typeof TaskQuery>) {
    return this.tasks.list({ status: q.status, floor: q.floor, robot: q.robot, from: q.from, to: q.to }, q.page, q.size);
  }

  @Get(':id')
  @RequireAnyPerm('dispatch', 'monitor')
  async get(@Param('id', ParseUUIDPipe) id: string) {
    return { ...(await this.tasks.get(id)), events: await this.tasks.events(id) };
  }

  @Post()
  @RequirePerm('op.dispatch')
  @OpLog('task.create', (_req, res) => taskTarget((res as { id?: string } | undefined)?.id))
  async create(@Body(new ZodPipe(CreateTaskBody)) body: z.infer<typeof CreateTaskBody>, @CurrentUser() actor: Principal) {
    const t = await this.tasks.create(body, actor.sub);
    return { id: t.id, code: t.code, status: t.status };
  }

  @Post(':id/approve')
  @HttpCode(200)
  @RequirePerm('op.approve')
  @OpLog('task.approve', (req) => taskTarget(req.params.id))
  approve(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: Principal) {
    return this.tasks.transition(id, 'queued', {
      only: ['pending_approval'],
      patch: { approved_by: actor.sub, approved_at: new Date() },
      event: { by: actor.username, approved: true },
      strict: true,
    });
  }

  @Post(':id/reject')
  @HttpCode(200)
  @RequirePerm('op.approve')
  @OpLog('task.reject', (req) => taskTarget(req.params.id))
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(RejectBody)) body: z.infer<typeof RejectBody>,
    @CurrentUser() actor: Principal,
  ) {
    return this.tasks.transition(id, 'rejected', {
      only: ['pending_approval'],
      patch: { reject_reason: body.reason, ended_at: new Date() },
      event: { by: actor.username, reason: body.reason },
      strict: true,
    });
  }

  /** 取消；執行中則先停止機器人（介面規格） */
  @Post(':id/cancel')
  @HttpCode(200)
  @RequirePerm('op.dispatch')
  @OpLog('task.cancel', (req) => taskTarget(req.params.id))
  async cancel(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: Principal) {
    const before = await this.tasks.get(id);
    const t = await this.tasks.transition(id, 'cancelled', {
      patch: { ended_at: new Date() },
      event: { by: actor.username },
      strict: true,
    });
    if (before.robotId && OCCUPYING.includes(before.status)) {
      const robot = await this.registry.resolveId(before.robotId);
      if (robot) await this.bus.send(robot, 'stop', {}, actor.sub).catch(() => undefined);
    }
    return t;
  }
}
