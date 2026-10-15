import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AdapterStatus, RobotOnline, Telemetry, topics } from '@oviiai/contracts';
import type Redis from 'ioredis';
import { Subject } from 'rxjs';
import { KYSELY, type Database } from '../db/database.module';
import { MqttService } from '../mqtt/mqtt.service';
import { REDIS } from '../redis/redis.module';
import { SettingsService } from '../settings/settings.service';
import { RobotRegistry } from './robot-registry';
import { TelemetryWriter } from './telemetry-writer';
import type { FleetEvent, LiveState, OfflineReason, RobotInfo } from './types';

/** WebSocket 每台每秒最多 2 則（後端邏輯 §1：節流 500 ms） */
export const WS_THROTTLE_MS = 500;
const TICK_MS = 1_000;
/** 機器人時鐘偏差超過 5 分鐘就改用伺服器時間入庫 */
const MAX_CLOCK_SKEW_MS = 5 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface WsOut {
  event: 'robot.state' | 'robot.online';
  floor: string;
  data: unknown;
}

export const redisKey = (code: string) => `robot:${code}`;

/**
 * 機器人即時狀態（工程開發手冊 後端邏輯 §1、T-10）。
 * MQTT 遙測 → zod 驗證 → Redis `robot:{code}`＋每秒一筆批次入 telemetry；
 * 狀態改變寫 robot_state_log；超過 robot.offlineSec 沒遙測、轉接器回報離線或轉接器斷線 → 離線。
 */
