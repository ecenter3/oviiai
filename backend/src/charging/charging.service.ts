import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { Subject, type Subscription } from 'rxjs';
import { CommandBus, type CmdRecord } from '../commands/command-bus.service';
import { CommandsService } from '../commands/commands.service';
import { TeleopLock } from '../commands/teleop-lock.service';
import { AppError } from '../common/errors';
import { KYSELY, type Database } from '../db/database.module';
import { DispatchService } from '../dispatch/dispatch.service';
import { TasksService } from '../dispatch/tasks.service';
import { FleetService } from '../fleet/fleet.service';
import { RobotRegistry } from '../fleet/robot-registry';
import type { RobotInfo } from '../fleet/types';
import { REDIS } from '../redis/redis.module';
import { SettingsService } from '../settings/settings.service';
import {
  type ChargerInfo,
  type ChargeSettings,
  compatible,
  manualDone,
  nearest,
  needsCharge,
  pickCharger,
  type RobotChargeView,
  shouldYield,
  waitPoint,
} from './charge-plan';

const TICK_MS = 2_000;
const LOCK = 'charge:lock';
const LOCK_TTL_MS = 10_000;
const ASSIGN = 'charge:assign';
const MANUAL = 'charge:manual';
const queueKey = (floor: string) => `charge:queue:${floor}`;
/** 前往充電樁的上限；超過視為失敗，釋放樁重新排 */
const HEADING_TIMEOUT_MS = 10 * 60_000;
/** 讓位後超過這個時間還沒離樁，強制釋放 */
const LEAVING_TIMEOUT_MS = 60_000;
const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

interface Assignment {
  robotId: string;
  chargerId: string;
  status: 'heading' | 'charging' | 'leaving';
  since: number;
  cmdId?: string;
  sessionId?: string;
  failed?: boolean;
  /** 已通知派工續做（充到 resumeAt） */
  notified?: boolean;
}

interface ManualPending {
  robotId: string;
  since: number;
  chargerId: string | null;
  startPct: number;
  sessionId: string;
}

export type ChargeMode = 'auto' | 'manual';

/** 給告警（T-21）：低電量排隊過久（二級）、需人工充電或換電池（二級，發給維修人員） */
export type ChargeAlert =
  | { type: 'charge_queue'; robot: RobotInfo; battery: number; position: number; at: number }
  | { type: 'manual_charge'; robot: RobotInfo; battery: number; chargerCode: string | null; at: number };

export interface ChargingFloorView {
  floor: string;
  chargers: { id: string; code: string; x: number; y: number; occupiedBy: { robotId: string; code: string; status: Assignment['status'] } | null }[];
  queue: { robotId: string; code: string; battery: number; position: number }[];
  manual: { robotId: string; code: string; since: number; battery: number | null }[];
}

/**
 * 充電排程（工程開發手冊 後端邏輯 §3、T-19）。
 *
 * - 觸發：電量 ≤ charge.returnAt 且未在充電；或使用者按「回充」。執行中的任務轉 paused（原因 charge）。
 * - 分配：同樓層、同品牌、未佔用的樁中選最近者。所有分配在 Redis 鎖 `charge:lock` 內進行，同一樁不會被兩台搭。
 * - 排隊：樁都滿時進 `charge:queue:{floor}`（依電量由低到高），先到樁旁等候點；電量 < 10% 且排第二以後 → 二級告警。
 * - 結束：充到 charge.resumeAt 且有同品牌在排隊 → 離樁讓位；沒人排隊則留在樁上，仍視為可接任務（派工送導航時自動離樁）。
 * - 充到 resumeAt 時通知派工，回充暫停的任務續做。
 * - 人工充電模式（charge.mode.{brand} = manual）：派到充電點、發「需人工充電或換電池」告警；
 *   人員在畫面按「完成充電」，或偵測到電量跳升（換電池），就恢復上線。
 * - 每次充電寫 charge_sessions（開始、結束電量）；樁佔用與排隊變化推 WebSocket charger.updated。
 */
