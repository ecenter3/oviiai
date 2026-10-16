import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { Subject, type Subscription } from 'rxjs';
import { CommandBus, type CmdResultOut, newCmdId } from '../commands/command-bus.service';
import { CommandsService } from '../commands/commands.service';
import { TeleopLock } from '../commands/teleop-lock.service';
import { KYSELY, type Database } from '../db/database.module';
import { FleetService } from '../fleet/fleet.service';
import { OpLogService } from '../oplog/oplog.service';
import { RobotRegistry } from '../fleet/robot-registry';
import type { FleetEvent, RobotInfo } from '../fleet/types';
import { REDIS } from '../redis/redis.module';
import { SettingsService } from '../settings/settings.service';
import { type Candidate, pickPreemptVictim, planRound, type QueuedTask } from './pick-robot';
import { approvalOn, ENDED, OCCUPYING, taipeiDate } from './task-state';
import { type PauseReason, TasksService, type TaskView } from './tasks.service';

/** 每 10 秒保底掃一次（後端邏輯 §2：觸發時機） */
const SWEEP_MS = 10_000;
const LOCK_TTL_MS = 10_000;
/** 系統自動執行的操作，操作日誌的操作者 */
export const SYSTEM_USER = '系統';

/** 續做時保留給原本那台的時間 */
export const RESERVE_MS = 30_000;
const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

/** 給告警（T-21）：P1 插隊發生（三級）、P1 無可用機器人（一級）—後端邏輯 §5 系統告警規則 */
export type DispatchAlert =
  | { type: 'p1_preempt'; task: TaskView; victim: TaskView; robot: RobotInfo; at: number }
  | { type: 'p1_no_robot'; task: TaskView; at: number };

export interface DispatchMode {
  /** 目前實際是否審批（設定開啟且未過期） */
  approval: boolean;
  approvalSetting: boolean;
  approvalUntil: string | null;
  p1Preempt: boolean;
  /** 待審批筆數（關閉審批前提示：會立即派出幾筆） */
  pending: number;
}