@Injectable()
export class FleetService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Fleet');
  private readonly live = new Map<string, LiveState>();
  private readonly throttle = new Map<string, { last: number; timer?: NodeJS.Timeout }>();
  private readonly warned = new Set<string>();
  private tick?: NodeJS.Timeout;
  private startedAt = Date.now();

  /** 給 WebSocket gateway */
  readonly out$ = new Subject<WsOut>();
  /** 給告警（T-21）、派工（T-16） */
  readonly events$ = new Subject<FleetEvent>();

  constructor(
    private readonly registry: RobotRegistry,
    private readonly writer: TelemetryWriter,
    private readonly settings: SettingsService,
    private readonly mqtt: MqttService,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(KYSELY) private readonly db: Database,
  ) {}

  async onModuleInit() {
    this.startedAt = Date.now();
    try {
      await this.registry.load();
      await this.restore();
    } catch (e) {
      this.log.error(`載入機器人清單失敗：${e instanceof Error ? e.message : e}`);
    }
    const json = (fn: (key: string, body: unknown) => Promise<void>, pos: number) => (topic: string, payload: Buffer) => {
      let body: unknown;
      try {
        body = JSON.parse(payload.toString('utf8'));
      } catch {
        this.warnOnce(`json:${topic}`, `${topic} 不是 JSON，丟棄`);
        return;
      }
      void fn(topic.split('/')[pos], body).catch((e) => this.log.error(`${topic}：${e instanceof Error ? e.stack : e}`));
    };
    this.mqtt.subscribe(topics.telemetry('+'), 0, json((c, b) => this.handleTelemetry(c, b), 2));
    this.mqtt.subscribe(topics.online('+'), 1, json((c, b) => this.handleOnline(c, b), 2));
    this.mqtt.subscribe(topics.adapterStatus('+'), 1, json((n, b) => this.handleAdapterStatus(n, b), 2));
    this.tick = setInterval(() => void this.checkOffline().catch((e) => this.log.error(String(e))), TICK_MS);
  }

  onModuleDestroy() {
    clearInterval(this.tick);
    for (const t of this.throttle.values()) clearTimeout(t.timer);
  }

  /** 指定樓層目前所有機器人狀態（WebSocket 訂閱時先送一次全量） */
  snapshot(floors: readonly string[]): LiveState[] {
    return [...this.live.values()].filter((s) => floors.includes(s.floor));
  }

  get(code: string): LiveState | undefined {
    return this.live.get(code);
  }

  async handleTelemetry(code: string, raw: unknown, now = Date.now()): Promise<void> {
    const robot = await this.registry.resolve(code);
    if (!robot) return;
    const parsed = Telemetry.safeParse(raw);
    if (!parsed.success) {
      const why = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      this.warnOnce(`bad:${code}`, `${code} 遙測格式錯誤，丟棄：${why}`);
      return;
    }
    const t = parsed.data;
    const prev = this.live.get(code);
    if (prev?.online && t.ts < prev.ts) return; // QoS 0 可能亂序，舊的丟掉
    if (t.pose.floor !== robot.floor) {
      this.warnOnce(`floor:${code}`, `${code} 回報樓層 ${t.pose.floor} 與登記的 ${robot.floor} 不同，以登記為準`);
    }

    const next: LiveState = {
      robotId: robot.id,
      code,
      floor: robot.floor,
      online: true,
      lastSeen: now,
      ts: t.ts,
      x: t.pose.x,
      y: t.pose.y,
      yaw: t.pose.yaw,
      battery: t.battery.pct,
      charging: t.battery.charging,
      state: t.state,
      speed: t.speed ?? null,
      taskId: t.taskRef ?? null,
      rssi: t.net?.rssi ?? null,
      faults: t.faults,
    };
    this.live.set(code, next);

    const at = new Date(Math.abs(t.ts - now) > MAX_CLOCK_SKEW_MS ? now : t.ts);
    this.writer.add({
      at,
      robot_id: robot.id,
      x: next.x,
      y: next.y,
      yaw: next.yaw,
      battery: next.battery,
      charging: next.charging,
      state: next.state,
      // taskRef 可能是 cmdId（非 UUID），只有 taskId 才入庫
      task_id: next.taskId && UUID.test(next.taskId) ? next.taskId : null,
      rssi: next.rssi === null ? null : Math.round(next.rssi),
      speed: next.speed,
    });
    await this.save(next);

    if (!prev?.online) {
      this.events$.next({ type: 'online', robot, at: now });
      this.out$.next({ event: 'robot.online', floor: robot.floor, data: { robotId: robot.id, code, online: true } });
    }
    if (prev?.state !== next.state) {
      await this.logState(robot, next.state, prev ? (prev.online ? null : 'reconnected') : 'first_seen', at);
      this.events$.next({ type: 'state', robot, from: prev?.state ?? null, to: next.state, at: now });
      this.emitState(next, true);
    } else {
      this.emitState(next, false);
    }
  }

  async handleOnline(code: string, raw: unknown): Promise<void> {
    const msg = RobotOnline.safeParse(raw);
    if (!msg.success) return this.warnOnce(`online:${code}`, `${code} online 訊息格式錯誤`);
    if (msg.data.online) return; // 上線以收到遙測為準
    const robot = await this.registry.resolve(code);
    if (robot) await this.setOffline(robot, 'adapter_reported');
  }

  async handleAdapterStatus(name: string, raw: unknown): Promise<void> {
    const msg = AdapterStatus.safeParse(raw);
    if (!msg.success) return this.warnOnce(`adapter:${name}`, `轉接器 ${name} 狀態格式錯誤`);
    await this.redis.hset(`adapter:${name}`, { status: JSON.stringify(msg.data), at: Date.now() });
    if (msg.data.alive) return;
    this.log.warn(`轉接器 ${name} 斷線，所屬機器人全部視為離線`);
    for (const robot of this.registry.all().filter((r) => r.adapter === name)) {
      await this.setOffline(robot, 'adapter_down');
    }
  }

  /** 每秒執行：超過 robot.offlineSec 沒遙測 → 離線。後端剛啟動時給一個完整的寬限期 */
  async checkOffline(now = Date.now()): Promise<void> {
    const limit = (await this.settings.getNumber('robot.offlineSec', 10)) * 1000;
    for (const s of this.live.values()) {
      if (!s.online) continue;
      if (now - Math.max(s.lastSeen, this.startedAt) > limit) {
        const robot = this.registry.get(s.code);
        if (robot) await this.setOffline(robot, 'telemetry_timeout', now);
      }
    }
  }

  private async setOffline(robot: RobotInfo, reason: OfflineReason, now = Date.now()) {
    const prev = this.live.get(robot.code);
    if (!prev?.online) return;
    const next: LiveState = { ...prev, online: false, state: 'offline', speed: null };
    this.live.set(robot.code, next);
    await this.save(next);
    await this.logState(robot, 'offline', reason, new Date(now));
    this.log.warn(`${robot.code} 離線（${reason}）`);
    this.events$.next({ type: 'offline', robot, reason, at: now });
    this.out$.next({ event: 'robot.online', floor: robot.floor, data: { robotId: robot.id, code: robot.code, online: false } });
    this.emitState(next, true);
  }

  /** 每台節流 500 ms：期間內的更新只送最後一筆；狀態改變立即送 */
  private emitState(s: LiveState, force: boolean) {
    const now = Date.now();
    const th = this.throttle.get(s.code) ?? { last: 0 };
    this.throttle.set(s.code, th);
    if (force || now - th.last >= WS_THROTTLE_MS) {
      clearTimeout(th.timer);
      th.timer = undefined;
      th.last = now;
      this.out$.next({ event: 'robot.state', floor: s.floor, data: s });
    } else if (!th.timer) {
      th.timer = setTimeout(() => {
        th.timer = undefined;
        th.last = Date.now();
        const latest = this.live.get(s.code);
        if (latest) this.out$.next({ event: 'robot.state', floor: latest.floor, data: latest });
      }, WS_THROTTLE_MS - (now - th.last));
    }
  }

  private async save(s: LiveState) {
    await this.redis.hset(redisKey(s.code), { live: JSON.stringify(s), lastSeen: s.lastSeen, online: s.online ? 1 : 0 });
  }

  private async logState(robot: RobotInfo, state: string, reason: string | null, at: Date) {
    try {
      await this.db.insertInto('robot_state_log').values({ at, robot_id: robot.id, state, reason }).execute();
    } catch (e) {
      this.log.error(`寫入 robot_state_log 失敗：${e instanceof Error ? e.message : e}`);
    }
  }

  /** 重啟後從 Redis 還原最後狀態，畫面不會整片空白 */
  private async restore() {
    for (const r of this.registry.all()) {
      const raw = await this.redis.hget(redisKey(r.code), 'live');
      if (!raw) continue;
      try {
        const s = JSON.parse(raw) as LiveState;
        this.live.set(r.code, { ...s, robotId: r.id, floor: r.floor });
      } catch {
        /* 壞掉的快取直接忽略，等下一筆遙測 */
      }
    }
  }

  private warnOnce(key: string, msg: string) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.log.warn(msg);
  }
}
