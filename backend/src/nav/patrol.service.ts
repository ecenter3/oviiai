import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { type Job, Queue, Worker } from 'bullmq';
import { AlarmsService } from '../alarms/alarms.service';
import { AppError } from '../common/errors';
import { TeleopLock } from '../commands/teleop-lock.service';
import { KYSELY, type Database } from '../db/database.module';
import type { Priority } from '../dispatch/task-state';
import { type TaskView, TasksService } from '../dispatch/tasks.service';
import { FleetService } from '../fleet/fleet.service';
import { RobotRegistry } from '../fleet/robot-registry';
import { bullConnection, bullPrefix } from '../jobs/bull';
import { SettingsService } from '../settings/settings.service';
import { cronOf, LATE_LIMIT_MS, onceAt, PINNED_WAIT_MS, type Repeat, unavailableReason } from './nav-plan';

const QUEUE = 'patrol';
const SWEEP_MS = 30_000;
const schedulerId = (id: string) => `patrol:${id}`;
const onceJobId = (id: string, at: number) => `once-${id}-${at}`;

interface JobData {
  scheduleId: string;
  /** 僅一次的預定時間（ms）；重複排程由 BullMQ 的 job 時間推算 */
  at?: number;
}

export interface ScheduleRow {
  id: string;
  name: string;
  path_id: string;
  robot_id: string | null;
  start_time: string;
  repeat: Repeat;
  once_date: string | null;
  loops: number;
  priority: string;
  enabled: boolean;
}

/**
 * 巡邏排程（工程開發手冊 後端邏輯 §4、T-23）。
 *
 * - 每筆 patrol_schedules 對應一個 BullMQ job scheduler（cron 由 start_time＋repeat 換算，Asia/Taipei）；
 *   僅一次的排程是一個延遲 job。新增、修改、停用、刪除時同步；啟動時全部對齊一次。
 * - 觸發時建立 source=schedule 的巡邏任務（排程建立時已經審批，任務不再審批）。後端停機時錯過的，
 *   重啟後 BullMQ 會補送；遲到超過 30 分鐘的不補跑。
 * - 指定機器人但它離線、急停、遙控中或電量不足：任務留在佇列，發三級「巡邏延後」告警說明原因；
 *   30 分鐘內仍未派出 → failed。
 */
