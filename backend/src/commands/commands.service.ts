import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { type Teleop, topics } from '@oviiai/contracts';
import { Subject, type Subscription } from 'rxjs';
import { z } from 'zod';
import type { Principal } from '../auth/principal';
import { AppError } from '../common/errors';
import { FleetService } from '../fleet/fleet.service';
import { RobotRegistry } from '../fleet/robot-registry';
import type { RobotInfo } from '../fleet/types';
import { MqttService } from '../mqtt/mqtt.service';
import { CommandBus, type CmdRecord } from './command-bus.service';
import { ALWAYS_ALLOWED, MOTION, USER_COMMANDS, type UserCommandType } from './command-spec';
import { TELEOP_TTL_SEC, TeleopLock } from './teleop-lock.service';

/** 遙控速度上限（安全網；實際上限由轉接器依參數「導航速度」限制） */
export const TELEOP_MAX = { v: 2, wz: 3 };

const TeleopIn = z.object({
  robotId: z.string().uuid(),
  lockId: z.string().min(1).max(64),
  vx: z.number().min(-TELEOP_MAX.v).max(TELEOP_MAX.v),
  vy: z.number().min(-TELEOP_MAX.v).max(TELEOP_MAX.v),
  wz: z.number().min(-TELEOP_MAX.wz).max(TELEOP_MAX.wz),
});

export type TeleopResult = 'ok' | 'not_holder' | 'not_found' | 'offline' | 'forbidden' | 'estop';

