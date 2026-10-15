import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { sql, type Transaction } from 'kysely';
import { Subject } from 'rxjs';
import { AppError } from '../common/errors';
import type { Paged } from '../common/pagination';
import { KYSELY, type Database } from '../db/database.module';
import type { DB } from '../db/types';
import { RobotRegistry } from '../fleet/robot-registry';
import { REDIS } from '../redis/redis.module';
import { SettingsService } from '../settings/settings.service';
import { initialStatus, type Priority, sourcesOf, type TaskStatus, taipeiDate } from './task-state';

export type TaskTarget = { poiId: string } | { pathId: string } | { x: number; y: number; yaw?: number };

export interface TaskView {
  id: string;
  code: string;
  kind: string;
  priority: Priority;
  source: string;
  floorId: string;
  target: TaskTarget;
  robotId: string | null;
  robotCode: string | null;
  pinnedRobot: boolean;
  status: TaskStatus;
  createdBy: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  rejectReason: string | null;
  progress: TaskProgress;
  note: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  failReason: string | null;
}

/** tasks.progress：目前執行的指令、暫停原因等 */
export interface TaskProgress {
  cmdId?: string;
  pausedBy?: PauseReason | null;
  wpIndex?: number;
  loop?: number;
  attempts?: number;
}

export type PauseReason = 'offline' | 'estop' | 'teleop' | 'charge';

export interface CreateTask {
  kind: string;
  priority: Priority;
  floorId: string;
  target: TaskTarget;
  robotId?: string | null;
  note?: string | null;
  source?: 'manual' | 'schedule' | 'alarm' | 'api';
}

export interface TaskFilter {
  status?: TaskStatus[];
  floor?: string;
  robot?: string;
  from?: Date;
  to?: Date;
}

type Patch = Partial<{
  robot_id: string | null;
  pinned_robot: boolean;
  started_at: Date;
  ended_at: Date;
  fail_reason: string | null;
  approved_by: string;
  approved_at: Date;
  reject_reason: string;
}>;

/**
 * 任務資料與狀態轉換。每次轉換都以 `UPDATE … WHERE status IN (合法來源)` 完成（同時有人改也不會跳過狀態機），
 * 並寫 task_events、發 changes$（WebSocket task.updated、派工排程）。
 */
@Injectable()
export class TasksService {
  readonly changes$ = new Subject<TaskView>();

  constructor(
    @Inject(KYSELY) private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly settings: SettingsService,
    private readonly registry: RobotRegistry,
  ) {}