@Injectable()
export class PatrolService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Patrol');
  private queue?: Queue<JobData>;
  private worker?: Worker<JobData>;
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(KYSELY) private readonly db: Database,
    private readonly tasks: TasksService,
    private readonly registry: RobotRegistry,
    private readonly fleet: FleetService,
    private readonly lock: TeleopLock,
    private readonly settings: SettingsService,
    private readonly alarms: AlarmsService,
  ) {}

  async onModuleInit() {
    const connection = bullConnection();
    this.queue = new Queue<JobData>(QUEUE, { connection, prefix: bullPrefix() });
    this.worker = new Worker<JobData>(QUEUE, (job) => this.process(job), { connection, prefix: bullPrefix() });
    this.worker.on('failed', (job, e) => this.log.error(`巡邏排程 ${job?.data.scheduleId} 觸發失敗：${e.message}`));
    await this.sync().catch((e) => this.log.error(`巡邏排程同步失敗：${e instanceof Error ? e.message : e}`));
    this.timer = setInterval(() => void this.sweep().catch((e) => this.log.error(e instanceof Error ? e.stack : String(e))), SWEEP_MS);
  }

  async onModuleDestroy() {
    clearInterval(this.timer);
    await this.worker?.close();
    await this.queue?.close();
  }

  /** 啟動時：資料庫的排程 ↔ BullMQ 對齊（多的移除、少的補上） */
  async sync(): Promise<void> {
    const rows = (await this.db.selectFrom('patrol_schedules').selectAll().execute()) as ScheduleRow[];
    const ids = new Set(rows.map((r) => r.id));
    for (const s of await this.queue!.getJobSchedulers(0, -1)) {
      const id = (s.key ?? '').replace(/^patrol:/, '');
      if (!ids.has(id) && s.key) await this.queue!.removeJobScheduler(s.key);
    }
    for (const r of rows) await this.apply(r);
  }

  /** 新增、修改後：重建這筆排程的 job */
  async apply(s: ScheduleRow): Promise<void> {
    await this.unschedule(s.id);
    if (!s.enabled) return;
    const cron = cronOf(s.start_time, s.repeat);
    if (cron) {
      await this.queue!.upsertJobScheduler(schedulerId(s.id), { pattern: cron, tz: 'Asia/Taipei' }, { name: 'patrol', data: { scheduleId: s.id } });
    } else if (s.once_date) {
      const at = onceAt(s.once_date, s.start_time);
      if (at > Date.now() - LATE_LIMIT_MS) {
        await this.queue!.add('patrol', { scheduleId: s.id, at }, { jobId: onceJobId(s.id, at), delay: Math.max(0, at - Date.now()), removeOnComplete: true, removeOnFail: true });
      }
    }
  }

  /** 移除這筆排程的 job（停用、刪除） */
  async unschedule(id: string): Promise<void> {
    await this.queue!.removeJobScheduler(schedulerId(id));
    for (const j of await this.queue!.getDelayed()) if (j.data.scheduleId === id) await j.remove().catch(() => undefined);
  }

  /** 下次觸發時間（ms），停用或已過的僅一次排程為 null */
  async nextRun(s: ScheduleRow): Promise<number | null> {
    if (!s.enabled) return null;
    if (s.repeat === 'once') {
      const at = s.once_date ? onceAt(s.once_date, s.start_time) : 0;
      return at > Date.now() ? at : null;
    }
    const js = await this.queue!.getJobScheduler(schedulerId(s.id));
    return js?.next ?? null;
  }

  /**
   * 觸發一次：建立巡邏任務。排程自動觸發時 actor 為 null（遲到 30 分鐘以上不補跑、停用的不跑）；
   * 使用者按「立即執行」時 actor 為操作者。
   */
  async trigger(id: string, due = Date.now(), actor: { id: string; username: string } | null = null): Promise<TaskView | null> {
    const s = (await this.db.selectFrom('patrol_schedules').selectAll().where('id', '=', id).executeTakeFirst()) as ScheduleRow | undefined;
    if (!s) {
      if (actor) throw new AppError('NOT_FOUND', '找不到巡邏排程');
      return null;
    }
    if (!actor && !s.enabled) return null;
    if (!actor && Date.now() - due > LATE_LIMIT_MS) {
      this.log.warn(`巡邏排程「${s.name}」遲到 ${Math.round((Date.now() - due) / 60_000)} 分鐘，不補跑`);
      return null;
    }
    const path = await this.db.selectFrom('paths').select(['id', 'floor_id', 'name']).where('id', '=', s.path_id).executeTakeFirst();
    try {
      if (!path) throw new AppError('INVALID_STATE', '路徑不存在');
      const task = await this.tasks.create(
        {
          kind: 'patrol',
          priority: s.priority as Priority,
          floorId: path.floor_id,
          target: { pathId: path.id, ...(s.loops > 1 && { loops: s.loops }) },
          robotId: s.robot_id,
          note: `巡邏排程「${s.name}」`,
          source: 'schedule',
        },
        actor,
      );
      // 僅一次的排程自動觸發後停用（同一個更新，畫面不會看到中間狀態）
      await this.db
        .updateTable('patrol_schedules')
        .set({ last_run_at: new Date(), last_task_id: task.id, ...(!actor && s.repeat === 'once' && { enabled: false }) })
        .where('id', '=', id)
        .execute();
      this.log.log(`巡邏排程「${s.name}」建立任務 ${task.code}${actor ? `（${actor.username} 立即執行）` : ''}`);
      return task;
    } catch (e) {
      if (actor) throw e;
      // 自動觸發失敗（例：指定的機器人已停用）：發延後告警讓值班人員知道
      const msg = e instanceof Error ? e.message : String(e);
      await this.alarms.raise({ type: 'patrol_delayed', floorId: path?.floor_id ?? null, source: `schedule:${id}`, message: `巡邏排程「${s.name}」未能建立任務：${msg}` });
      this.log.warn(`巡邏排程「${s.name}」觸發失敗：${msg}`);
      return null;
    }
  }

  /**
   * 指定機器人的排程任務（後端邏輯 §4）：不能執行時發延後告警（一次），排隊超過 30 分鐘 → failed。
   * 背景每 30 秒；測試可直接呼叫。
   */
  async sweep(now = Date.now()): Promise<void> {
    const minAccept = await this.settings.getNumber('charge.minAccept', 40);
    const rows = await this.db
      .selectFrom('tasks')
      .select(['id'])
      .where('source', '=', 'schedule')
      .where('status', '=', 'queued')
      .where('pinned_robot', '=', true)
      .execute();
    for (const { id } of rows) {
      const t = await this.tasks.get(id);
      const robot = t.robotId ? await this.registry.resolveId(t.robotId) : undefined;
      const live = robot ? this.fleet.get(robot.code) : undefined;
      const reason = unavailableReason(
        live ? { online: live.online, state: live.state, battery: live.battery, teleopLocked: !!(await this.lock.holder(live.code)) } : null,
        minAccept,
      );
      const code = robot?.code ?? t.robotCode ?? '指定的機器人';
      if (reason && !t.progress.delayedAt) {
        await this.tasks.patchProgress(id, { delayedAt: now }, 'queued');
        await this.alarms.raise({
          type: 'patrol_delayed',
          robotId: t.robotId,
          source: `task:${id}`,
          message: `巡邏任務 ${t.code} 延後：${code} ${reason}（最多等 30 分鐘）`,
          ext: { taskId: id, reason },
        });
      }
      if (now - Date.parse(t.createdAt) > PINNED_WAIT_MS) {
        const why = `指定的 ${code} 30 分鐘內無法執行（${reason ?? '執行其他任務中'}）`;
        const v = await this.tasks.transition(id, 'failed', { only: ['queued'], patch: { ended_at: new Date(), fail_reason: why }, event: { reason: why } });
        if (v) this.log.warn(`巡邏任務 ${t.code} 逾時未派出：${why}`);
      }
    }
  }

  private async process(job: Job<JobData>) {
    const due = job.data.at ?? job.timestamp + (job.opts.delay ?? 0);
    await this.trigger(job.data.scheduleId, due);
  }
}