@Injectable()
export class CommandsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Commands');
  private sub?: Subscription;

  /** 使用者對機器人下了指令（派工據此暫停或中止該台的任務） */
  readonly issued$ = new Subject<{ robot: RobotInfo; type: UserCommandType; userId: string }>();
  /** 遙控接管／歸還（接管時任務暫停，歸還後繼續；系統規格書 §4.3） */
  readonly teleop$ = new Subject<{ robot: RobotInfo; acquired: boolean; userId: string }>();

  /**
   * 歸還遙控時要不要送 resume。派工註冊：機器人有「因遙控暫停」的平台任務時不送，
   * 由派工重新送 navigate／patrol 接續（PR #6 審查第 2 點：真機 resume 會接續舊導航，
   * 同時任務又回佇列，可能被派給另一台）。
   */
  private resumeOnRelease: (robot: RobotInfo) => Promise<boolean> = async () => true;
  setResumeOnRelease(fn: (robot: RobotInfo) => Promise<boolean>) {
    this.resumeOnRelease = fn;
  }

  constructor(
    private readonly bus: CommandBus,
    private readonly lock: TeleopLock,
    private readonly registry: RobotRegistry,
    private readonly fleet: FleetService,
    private readonly mqtt: MqttService,
  ) {}

  /** 機器人自己回報急停（實體急停按鈕）：釋放遙控鎖並通知持有人（PR #4 審查第 1 點） */
  onModuleInit() {
    this.sub = this.fleet.events$.subscribe((e) => {
      if (e.type === 'state' && e.to === 'estop') {
        void this.releaseOnEstop(e.robot, '機器人急停').catch((err) => this.log.error(String(err)));
      }
    });
  }

  onModuleDestroy() {
    this.sub?.unsubscribe();
  }

  async robot(id: string): Promise<RobotInfo> {
    const r = await this.registry.resolveId(id);
    if (!r) throw new AppError('NOT_FOUND', '找不到機器人或已停用');
    return r;
  }

  /** POST /robots/:id/commands：檢查權限、能力、狀態、遙控鎖後送出 */
  async issue(robotId: string, type: UserCommandType, rawArgs: unknown, actor: Principal): Promise<CmdRecord> {
    const spec = USER_COMMANDS[type];
    if (!actor.perms.includes(spec.perm)) {
      throw new AppError('FORBIDDEN', '沒有權限執行此指令', { required: [spec.perm], mode: 'all' });
    }
    const parsed = spec.args.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      const fields: Record<string, string> = {};
      for (const i of parsed.error.issues) fields[['args', ...i.path].join('.')] = i.message;
      throw new AppError('VALIDATION_FAILED', '指令參數不合法', { fields });
    }
    const robot = await this.robot(robotId);
    if ('cap' in spec && !robot.caps.includes(spec.cap)) {
      throw new AppError('INVALID_STATE', `${robot.code} 不支援此功能`, { cap: spec.cap });
    }

    // 解除急停：別人正持有遙控鎖時不行，避免遙控中的機器人被第三人解除後立刻動起來（PR #4 審查第 2 點）
    if (type === 'estop_release') {
      const h = await this.lock.holder(robot.code);
      if (h && h.userId !== actor.sub) {
        throw new AppError('TELEOP_LOCKED', `${robot.code} 正由 ${h.username} 遙控中，無法解除急停`, { holder: h.username });
      }
    }
    if (!ALWAYS_ALLOWED.has(type)) {
      const live = this.fleet.get(robot.code);
      if (!live?.online) throw new AppError('ROBOT_OFFLINE', `${robot.code} 離線中`);
      if (live.state === 'estop' && MOTION.has(type)) throw new AppError('ROBOT_ESTOP', `${robot.code} 急停中，請先解除`);
      if (MOTION.has(type)) {
        const h = await this.lock.holder(robot.code);
        if (h && h.userId !== actor.sub) {
          throw new AppError('TELEOP_LOCKED', `${robot.code} 正由 ${h.username} 遙控中`, { holder: h.username });
        }
      }
    }
    const rec = await this.bus.send(robot, type, parsed.data as Record<string, unknown>, actor.sub);
    // 急停：先送出指令（最優先），再釋放遙控鎖，讓遙控端立刻停送
    if (type === 'estop') await this.releaseOnEstop(robot, actor.username);
    this.issued$.next({ robot, type, userId: actor.sub });
    return rec;
  }

  private async releaseOnEstop(robot: RobotInfo, by: string) {
    const prev = await this.lock.forceRelease(robot.code);
    if (!prev) return;
    this.log.warn(`${robot.code} 急停，釋放 ${prev.username} 的遙控鎖`);
    this.lock.revoked$.next({ code: robot.code, robotId: robot.id, floor: robot.floor, previous: prev, by, reason: 'estop' });
  }

  /**
   * 取得遙控鎖。同一人重複取得回同一把鎖（重新整理頁面不會卡住自己）；
   * 別人持有回 409，系統管理員帶 force 可強制接管。取得後送 pause 讓自動任務暫停。
   */
  async acquire(robotId: string, actor: Principal, force: boolean) {
    const robot = await this.robot(robotId);
    const live = this.fleet.get(robot.code);
    if (!live?.online) throw new AppError('ROBOT_OFFLINE', `${robot.code} 離線中`);
    if (live.state === 'estop') throw new AppError('ROBOT_ESTOP', `${robot.code} 急停中，請先解除`);

    const cur = await this.lock.holder(robot.code);
    if (cur?.userId === actor.sub) {
      await this.lock.renew(robot.code, cur.lockId, actor.sub);
      return { lockId: cur.lockId, ttlSec: TELEOP_TTL_SEC };
    }
    let holder = cur ? undefined : await this.lock.tryAcquire(robot.code, actor.sub, actor.username);
    if (!holder) {
      const other = await this.lock.holder(robot.code);
      if (!force || !actor.isSystem) {
        throw new AppError('TELEOP_LOCKED', `${robot.code} 正由 ${other?.username ?? '其他人'} 遙控中`, {
          holder: other?.username,
          ttlSec: await this.lock.ttlSec(robot.code),
          canForce: actor.isSystem,
        });
      }
      const t = await this.lock.takeOver(robot.code, actor.sub, actor.username);
      holder = t.holder;
      if (t.previous) {
        this.lock.revoked$.next({
          code: robot.code,
          robotId: robot.id,
          floor: robot.floor,
          previous: t.previous,
          by: actor.username,
          reason: 'takeover',
        });
      }
    }
    await this.bus.send(robot, 'pause', {}, actor.sub);
    this.teleop$.next({ robot, acquired: true, userId: actor.sub });
    return { lockId: holder.lockId, ttlSec: TELEOP_TTL_SEC };
  }

  /** 釋放遙控鎖並送 resume 讓任務繼續。不是持有人回 409；本來就沒鎖視為成功 */
  async release(robotId: string, actor: Principal): Promise<void> {
    const robot = await this.robot(robotId);
    const cur = await this.lock.holder(robot.code);
    if (!cur) return;
    if (cur.userId !== actor.sub) {
      throw new AppError('TELEOP_LOCKED', `${robot.code} 正由 ${cur.username} 遙控中`, { holder: cur.username });
    }
    await this.lock.release(robot.code, cur);
    if (this.fleet.get(robot.code)?.online && (await this.resumeOnRelease(robot))) {
      await this.bus.send(robot, 'resume', {}, actor.sub);
    }
    this.teleop$.next({ robot, acquired: false, userId: actor.sub });
  }

  /** WebSocket teleop.cmd（每 100 ms）：驗鎖、續期、轉發到 MQTT。不查資料庫 */
  async teleop(user: Pick<Principal, 'sub' | 'perms'>, raw: unknown): Promise<TeleopResult> {
    if (!user.perms.includes('op.remote')) return 'forbidden';
    const msg = TeleopIn.safeParse(raw);
    if (!msg.success) return 'not_holder';
    const robot = await this.registry.resolveId(msg.data.robotId);
    if (!robot) return 'not_found';
    // 急停中一律不轉發（PR #4 審查第 1 點）；轉接器那一層也會擋
    if (this.fleet.get(robot.code)?.state === 'estop') return 'estop';
    if (!(await this.lock.renew(robot.code, msg.data.lockId, user.sub))) return 'not_holder';
    if (!this.mqtt.connected) return 'offline';
    const out: Teleop = { lockId: msg.data.lockId, vx: msg.data.vx, vy: msg.data.vy, wz: msg.data.wz, ts: Date.now() };
    await this.mqtt.publish(topics.teleop(robot.code), JSON.stringify(out), 0);
    return 'ok';
  }
}