/**
 * 派工（工程開發手冊 後端邏輯 §2、T-16／T-17／T-18）。
 *
 * 觸發：任務進入 queued、機器人變 idle 或恢復上線、任務結束、每 10 秒保底。
 * 同樓層以 Redis 鎖 `dispatch:{floor}` 串行處理；「已有 assigned／running 任務的機器人不選」，
 * 同時建單也不會把同一台派兩次。
 *
 * 任務與指令：派出時先把 cmdId 寫進任務（assigned）再送 navigate／patrol，
 * 轉接器 accepted → running、done → done、rejected／failed／逾時 → failed。
 *
 * 暫停與續做：離線、急停、遙控接管、P1 插隊 → paused（記原因）；原因解除 → queued，
 * 保留給原本那台 30 秒。保底掃描會檢查每筆暫停的原因是否還成立，事件漏接也會自己恢復。
 * 使用者對執行中的機器人下「停止」或「導航」→ 視為人工接手，任務 failed。
 *
 * P1 插隊（T-17）：沒有空閒機器人且 dispatch.p1Preempt 開啟 → 中斷離目標最近、執行非 P1、電量足夠的那台；
 * P1 結束後被中斷的任務回佇列並優先派回同一台；仍沒有車 → P1 留在佇列最前並發一級告警。
 *
 * 審批到期（T-18）：審批關閉（設定關閉或過了 approvalUntil）時，待審批的任務自動轉入佇列。
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

  readonly alerts$ = new Subject<DispatchAlert>();

  constructor(
    private readonly tasks: TasksService,
    private readonly fleet: FleetService,
    private readonly registry: RobotRegistry,
    private readonly bus: CommandBus,
    private readonly commands: CommandsService,
    private readonly lock: TeleopLock,
    private readonly settings: SettingsService,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(KYSELY) private readonly db: Database,
    private readonly oplog: OpLogService,
  ) {}

  onModuleInit() {
    const safe = (p: Promise<unknown>) => void p.catch((e) => this.log.error(e instanceof Error ? e.stack : String(e)));
    this.subs = [
      this.tasks.changes$.subscribe((t) => {
        if (t.status === 'queued') this.schedule(t.floorId);
        if (ENDED.includes(t.status)) {
          // 任務結束，那台機器人空出來了；若是 P1，被它中斷的任務回佇列
          this.schedule(t.floorId);
          if (t.priority === 'P1') safe(this.resumePreempted(t.id));
        }
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
      // 遙控中按急停：鎖被釋放，暫停原因改記急停（解除急停才續做）
      this.lock.revoked$.subscribe((m) => {
        if (m.reason === 'estop') safe(this.relabelPause(m.robotId, 'teleop', 'estop'));
      }),
      this.registry.removed$.subscribe((r) => safe(this.requeueRemoved(r))),
    ];
    this.commands.setResumeOnRelease(async (robot) => !(await this.hasPaused(robot, 'teleop')));
    this.sweeper = setInterval(() => safe(this.sweep()), SWEEP_MS);
  }

  onModuleDestroy() {
    this.closing = true;
    clearInterval(this.sweeper);
    for (const s of this.subs) s.unsubscribe();
  }

  /** 保底掃描：暫停原因檢查、審批到期、各樓層補一輪 */
  async sweep(now = Date.now()): Promise<void> {
    await this.recoverPaused();
    await this.closeApprovalIfExpired(new Date(now));
    for (const f of new Set(this.registry.all().map((r) => r.floor))) this.schedule(f);
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
    const resumeAt = await this.settings.getNumber('charge.resumeAt', 90);
    const occupied = await this.tasks.occupiedRobots();
    const robots: Candidate[] = [];
    for (const info of this.registry.all().filter((r) => r.floor === floor)) {
      const live = this.fleet.get(info.code);
      if (!live) continue;
      const occ = occupied.get(info.id);
      robots.push({
        robotId: info.id,
        code: info.code,
        floor: info.floor,
        online: live.online,
        enabled: true,
        state: live.state,
        battery: live.battery,
        charging: live.charging,
        x: live.x,
        y: live.y,
        caps: info.caps,
        teleopLocked: !!(await this.lock.holder(info.code)),
        // 在充電佇列、前往充電樁、等人工充電：不可接單（使用者在高電量時按回充也一樣）
        busy: !!occ || (await this.chargeBlocked(info)),
        taskPriority: occ?.priority ?? null,
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
        reservedUntil: t.progress.reservedUntil ?? null,
      });
    }

    let sent = 0;
    const assigned = new Set<string>();
    for (const [qt, cand] of planRound(plan, robots, { minAccept, resumeAt })) {
      const task = queued.find((t) => t.id === qt.id)!;
      if (!(await this.assign(task, this.registry.get(cand.code)!))) return sent; // MQTT 斷線：下一輪再試
      sent++;
      assigned.add(task.id);
      const r = robots.find((x) => x.robotId === cand.robotId)!;
      r.busy = true;
      r.taskPriority = task.priority;
    }

    // P1 插隊：一般選車沒派到的 P1
    const p1s = plan.filter((t) => t.priority === 'P1' && !assigned.has(t.id) && !t.pinnedRobot);
    if (p1s.length) {
      const preempt = (await this.settings.get('dispatch.p1Preempt')) !== false;
      for (const p1 of p1s) {
        const task = queued.find((t) => t.id === p1.id)!;
        const victim = preempt ? pickPreemptVictim(p1, robots, { minAccept, resumeAt }) : null;
        if (victim && (await this.preempt(task, victim))) {
          sent++;
          victim.taskPriority = 'P1';
        } else {
          await this.noRobot(task);
        }
      }
    }
    return sent;
  }

  /** 先把 cmdId 記進任務（assigned），再送指令；送失敗退回佇列 */
  private async assign(task: TaskView, robot: RobotInfo): Promise<boolean> {
    const cmdId = newCmdId();
    const moved = await this.tasks.transition(task.id, 'assigned', {
      only: ['queued'],
      patch: { robot_id: robot.id },
      progress: { cmdId, pausedBy: null, reservedUntil: null, noRobotAt: null, attempts: (task.progress.attempts ?? 0) + 1 },
      event: { robot: robot.code, cmdId },
    });
    if (!moved) return true; // 同時被取消：跳過這筆，不算失敗
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

  /**
   * P1 插隊：被選中那台的任務 → paused（preempted_by = P1），送 stop，再派 P1 給它（後端邏輯 §2）。
   * 被中斷的任務保留 robot_id，P1 結束後優先派回同一台。
   */
  private async preempt(p1: TaskView, victim: Candidate): Promise<boolean> {
    const robot = this.registry.get(victim.code);
    const occ = (await this.tasks.byRobot(victim.robotId, OCCUPYING))[0];
    if (!robot || !occ) return false;
    const paused = await this.tasks.transition(occ.id, 'paused', {
      only: [...OCCUPYING],
      patch: { preempted_by: p1.id },
      progress: { pausedBy: 'preempt' },
      event: { reason: 'preempt', by: p1.code, robot: robot.code },
    });
    if (!paused) return false;
    this.log.warn(`P1 插隊：${p1.code} 中斷 ${occ.code}（${robot.code}）`);
    await this.bus.send(robot, 'stop', {}, null).catch(() => undefined);
    const ok = await this.assign(p1, robot);
    if (ok) this.alerts$.next({ type: 'p1_preempt', task: p1, victim: paused, robot, at: Date.now() });
    return ok;
  }

  /** P1 沒有可用機器人：留在佇列（排序本來就在最前），告警只發一次 */
  private async noRobot(p1: TaskView) {
    if (p1.progress.noRobotAt) return;
    const v = await this.tasks.patchProgress(p1.id, { noRobotAt: Date.now() }, 'queued');
    if (!v) return;
    this.log.warn(`P1 ${p1.code} 無可用機器人`);
    await this.tasks.event(this.db, p1.id, 'no_robot', null);
    this.alerts$.next({ type: 'p1_no_robot', task: v, at: Date.now() });
  }

  /** P1 結束（完成、失敗、取消）：被它中斷的任務回佇列，保留給原本那台 */
  private async resumePreempted(p1Id: string) {
    for (const t of await this.tasks.preemptedBy(p1Id)) {
      const v = await this.tasks.transition(t.id, 'queued', {
        only: ['paused'],
        progress: { pausedBy: null, reservedUntil: Date.now() + RESERVE_MS },
        event: { resumed: 'preempt' },
      });
      if (v) this.log.log(`${t.code} 恢復排隊（P1 結束）`);
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
    if (e.to === 'estop') await this.pauseRobot(e.robot, 'estop');
    if (e.from === 'estop' && e.to !== 'estop') await this.resumeRobot(e.robot, 'estop');
    if (e.to === 'idle' || e.to === 'paused') this.schedule(e.robot.floor);
  }

  async pauseRobot(robot: RobotInfo, reason: PauseReason) {
    for (const t of await this.tasks.byRobot(robot.id, OCCUPYING)) {
      const v = await this.tasks.transition(t.id, 'paused', { progress: { pausedBy: reason }, event: { reason, robot: robot.code } });
      if (v) this.log.log(`${t.code} 暫停（${reason}）`);
    }
  }

  /** 暫停原因解除 → 回佇列，保留給原本那台 30 秒 */
  async resumeRobot(robot: RobotInfo, reason: PauseReason) {
    for (const t of await this.tasks.byRobot(robot.id, ['paused'])) {
      if (t.progress.pausedBy !== reason) continue;
      await this.resume(t, reason);
    }
  }

  private async resume(t: TaskView, reason: PauseReason) {
    const v = await this.tasks.transition(t.id, 'queued', {
      only: ['paused'],
      progress: { pausedBy: null, reservedUntil: Date.now() + RESERVE_MS },
      event: { resumed: reason },
    });
    if (v) this.log.log(`${t.code} 恢復排隊（${reason} 解除）`);
  }

  /** 充電排程註冊：機器人是否還在等充電（排隊、前往、人工充電未完成）；預設不擋 */
  private chargeBlocked: (robot: RobotInfo) => Promise<boolean> = async () => false;
  setChargeBlocked(fn: (robot: RobotInfo) => Promise<boolean>) {
    this.chargeBlocked = fn;
  }

  private async hasPaused(robot: RobotInfo, reason: PauseReason): Promise<boolean> {
    return (await this.tasks.byRobot(robot.id, ['paused'])).some((t) => t.progress.pausedBy === reason);
  }

  private async relabelPause(robotId: string, from: PauseReason, to: PauseReason) {
    for (const t of await this.tasks.byRobot(robotId, ['paused'])) {
      if (t.progress.pausedBy === from) await this.tasks.patchProgress(t.id, { pausedBy: to }, 'paused');
    }
  }

  /**
   * 保底：檢查每筆暫停的原因是否還成立（PR #6 審查第 1 點）。
   * 遙控鎖到期（瀏覽器關掉）、強制接管後到期、遙控中按急停等，事件不完整也能自己恢復。
   * 回充（charge）：電量充到 resumeAt 且不在等人工充電 → 續做（T-19）。
   */
  async recoverPaused(): Promise<void> {
    const resumeAt = await this.settings.getNumber('charge.resumeAt', 90);
    for (const t of await this.tasks.paused()) {
      const robot = t.robotId ? await this.registry.resolveId(t.robotId) : undefined;
      const live = robot ? this.fleet.get(robot.code) : undefined;
      let cleared = false;
      switch (t.progress.pausedBy) {
        case 'teleop':
          cleared = !!robot && !(await this.lock.holder(robot.code));
          break;
        case 'estop':
          cleared = !!live && live.online && live.state !== 'estop';
          break;
        case 'offline':
          cleared = !!live?.online;
          break;
        case 'charge':
          cleared = !!live?.online && live.battery >= resumeAt && !(robot && (await this.chargeBlocked(robot)));
          break;
        case 'preempt': {
          const p1 = t.preemptedBy ? await this.tasks.get(t.preemptedBy).catch(() => null) : null;
          cleared = !p1 || ENDED.includes(p1.status);
          break;
        }
        default:
          continue;
      }
      if (cleared) await this.resume(t, t.progress.pausedBy!);
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
      await this.tasks.transition(t.id, 'queued', {
        patch: { robot_id: null, pinned_robot: false },
        progress: { pausedBy: null, reservedUntil: null },
        event: { reason: 'robot_disabled' },
      });
    }
  }

  // ===== 審批（T-18） =====

  async mode(now = new Date()): Promise<DispatchMode> {
    const approvalSetting = (await this.settings.get('dispatch.approval')) === true;
    const approvalUntil = ((await this.settings.get('dispatch.approvalUntil')) as string | undefined) ?? null;
    return {
      approval: approvalOn({ approval: approvalSetting, approvalUntil }, now),
      approvalSetting,
      approvalUntil,
      p1Preempt: (await this.settings.get('dispatch.p1Preempt')) !== false,
      pending: (await this.tasks.pendingApproval()).length,
    };
  }

  /**
   * 審批到期自動關閉：過了 approvalUntil（台北日期）就把 dispatch.approval 設為 false；
   * 審批關閉時（到期或手動關閉），待審批的任務自動轉入佇列（原型：關閉後改為自動派工）。
   */
  async closeApprovalIfExpired(now = new Date()): Promise<number> {
    const m = await this.mode(now);
    if (m.approvalSetting && !m.approval && m.approvalUntil && taipeiDate(now) > m.approvalUntil) {
      await this.db
        .updateTable('settings')
        .set({ value: 'false', updated_by: null, updated_at: now })
        .where('key', '=', 'dispatch.approval')
        .execute();
      this.settings.invalidate();
      this.log.warn(`審批期已過（${m.approvalUntil}），自動關閉審批`);
      // 改變全站派工行為：寫操作日誌，事後查得到「審批為什麼關了」（PR #7 審查第 2 點）
      await this.oplog.write({
        userId: null,
        username: SYSTEM_USER,
        action: 'settings.update',
        target: 'dispatch.approval',
        detail: { ok: true, from: true, to: false, reason: `審批期限 ${m.approvalUntil} 已過，自動關閉` },
      });
    }
    if (m.approval) return 0;
    let n = 0;
    for (const t of await this.tasks.pendingApproval()) {
      const v = await this.tasks.transition(t.id, 'queued', {
        only: ['pending_approval'],
        event: { auto: true, reason: m.approvalSetting ? '審批期已過，自動轉入佇列' : '審批已關閉，自動轉入佇列' },
      });
      if (v) n++;
    }
    if (n) this.log.log(`審批關閉：${n} 筆待審批任務自動轉入佇列`);
    return n;
  }
}