  async create(dto: CreateTask, userId: string | null): Promise<TaskView> {
    await this.validateTarget(dto.floorId, dto.target);
    if (dto.robotId) {
      const r = await this.registry.resolveId(dto.robotId);
      if (!r) throw new AppError('VALIDATION_FAILED', '找不到機器人或已停用', { fields: { robotId: '找不到機器人或已停用' } });
      if (r.floor !== dto.floorId) throw new AppError('VALIDATION_FAILED', '指定的機器人不在這個樓層', { fields: { robotId: '不在這個樓層' } });
    }
    const source = dto.source ?? 'manual';
    const status = initialStatus(
      { priority: dto.priority, source },
      {
        approval: (await this.settings.get('dispatch.approval')) === true,
        approvalUntil: ((await this.settings.get('dispatch.approvalUntil')) as string | undefined) ?? null,
      },
    );
    const { id } = await this.db
      .insertInto('tasks')
      .values({
        code: await this.nextCode(),
        kind: dto.kind,
        priority: dto.priority,
        source,
        floor_id: dto.floorId,
        target: JSON.stringify(dto.target),
        robot_id: dto.robotId ?? null,
        pinned_robot: !!dto.robotId,
        status,
        created_by: userId,
        note: dto.note ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await this.event(this.db, id, 'created', { status, by: userId });
    const view = await this.get(id);
    this.changes$.next(view);
    return view;
  }

  async get(id: string): Promise<TaskView> {
    const row = await this.query().where('t.id', '=', id).executeTakeFirst();
    if (!row) throw new AppError('NOT_FOUND', '找不到任務');
    return view(row);
  }

  async events(id: string) {
    const rows = await this.db.selectFrom('task_events').selectAll().where('task_id', '=', id).orderBy('at').orderBy('id').execute();
    return rows.map((e) => ({ at: e.at.toISOString(), type: e.type, data: e.data }));
  }

  async list(f: TaskFilter, page: number, size: number): Promise<Paged<TaskView>> {
    let q = this.query();
    if (f.status?.length) q = q.where('t.status', 'in', f.status);
    if (f.floor) q = q.where('t.floor_id', '=', f.floor);
    if (f.robot) q = q.where('t.robot_id', '=', f.robot);
    if (f.from) q = q.where('t.created_at', '>=', f.from);
    if (f.to) q = q.where('t.created_at', '<', f.to);
    const [{ total }, rows] = await Promise.all([
      q.clearSelect().select((eb) => eb.fn.countAll<string>().as('total')).executeTakeFirstOrThrow(),
      q.orderBy('t.created_at', 'desc').limit(size).offset((page - 1) * size).execute(),
    ]);
    return { items: rows.map(view), total: Number(total), page, size };
  }

  /** 樓層佇列：queued，依 P1>P2>P3>P4、先建先做 */
  async queued(floor: string): Promise<TaskView[]> {
    const rows = await this.query()
      .where('t.status', '=', 'queued')
      .where('t.floor_id', '=', floor)
      .orderBy('t.priority')
      .orderBy('t.created_at')
      .execute();
    return rows.map(view);
  }

  /** 某台機器人的任務（依狀態） */
  async byRobot(robotId: string, statuses: readonly TaskStatus[]): Promise<TaskView[]> {
    const rows = await this.query().where('t.robot_id', '=', robotId).where('t.status', 'in', [...statuses]).execute();
    return rows.map(view);
  }

  /** 已有 assigned／running 任務的機器人 */
  async busyRobots(): Promise<Set<string>> {
    const rows = await this.db
      .selectFrom('tasks')
      .select('robot_id')
      .where('status', 'in', ['assigned', 'running'])
      .where('robot_id', 'is not', null)
      .execute();
    return new Set(rows.map((r) => r.robot_id!));
  }

  /**
   * 狀態轉換。目前狀態不能轉到 to 時：strict 回 409 INVALID_STATE，否則回 null（背景流程用）。
   * `only` 可再縮小允許的來源狀態。
   */
  async transition(
    id: string,
    to: TaskStatus,
    opts: { patch?: Patch; progress?: TaskProgress | null; event?: Record<string, unknown>; only?: TaskStatus[]; strict?: boolean } = {},
  ): Promise<TaskView | null> {
    const from = (opts.only ?? sourcesOf(to)).filter((s) => sourcesOf(to).includes(s));
    const row = await this.db.transaction().execute(async (tx) => {
      const r = await tx
        .updateTable('tasks')
        .set({
          status: to,
          ...opts.patch,
          ...(opts.progress === null
            ? { progress: '{}' }
            : opts.progress
              ? { progress: sql`progress || ${JSON.stringify(opts.progress)}::jsonb` as unknown as string }
              : {}),
        })
        .where('id', '=', id)
        .where('status', 'in', from)
        .returning(['id', 'status'])
        .executeTakeFirst();
      if (r) await this.event(tx, id, EVENT_OF[to], opts.event ?? null);
      return r;
    });
    if (!row) {
      if (!opts.strict) return null;
      const cur = await this.get(id);
      throw new AppError('INVALID_STATE', `任務目前是「${cur.status}」，無法變更為「${to}」`, { status: cur.status });
    }
    const v = await this.get(id);
    this.changes$.next(v);
    return v;
  }

  async event(db: Database | Transaction<DB>, taskId: string, type: string, data: Record<string, unknown> | null) {
    await db
      .insertInto('task_events')
      .values({ task_id: taskId, type, data: data ? JSON.stringify(data) : null })
      .execute();
  }

  /** 任務目標點：興趣點、路徑起點或座標（選車算距離用） */
  async targetPoint(t: Pick<TaskView, 'target'>): Promise<{ x: number; y: number; yaw?: number } | null> {
    const tg = t.target as Record<string, unknown>;
    if (typeof tg.x === 'number' && typeof tg.y === 'number') return { x: tg.x, y: tg.y, yaw: tg.yaw as number | undefined };
    if (typeof tg.poiId === 'string') {
      const p = await this.db.selectFrom('pois').select(['x', 'y', 'yaw']).where('id', '=', tg.poiId).executeTakeFirst();
      return p ? { x: p.x, y: p.y, yaw: p.yaw ?? undefined } : null;
    }
    if (typeof tg.pathId === 'string') {
      const p = await this.path(tg.pathId);
      return p?.points[0] ?? null;
    }
    return null;
  }

  async path(id: string) {
    return this.db.selectFrom('paths').select(['id', 'points', 'floor_id']).where('id', '=', id).executeTakeFirst();
  }

  private async validateTarget(floorId: string, target: TaskTarget) {
    const floor = await this.db.selectFrom('floors').select(['id', 'width_m', 'height_m']).where('id', '=', floorId).executeTakeFirst();
    if (!floor) throw new AppError('VALIDATION_FAILED', '樓層不存在', { fields: { floorId: '樓層不存在' } });
    const bad = (msg: string) => new AppError('VALIDATION_FAILED', msg, { fields: { target: msg } });
    if ('poiId' in target) {
      const p = await this.db.selectFrom('pois').select('floor_id').where('id', '=', target.poiId).executeTakeFirst();
      if (!p) throw bad('興趣點不存在');
      if (p.floor_id !== floorId) throw bad('興趣點不在這個樓層');
    } else if ('pathId' in target) {
      const p = await this.path(target.pathId);
      if (!p) throw bad('路徑不存在');
      if (p.floor_id !== floorId) throw bad('路徑不在這個樓層');
      if (!p.points.length) throw bad('路徑沒有航點');
    } else {
      const w = floor.width_m === null ? Infinity : Number(floor.width_m);
      const h = floor.height_m === null ? Infinity : Number(floor.height_m);
      if (target.x < 0 || target.y < 0 || target.x > w || target.y > h) throw bad('座標超出樓層範圍');
    }
  }

  /** T-20261015-0042：台北日期＋當日流水號 */
  private async nextCode(): Promise<string> {
    const day = taipeiDate().replace(/-/g, '');
    const k = `task:seq:${day}`;
    const n = await this.redis.incr(k);
    if (n === 1) await this.redis.expire(k, 3 * 86400);
    return `T-${day}-${String(n).padStart(4, '0')}`;
  }

  private query() {
    return this.db.selectFrom('tasks as t').leftJoin('robots as r', 'r.id', 't.robot_id').selectAll('t').select('r.code as robot_code');
  }
}

const EVENT_OF: Record<TaskStatus, string> = {
  pending_approval: 'created',
  queued: 'queued',
  assigned: 'assigned',
  running: 'started',
  paused: 'paused',
  done: 'done',
  cancelled: 'cancelled',
  failed: 'failed',
  rejected: 'rejected',
};

type Row = DB['tasks'] extends infer _ ? Awaited<ReturnType<ReturnType<TasksService['query']>['executeTakeFirstOrThrow']>> : never;

const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);

function view(r: Row): TaskView {
  return {
    id: r.id,
    code: r.code,
    kind: r.kind,
    priority: r.priority as Priority,
    source: r.source,
    floorId: r.floor_id,
    target: r.target as TaskTarget,
    robotId: r.robot_id,
    robotCode: r.robot_code ?? null,
    pinnedRobot: r.pinned_robot,
    status: r.status as TaskStatus,
    createdBy: r.created_by,
    approvedBy: r.approved_by,
    approvedAt: iso(r.approved_at),
    rejectReason: r.reject_reason,
    progress: (r.progress ?? {}) as TaskProgress,
    note: r.note,
    createdAt: r.created_at.toISOString(),
    startedAt: iso(r.started_at),
    endedAt: iso(r.ended_at),
    failReason: r.fail_reason,
  };
}
