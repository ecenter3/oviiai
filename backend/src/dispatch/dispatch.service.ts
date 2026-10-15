import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import type { Subscription } from 'rxjs';
import { CommandBus, type CmdResultOut, newCmdId } from '../commands/command-bus.service';
import { CommandsService } from '../commands/commands.service';
import { TeleopLock } from '../commands/teleop-lock.service';
import { FleetService } from '../fleet/fleet.service';
import { RobotRegistry } from '../fleet/robot-registry';
import type { FleetEvent, RobotInfo } from '../fleet/types';
import { REDIS } from '../redis/redis.module';
import { SettingsService } from '../settings/settings.service';
import { type Candidate, planRound, type QueuedTask } from './pick-robot';
import { OCCUPYING } from './task-state';
import { type PauseReason, TasksService, type TaskView } from './tasks.service';

/** 每 10 秒保底掃一次（後端邏輯 §2：觸發時機） */
const SWEEP_MS = 10_000;
const LOCK_TTL_MS = 10_000;
const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

/**
 * 派工（工程開發手冊 後端邏輯 §2、T-16）。
 *
 * 觸發：任務進入 queued、機器人變 idle 或恢復上線、任務結束、每 10 秒保底。
 * 同樓層以 Redis 鎖 `dispatch:{floor}` 串行處理；加上「已有 assigned／running 任務的機器人不選」，
 * 同時建單也不會把同一台派兩次。
 *
 * 任務與指令：派出時先把 cmdId 寫進任務（assigned）再送 navigate／patrol，
 * 轉接器 accepted → running、done → done、rejected／failed／逾時 → failed。
 *
 * 暫停與續做：離線、急停、遙控接管 → paused（記原因）；原因解除 → queued，優先派回同一台。
 * 使用者對執行中的機器人下「停止」或「導航」→ 視為人工接手，任務 failed。
 * P1 插隊（T-17）、充電排程（T-19）不在這裡。
 */