@Injectable()
export class ChargingService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Charging');
  private timer?: NodeJS.Timeout;
  private subs: Subscription[] = [];
  private closing = false;
  private readonly alerted = new Set<string>();
  private lastViews = new Map<string, string>();

  readonly alerts$ = new Subject<ChargeAlert>();
  /** 樓層的充電狀態有變化（WebSocket charger.updated） */
  readonly updates$ = new Subject<ChargingFloorView>();

  constructor(
    private readonly registry: RobotRegistry,
    private readonly fleet: FleetService,
    private readonly bus: CommandBus,
    private readonly commands: CommandsService,
    private readonly lock: TeleopLock,
    private readonly dispatch: DispatchService,
    private readonly tasks: TasksService,
    private readonly settings: SettingsService,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(KYSELY) private readonly db: Database,
  ) {}

  onModuleInit() {
    // 使用者按「回充」走排程（選樁、排隊），不直接送 charge
    this.commands.setChargeHandler((robot, userId) => this.request(robot, 'user', userId));
    this.dispatch.setChargeBlocked((robot) => this.blocked(robot.id));
    this.subs = [
      this.bus.results$.subscribe(({ data }) => {
        if (data.type === 'charge' && (data.status === 'failed' || data.status === 'rejected')) {
          void this.markFailed(data.robotId, data.cmdId).catch((e) => this.log.error(String(e)));
        }
      }),
    ];
    // 背景每 2 秒；上一輪還沒跑完（拿不到鎖）就跳過這一輪
    this.timer = setInterval(
      () =>
        void (this.closing ? Promise.resolve() : this.withLock(() => this.tickLocked(), false)).catch((e) =>
          this.log.error(e instanceof Error ? e.stack : String(e)),
        ),
      TICK_MS,
    );
  }

  onModuleDestroy() {
    this.closing = true;
    clearInterval(this.timer);
    for (const s of this.subs) s.unsubscribe();
  }

  // ===== 對外 =====

  /** 回充請求（自動觸發或使用者按回充）。回傳送出的指令（前往樁或等候點）；人工模式回前往充電點的指令 */
  async request(robot: RobotInfo, source: 'auto' | 'user', userId: string | null = null): Promise<CmdRecord> {
    return this.withLock(() => this.requestLocked(robot, source, userId));
  }

  /** 人工充電完成（人員按「完成充電」，或偵測到換電池） */
  async completeManual(robotId: string, by: string): Promise<boolean> {
    return this.withLock(async () => {
      const m = await this.manual(robotId);
      if (!m) return false;
      await this.redis.hdel(MANUAL, robotId);
      const live = this.liveOf(robotId);
      await this.endSession(m.sessionId, live?.battery ?? null);
      this.alerted.delete(`manual:${robotId}`);
      this.log.log(`${live?.code ?? robotId} 人工充電完成（${by}）`);
      const robot = await this.registry.resolveId(robotId);
      if (robot) await this.dispatch.recoverPaused();
      await this.emitAll();
      return true;
    });
  }

  /** 機器人是否還在等充電：排隊中、前往樁、人工充電未完成（派工據此決定回充暫停的任務能否續做） */
  async blocked(robotId: string): Promise<boolean> {
    const a = await this.assignment(robotId);
    if (a && a.status === 'heading') return true;
    if (await this.manual(robotId)) return true;
    const r = this.registry.all().find((x) => x.id === robotId);
    return !!r && (await this.redis.zscore(queueKey(r.floor), robotId)) !== null;
  }

  async view(floor?: string): Promise<ChargingFloorView[]> {
    const floors = floor ? [floor] : [...new Set((await this.chargers()).map((c) => c.floor).concat(this.registry.all().map((r) => r.floor)))];
    return Promise.all(floors.sort().map((f) => this.floorView(f)));
  }

  async modeOf(brand: string): Promise<ChargeMode> {
    return (await this.settings.get(`charge.mode.${brand}`)) === 'manual' ? 'manual' : 'auto';
  }

  /** 執行一輪（等到拿到鎖）。背景計時器另外每 2 秒跑一次 */
  async tick(): Promise<void> {
    if (this.closing) return;
    await this.withLock(() => this.tickLocked());
  }

  // ===== 內部 =====

  private async requestLocked(robot: RobotInfo, source: 'auto' | 'user', userId: string | null): Promise<CmdRecord> {
    const s = await this.chargeSettings();
    const live = this.liveOf(robot.id);
    if (!live) throw new AppError('ROBOT_OFFLINE', `${robot.code} 離線中`);

    const existing = await this.assignment(robot.id);
    if (existing && existing.status !== 'leaving') throw new AppError('INVALID_STATE', `${robot.code} 已在回充`);
    if (await this.manual(robot.id)) throw new AppError('INVALID_STATE', `${robot.code} 正等待人工充電`);
    if ((await this.redis.zscore(queueKey(robot.floor), robot.id)) !== null) throw new AppError('INVALID_STATE', `${robot.code} 已在排隊等充電`);

    const chargers = (await this.chargers()).filter((c) => compatible(robot, c));
    if (!chargers.length) throw new AppError('INVALID_STATE', `${robot.code} 所在樓層沒有適用的充電樁`);

    await this.dispatch.pauseRobot(robot, 'charge');
    const view = this.robotView(robot);

    if ((await this.modeOf(robot.brand)) === 'manual') {
      const target = nearest(view, chargers);
      const sessionId = await this.startSession(robot.id, target?.id ?? null, 'manual', live.battery);
      const m: ManualPending = { robotId: robot.id, since: Date.now(), chargerId: target?.id ?? null, startPct: live.battery, sessionId };
      await this.redis.hset(MANUAL, robot.id, JSON.stringify(m));
      this.log.warn(`${robot.code} 需人工充電或換電池（電量 ${live.battery.toFixed(0)}%）`);
      this.alerts$.next({ type: 'manual_charge', robot, battery: live.battery, chargerCode: target?.code ?? null, at: Date.now() });
      this.alerted.add(`manual:${robot.id}`);
      const rec = await this.bus.send(robot, 'navigate', { x: target!.x, y: target!.y }, userId);
      await this.emitFloor(robot.floor);
      return rec;
    }

    const occupied = await this.occupiedChargers();
    const charger = pickCharger(view, chargers, occupied);
    if (charger) {
      const rec = await this.assign(robot, charger, userId);
      await this.emitFloor(robot.floor);
      return rec;
    }
    // 樁都滿：排隊，先到等候點
    await this.redis.zadd(queueKey(robot.floor), live.battery, robot.id);
    const position = (await this.redis.zrank(queueKey(robot.floor), robot.id)) ?? 0;
    const near = nearest(view, chargers)!;
    const wp = waitPoint(near, await this.floorSize(robot.floor), position);
    this.log.log(`${robot.code} 排隊等充電（第 ${position + 1} 位，${source}）`);
    const rec = await this.bus.send(robot, 'navigate', wp, userId);
    await this.emitFloor(robot.floor);
    return rec;
  }

  private async assign(robot: RobotInfo, c: ChargerInfo, userId: string | null): Promise<CmdRecord> {
    const a: Assignment = { robotId: robot.id, chargerId: c.id, status: 'heading', since: Date.now() };
    await this.redis.hset(ASSIGN, robot.id, JSON.stringify(a));
    await this.db.updateTable('chargers').set({ occupied_by: robot.id }).where('id', '=', c.id).execute();
    try {
      const rec = await this.bus.send(robot, 'charge', { chargerId: c.id, x: c.x, y: c.y, dock: c.robotDock }, userId);
      a.cmdId = rec.cmdId;
      await this.redis.hset(ASSIGN, robot.id, JSON.stringify(a));
      this.log.log(`${robot.code} → ${c.code} 回充`);
      return rec;
    } catch (e) {
      await this.release(robot.id, a);
      throw e;
    }
  }

  private async tickLocked(): Promise<void> {
    const s = await this.chargeSettings();
    const chargers = await this.chargers();
    const now = Date.now();

    // 1. 已分配樁的機器人：前往 → 充電中 → 讓位 → 釋放
    for (const a of await this.assignments()) {
      const robot = this.registry.all().find((r) => r.id === a.robotId);
      const live = robot && this.fleet.get(robot.code);
      const charger = chargers.find((c) => c.id === a.chargerId);
      if (!robot || !live || !charger) {
        await this.release(a.robotId, a, live?.battery ?? null);
        continue;
      }
      if (a.status === 'heading') {
        if (live.online && live.state === 'charging') {
          a.status = 'charging';
          a.since = now;
          a.sessionId = await this.startSession(robot.id, charger.id, 'auto', live.battery);
          await this.redis.hset(ASSIGN, robot.id, JSON.stringify(a));
          this.log.log(`${robot.code} 在 ${charger.code} 開始充電（${live.battery.toFixed(0)}%）`);
        } else if (a.failed || !live.online || now - a.since > HEADING_TIMEOUT_MS || ['idle', 'estop'].includes(live.state) && now - a.since > 20_000) {
          // 指令失敗、離線、逾時、或被使用者停下：釋放樁，仍需充電的話下一輪重新觸發
          this.log.warn(`${robot.code} 前往 ${charger.code} 未完成，釋放充電樁`);
          await this.release(robot.id, a);
        }
        continue;
      }
      if (live.state !== 'charging') {
        // 離開充電樁（讓位、被派任務、使用者移動）
        await this.release(robot.id, a, live.battery);
        this.log.log(`${robot.code} 離開 ${charger.code}（${live.battery.toFixed(0)}%）`);
        continue;
      }
      if (a.status === 'charging') {
        if (live.battery >= s.resumeAt && !a.notified) {
          a.notified = true;
          await this.redis.hset(ASSIGN, robot.id, JSON.stringify(a));
          await this.dispatch.recoverPaused(); // 回充暫停的任務續做
        }
        // 還要讓出幾座：排隊的同品牌台數 − 已空出或正在讓位的同品牌樁數（一台排隊只讓一座）
        const waiting = (await this.waitingFor(charger)) - (await this.vacating(charger, chargers));
        if (shouldYield(live.battery, s, waiting)) {
          a.status = 'leaving';
          a.since = now;
          await this.redis.hset(ASSIGN, robot.id, JSON.stringify(a));
          const wp = waitPoint(charger, await this.floorSize(robot.floor), 1);
          this.log.log(`${robot.code} 充到 ${live.battery.toFixed(0)}%，離開 ${charger.code} 讓位`);
          await this.bus.send(robot, 'navigate', wp, null).catch((e) => this.log.warn(`讓位指令失敗：${e}`));
        }
      } else if (a.status === 'leaving' && now - a.since > LEAVING_TIMEOUT_MS) {
        await this.release(robot.id, a, live.battery);
      }
    }

    // 2. 各樓層佇列：清掉不需要的、指派空出的樁、排隊過久告警
    const occupied = await this.occupiedChargers();
    const occupiedRobots = await this.tasks.occupiedRobots();
    for (const floor of new Set(this.registry.all().map((r) => r.floor))) {
      const ids = await this.redis.zrange(queueKey(floor), '0', '-1');
      let position = 0;
      for (const id of ids) {
        const robot = this.registry.all().find((r) => r.id === id);
        const live = robot && this.fleet.get(robot.code);
        if (!robot || !live || occupiedRobots.has(id) || live.state === 'charging') {
          // 被停用、被派了任務、或已經在充電（例如人工放上去）：移出佇列
          await this.redis.zrem(queueKey(floor), id);
          continue;
        }
        await this.redis.zadd(queueKey(floor), live.battery, id);
        const charger = pickCharger(this.robotView(robot), chargers, occupied);
        if (charger && live.online && !['estop', 'teleop'].includes(live.state)) {
          await this.redis.zrem(queueKey(floor), id);
          occupied.add(charger.id);
          await this.assign(robot, charger, null).catch((e) => this.log.warn(`${robot.code} 指派充電樁失敗：${e}`));
          continue;
        }
        if (position >= 1 && live.battery < 10 && !this.alerted.has(`queue:${id}`)) {
          this.alerted.add(`queue:${id}`);
          this.log.warn(`${robot.code} 電量 ${live.battery.toFixed(0)}% 仍在排隊（第 ${position + 1} 位）`);
          this.alerts$.next({ type: 'charge_queue', robot, battery: live.battery, position: position + 1, at: now });
        }
        position++;
      }
    }

    // 3. 人工充電：偵測換電池（電量跳升）
    for (const m of await this.manuals()) {
      const live = this.liveOf(m.robotId);
      if (live && manualDone(m.startPct, live.battery, s)) {
        await this.redis.hdel(MANUAL, m.robotId);
        await this.endSession(m.sessionId, live.battery);
        this.alerted.delete(`manual:${m.robotId}`);
        this.log.log(`${live.code} 偵測到換電池／充電完成（${m.startPct.toFixed(0)}% → ${live.battery.toFixed(0)}%）`);
        await this.dispatch.recoverPaused();
      }
    }

    // 4. 觸發回充：電量 ≤ returnAt 且還沒在任何充電流程中
    const assigned = new Set((await this.assignments()).map((a) => a.robotId));
    const manualIds = new Set((await this.manuals()).map((m) => m.robotId));
    // 同一輪多台同時低電量：電量低的先拿到樁（與排隊順序一致）
    const byBattery = [...this.registry.all()].sort((a, b) => (this.fleet.get(a.code)?.battery ?? 100) - (this.fleet.get(b.code)?.battery ?? 100));
    for (const robot of byBattery) {
      if (assigned.has(robot.id) || manualIds.has(robot.id)) continue;
      if ((await this.redis.zscore(queueKey(robot.floor), robot.id)) !== null) continue;
      const view = this.robotView(robot);
      view.teleopLocked = !!(await this.lock.holder(robot.code));
      if (!this.fleet.get(robot.code) || !needsCharge(view, s)) {
        this.alerted.delete(`queue:${robot.id}`);
        continue;
      }
      if (!chargers.some((c) => compatible(robot, c))) continue;
      this.log.log(`${robot.code} 電量 ${view.battery.toFixed(0)}% ≤ ${s.returnAt}%，自動回充`);
      await this.requestLocked(robot, 'auto', null).catch((e) => this.log.warn(`${robot.code} 回充失敗：${e instanceof Error ? e.message : e}`));
    }

    await this.emitAll();
  }

  private async markFailed(robotId: string, cmdId: string) {
    const a = await this.assignment(robotId);
    if (a && a.cmdId === cmdId) {
      a.failed = true;
      await this.redis.hset(ASSIGN, robotId, JSON.stringify(a));
    }
  }

  private async release(robotId: string, a: Assignment, endPct: number | null = null) {
    await this.redis.hdel(ASSIGN, robotId);
    await this.db
      .updateTable('chargers')
      .set({ occupied_by: null })
      .where('id', '=', a.chargerId)
      .where('occupied_by', '=', robotId)
      .execute();
    if (a.sessionId) await this.endSession(a.sessionId, endPct);
  }

  /** 同樓層同品牌的樁中，已空出或正在讓位（leaving）的座數 */
  private async vacating(c: ChargerInfo, chargers: ChargerInfo[]): Promise<number> {
    const assignments = await this.assignments();
    return chargers.filter((x) => x.enabled && x.floor === c.floor && x.brand === c.brand).filter((x) => {
      const a = assignments.find((y) => y.chargerId === x.id);
      return !a || a.status === 'leaving';
    }).length;
  }

  /** 同樓層同品牌、在排隊的台數 */
  private async waitingFor(c: ChargerInfo): Promise<number> {
    const ids = await this.redis.zrange(queueKey(c.floor), '0', '-1');
    return ids.filter((id) => this.registry.all().find((r) => r.id === id)?.brand === c.brand).length;
  }

  private async startSession(robotId: string, chargerId: string | null, mode: ChargeMode, pct: number): Promise<string> {
    const r = await this.db
      .insertInto('charge_sessions')
      .values({ robot_id: robotId, charger_id: chargerId, mode, start_pct: pct })
      .returning('id')
      .executeTakeFirstOrThrow();
    return r.id;
  }

  private async endSession(id: string, pct: number | null) {
    await this.db.updateTable('charge_sessions').set({ ended_at: new Date(), end_pct: pct }).where('id', '=', id).where('ended_at', 'is', null).execute();
  }

  private async chargeSettings(): Promise<ChargeSettings> {
    return {
      returnAt: await this.settings.getNumber('charge.returnAt', 25),
      resumeAt: await this.settings.getNumber('charge.resumeAt', 90),
    };
  }

  private async chargers(): Promise<ChargerInfo[]> {
    const rows = await this.db.selectFrom('chargers').select(['id', 'code', 'floor_id', 'x', 'y', 'brand', 'enabled', 'robot_dock']).execute();
    return rows.map((c) => ({ id: c.id, code: c.code, floor: c.floor_id, x: c.x, y: c.y, brand: c.brand, enabled: c.enabled, robotDock: c.robot_dock }));
  }

  private async floorSize(floor: string) {
    const f = await this.db.selectFrom('floors').select(['width_m', 'height_m']).where('id', '=', floor).executeTakeFirst();
    return { w: f?.width_m ? Number(f.width_m) : null, h: f?.height_m ? Number(f.height_m) : null };
  }

  private async assignments(): Promise<Assignment[]> {
    return Object.values(await this.redis.hgetall(ASSIGN)).map((v) => JSON.parse(v) as Assignment);
  }

  private async assignment(robotId: string): Promise<Assignment | null> {
    const v = await this.redis.hget(ASSIGN, robotId);
    return v ? (JSON.parse(v) as Assignment) : null;
  }

  private async manuals(): Promise<ManualPending[]> {
    return Object.values(await this.redis.hgetall(MANUAL)).map((v) => JSON.parse(v) as ManualPending);
  }

  private async manual(robotId: string): Promise<ManualPending | null> {
    const v = await this.redis.hget(MANUAL, robotId);
    return v ? (JSON.parse(v) as ManualPending) : null;
  }

  private async occupiedChargers(): Promise<Set<string>> {
    return new Set((await this.assignments()).map((a) => a.chargerId));
  }

  private liveOf(robotId: string) {
    const r = this.registry.all().find((x) => x.id === robotId);
    return r ? this.fleet.get(r.code) : undefined;
  }

  private robotView(robot: RobotInfo): RobotChargeView {
    const live = this.fleet.get(robot.code);
    return {
      robotId: robot.id,
      code: robot.code,
      floor: robot.floor,
      brand: robot.brand,
      online: !!live?.online,
      state: live?.state ?? 'offline',
      battery: live?.battery ?? 0,
      x: live?.x ?? 0,
      y: live?.y ?? 0,
      teleopLocked: false,
    };
  }

  private async floorView(floor: string): Promise<ChargingFloorView> {
    const assignments = await this.assignments();
    const chargers = (await this.chargers()).filter((c) => c.floor === floor).sort((a, b) => a.code.localeCompare(b.code));
    const codeOf = (id: string) => this.registry.all().find((r) => r.id === id)?.code ?? id;
    const queueIds = await this.redis.zrange(queueKey(floor), '0', '-1');
    const manuals = (await this.manuals()).filter((m) => this.registry.all().find((r) => r.id === m.robotId)?.floor === floor);
    return {
      floor,
      chargers: chargers.map((c) => {
        const a = assignments.find((x) => x.chargerId === c.id);
        return { id: c.id, code: c.code, x: c.x, y: c.y, occupiedBy: a ? { robotId: a.robotId, code: codeOf(a.robotId), status: a.status } : null };
      }),
      queue: queueIds.map((id, i) => ({ robotId: id, code: codeOf(id), battery: this.liveOf(id)?.battery ?? 0, position: i + 1 })),
      manual: manuals.map((m) => ({ robotId: m.robotId, code: codeOf(m.robotId), since: m.since, battery: this.liveOf(m.robotId)?.battery ?? null })),
    };
  }

  private async emitFloor(floor: string) {
    const v = await this.floorView(floor);
    const key = JSON.stringify({ ...v, queue: v.queue.map((q) => [q.robotId, q.position]), manual: v.manual.map((m) => m.robotId) });
    if (this.lastViews.get(floor) === key) return;
    this.lastViews.set(floor, key);
    this.updates$.next(v);
  }

  private async emitAll() {
    for (const f of new Set(this.registry.all().map((r) => r.floor))) await this.emitFloor(f);
  }

  /** 所有分配在同一把鎖內：同一樁不會被兩台搭 */
  private async withLock<T>(fn: () => Promise<T>, wait = true): Promise<T> {
    const token = randomUUID();
    const deadline = Date.now() + 5_000;
    for (;;) {
      if ((await this.redis.set(LOCK, token, 'PX', LOCK_TTL_MS, 'NX')) === 'OK') break;
      if (!wait) return undefined as T;
      if (Date.now() > deadline) throw new AppError('INVALID_STATE', '充電排程忙碌中，請稍後再試');
      await new Promise((r) => setTimeout(r, 50));
    }
    try {
      return await fn();
    } finally {
      await this.redis.eval(RELEASE, 1, LOCK, token);
    }
  }
}