@Injectable()
export class DispatchService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Dispatch');
  private subs: Subscription[] = [];
  private sweeper?: NodeJS.Timeout;
  private readonly pending = new Set<string>();
  private readonly running = new Set<string>();
  private readonly rerun = new Set<string>();
  private closing = false;

  constructor(
    private readonly tasks: TasksService,
    private readonly fleet: FleetService,
    private readonly registry: RobotRegistry,
    private readonly bus: CommandBus,
    private readonly commands: CommandsService,
    private readonly lock: TeleopLock,
    private readonly settings: SettingsService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  onModuleInit() {
    const safe = (p: Promise<unknown>) => void p.catch((e) => this.log.error(e instanceof Error ? e.stack : String(e)));
    this.subs = [
      this.tasks.changes$.subscribe((t) => {
        if (t.status === 'queued') this.schedule(t.floorId);
        // 任務結束，那台機器人空出來了
        if (['done', 'failed', 'cancelled'].includes(t.status)) this.schedule(t.floorId);
      }),
      this.fleet.events$.subscribe((e) => safe(this.onFleet(e))),
      this.bus.results$.subscribe((r) => safe(this.onResult(r))),
      this.commands.issued$.subscribe(({ robot, type }) => {
        if (type === 'estop') safe(this.pauseRobot(robot, 'estop'));
        else if (type === 'charge') safe(this.pauseRobot(robot, 'charge'));
        else if (type === 'stop' || type === 'navigate') safe(this.failRobot(robot, '人工介入（使用者下達停止或導航）'));
      }),
      this.commands.teleop$.subscribe(({ robot, acquired }) =>
        safe(acquired ? this.pauseRobot(robot, 'teleop') : this.resumeRobot(robot, 'teleop')),
      ),
      this.registry.removed$.subscribe((r) => safe(this.requeueRemoved(r))),
    ];
    this.sweeper = setInterval(() => {
      for (const f of new Set(this.registry.all().map((r) => r.floor))) this.schedule(f);
    }, SWEEP_MS);
  }

  onModuleDestroy() {
    this.closing = true;
    clearInterval(this.sweeper);
    for (const s of this.subs) s.unsubscribe();
  }

  /** 排一輪該樓層的派工（合併短時間內的多次觸發；正在跑就跑完再補一輪） */
  schedule(floor: string): void {
    if (this.closing || this.pending.has(floor)) return;
    if (this.running.has(floor)) {
      this.rerun.add(floor);
      return;
    }
    this.pending.add(floor);
    setTimeout(() => {
      this.pending.delete(floor);
      void this.runFloor(floor).catch((e) => this.log.error(`派工 ${floor}：${e instanceof Error ? e.stack : e}`));
    }, 0);
  }

  /** 一輪派工；回傳派出的筆數（測試用） */
  async runFloor(floor: string): Promise<number> {
    const token = randomUUID();
    const key = `dispatch:${floor}`;
    if ((await this.redis.set(key, token, 'PX', LOCK_TTL_MS, 'NX')) !== 'OK') {
      // 另一個流程正在派這個樓層：稍後再補一輪
      setTimeout(() => this.schedule(floor), 500);
      return 0;
    }
    this.running.add(floor);
    try {
      return await this.round(floor);
    } finally {
      await this.redis.eval(RELEASE, 1, key, token);
      this.running.delete(floor);
      if (this.rerun.delete(floor)) this.schedule(floor);
    }
  }

  private async round(floor: string): Promise<number> {
    const queued = await this.tasks.queued(floor);
    if (!queued.length) return 0;

    const minAccept = await this.settings.getNumber('charge.minAccept', 40);
    const busy = await this.tasks.busyRobots();
    const robots: Candidate[] = [];
    for (const info of this.registry.all().filter((r) => r.floor === floor)) {
      const live = this.fleet.get(info.code);
      if (!live) continue;
      robots.push({
        robotId: info.id,
        code: info.code,
        floor: info.floor,
        online: live.online,
        enabled: true,
        state: live.state,
        battery: live.battery,
        x: live.x,
        y: live.y,
        caps: info.caps,
        teleopLocked: !!(await this.lock.holder(info.code)),
        busy: busy.has(info.id),
      });
    }

    const plan: QueuedTask[] = [];
    for (const t of queued) {
      const target = await this.tasks.targetPoint(t);
      if (!target) {
        await this.tasks.transition(t.id, 'cancelled', { event: { reason: '目標不存在（興趣點或路徑已刪除）' }, only: ['queued'] });
        continue;
      }
      plan.push({
        id: t.id,
        priority: t.priority,
        createdAt: new Date(t.createdAt),
        floorId: t.floorId,
        robotId: t.robotId,
        pinnedRobot: t.pinnedRobot,
        target,
        requiredCaps: [],
      });
    }

    let sent = 0;
    for (const [qt, cand] of planRound(plan, robots, { minAccept })) {
      const task = queued.find((t) => t.id === qt.id)!;
      const robot = this.registry.get(cand.code)!;
      if (await this.assign(task, robot)) sent++;
      else break; // 送不出去（MQTT 斷線）：這一輪先停，下一輪再試
    }
    return sent;
  }

  /** 先把 cmdId 記進任務（assigned），再送指令；送失敗退回佇列 */
  private async assign(task: TaskView, robot: RobotInfo): Promise<boolean> {
    const cmdId = newCmdId();
    const moved = await this.tasks.transition(task.id, 'assigned', {
      only: ['queued'],
      patch: { robot_id: robot.id },
      progress: { cmdId, pausedBy: null, attempts: (task.progress.attempts ?? 0) + 1 },
      event: { robot: robot.code, cmdId },
    });
    if (!moved) return true; // 同時被取消或核准狀態改變：跳過這筆，不算失敗
    try {
      const [type, args] = await this.commandFor(task);
      await this.bus.send(robot, type, args, null, { taskId: task.id, cmdId });
      this.log.log(`${task.code} → ${robot.code}（${type}）`);
      return true;
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      this.log.warn(`${task.code} 派給 ${robot.code} 失敗，退回佇列：${reason}`);
      await this.tasks.transition(task.id, 'queued', {
        only: ['assigned'],
        patch: { robot_id: task.pinnedRobot ? robot.id : task.robotId },
        event: { reason },
      });
      return false;
    }
  }

  /** 目標是路徑 → patrol（全部航點）；其他 → navigate */
  private async commandFor(task: TaskView): Promise<['navigate' | 'patrol', Record<string, unknown>]> {
    const tg = task.target as Record<string, unknown>;
    if (typeof tg.pathId === 'string') {
      const p = await this.tasks.path(tg.pathId);
      return ['patrol', { points: p?.points ?? [], loops: 1 }];
    }
    const pt = await this.tasks.targetPoint(task);
    return ['navigate', { x: pt!.x, y: pt!.y, ...(pt!.yaw !== undefined && { yaw: pt!.yaw }) }];
  }

  /** 指令結果推進任務狀態。只認任務目前那一筆 cmdId（舊指令被取代的結果不算） */
  private async onResult({ data: r }: CmdResultOut) {
    if (!r.taskId) return;
    const task = await this.tasks.get(r.taskId).catch(() => null);
    if (!task || task.progress.cmdId !== r.cmdId || !OCCUPYING.includes(task.status)) return;
    const now = new Date();
    if (r.status === 'accepted') {
      await this.tasks.transition(task.id, 'running', { only: ['assigned'], patch: { started_at: now } });
    } else if (r.status === 'done') {
      // 即時完成的轉接器可能不回 accepted：先補 running
      if (task.status === 'assigned') await this.tasks.transition(task.id, 'running', { only: ['assigned'], patch: { started_at: now } });
      await this.tasks.transition(task.id, 'done', { only: ['running'], patch: { ended_at: now } });
    } else {
      const reason = r.error ? `${r.error.code}：${r.error.msg}` : r.status;
      await this.tasks.transition(task.id, 'failed', { only: ['assigned', 'running'], patch: { ended_at: now, fail_reason: reason } });
    }
  }

  private async onFleet(e: FleetEvent) {
    if (e.type === 'offline') return this.pauseRobot(e.robot, 'offline');
    if (e.type === 'online') {
      await this.resumeRobot(e.robot, 'offline');
      return this.schedule(e.robot.floor);
    }
    // state
    if (e.to === 'estop') await this.pauseRobot(e.robot, 'estop');
    if (e.from === 'estop' && e.to !== 'estop') await this.resumeRobot(e.robot, 'estop');
    if (e.to === 'idle') this.schedule(e.robot.floor);
  }

  async pauseRobot(robot: RobotInfo, reason: PauseReason) {
    for (const t of await this.tasks.byRobot(robot.id, OCCUPYING)) {
      const v = await this.tasks.transition(t.id, 'paused', { progress: { pausedBy: reason }, event: { reason, robot: robot.code } });
      if (v) this.log.log(`${t.code} 暫停（${reason}）`);
    }
  }

  async resumeRobot(robot: RobotInfo, reason: PauseReason) {
    for (const t of await this.tasks.byRobot(robot.id, ['paused'])) {
      if (t.progress.pausedBy !== reason) continue;
      const v = await this.tasks.transition(t.id, 'queued', { progress: { pausedBy: null }, event: { resumed: reason } });
      if (v) this.log.log(`${t.code} 恢復排隊（${reason} 解除）`);
    }
  }

  private async failRobot(robot: RobotInfo, reason: string) {
    for (const t of await this.tasks.byRobot(robot.id, OCCUPYING)) {
      await this.tasks.transition(t.id, 'failed', { patch: { ended_at: new Date(), fail_reason: reason }, event: { reason } });
    }
  }

  /** 機器人被停用：手上的任務退回佇列改派別台（指定該台的任務一併取消指定） */
  private async requeueRemoved(robot: RobotInfo) {
    for (const t of await this.tasks.byRobot(robot.id, ['assigned', 'running', 'paused'])) {
      if (t.status !== 'paused') await this.tasks.transition(t.id, 'paused', { progress: { pausedBy: 'offline' }, event: { reason: 'robot_disabled' } });
      await this.tasks.transition(t.id, 'queued', { patch: { robot_id: null, pinned_robot: false }, event: { reason: 'robot_disabled' } });
    }
  }
}
