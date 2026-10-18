import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Ack, type Command, type CommandType, topics } from '@oviiai/contracts';
import type Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { Subject } from 'rxjs';
import { AppError } from '../common/errors';
import { WarnOnce } from '../common/warn-once';
import type { RobotInfo } from '../fleet/types';
import { MqttService } from '../mqtt/mqtt.service';
import { RobotRegistry } from '../fleet/robot-registry';
import { REDIS } from '../redis/redis.module';
import { SettingsService } from '../settings/settings.service';

export type CmdStatus = 'sent' | 'accepted' | 'rejected' | 'done' | 'failed' | 'timeout';

export interface CmdRecord {
  cmdId: string;
  robotId: string;
  code: string;
  floor: string;
  type: CommandType;
  userId: string | null;
  /** 派工送出的指令：對應的任務（結果用來推進任務狀態） */
  taskId?: string;
  status: CmdStatus;
  sentAt: number;
  updatedAt: number;
  error?: { code: string; msg: string };
  result?: Record<string, unknown>;
}

/** WebSocket `robot.cmdResult`：送到該樓層與下指令的人 */
export interface CmdResultOut {
  floor: string;
  userId: string | null;
  data: {
    cmdId: string;
    robotId: string;
    code: string;
    type: string;
    taskId?: string;
    status: Exclude<CmdStatus, 'timeout' | 'sent'>;
    error?: { code: string; msg: string };
    result?: Record<string, unknown>;
  };
}

const PENDING = 'cmd:pending';
const RECORD_TTL_SEC = 24 * 3600;
const SWEEP_MS = 1_000;
const TERMINAL: ReadonlySet<CmdStatus> = new Set(['rejected', 'done', 'failed']);
const key = (cmdId: string) => `cmd:${cmdId}`;

export const newCmdId = () => `c_${randomUUID()}`;

/**
 * 指令匯流排（後端邏輯 §1）。send 產生 cmdId、發到 `rms/robot/{code}/cmd`、在 Redis 記錄；
 * 收到 ack 更新狀態並推 `robot.cmdResult`；cmd.timeoutSec（預設 15 秒）內沒有任何回覆 → 逾時失敗。
 * 待回覆清單放 Redis sorted set，後端重啟後仍會判逾時。
 */
@Injectable()
export class CommandBus implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('CommandBus');
  private readonly warn = new WarnOnce(this.log);
  private sweeper?: NodeJS.Timeout;
  /** 關閉中：Redis 可能已斷線，晚到的 ack 不再處理 */
  private closing = false;

  readonly results$ = new Subject<CmdResultOut>();
  /** 給告警（T-21 cmd_failed）：失敗、被拒、逾時 */
  readonly failures$ = new Subject<CmdRecord>();

  constructor(
    private readonly mqtt: MqttService,
    private readonly settings: SettingsService,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly registry: RobotRegistry,
  ) {}

  onModuleInit() {
    this.mqtt.subscribe(topics.ack('+'), 1, (topic, payload) => {
      let body: unknown;
      try {
        body = JSON.parse(payload.toString('utf8'));
      } catch {
        return this.warn.warn(`json:${topic}`, `${topic} 不是 JSON，丟棄`);
      }
      if (this.closing) return;
      void this.handleAck(topic.split('/')[2], body).catch((e) => this.log.error(`${topic}：${e instanceof Error ? e.stack : e}`));
    });
    this.sweeper = setInterval(() => void this.sweep().catch((e) => this.log.error(String(e))), SWEEP_MS);
  }

  onModuleDestroy() {
    this.closing = true;
    clearInterval(this.sweeper);
  }

  async send(
    robot: RobotInfo,
    type: CommandType,
    args: Record<string, unknown>,
    userId: string | null,
    opts: { taskId?: string; cmdId?: string } = {},
  ): Promise<CmdRecord> {
    // MQTT 斷線時 mqtt.js 會把訊息排隊、重連後才送；導航類指令延遲執行很危險，直接拒絕
    if (!this.mqtt.connected) throw new AppError('ROBOT_OFFLINE', '與機器人的控制通道中斷，請稍後再試');
    const now = Date.now();
    const rec: CmdRecord = {
      cmdId: opts.cmdId ?? newCmdId(),
      robotId: robot.id,
      code: robot.code,
      floor: robot.floor,
      type,
      userId,
      ...(opts.taskId && { taskId: opts.taskId }),
      status: 'sent',
      sentAt: now,
      updatedAt: now,
    };
    const timeoutMs = (await this.settings.getNumber('cmd.timeoutSec', 15)) * 1000;
    await this.redis
      .multi()
      .set(key(rec.cmdId), JSON.stringify(rec), 'EX', RECORD_TTL_SEC)
      .zadd(PENDING, now + timeoutMs, rec.cmdId)
      .exec();
    const msg: Command = { cmdId: rec.cmdId, ts: now, type, args };
    await this.mqtt.publish(topics.cmd(robot.code), JSON.stringify(msg), 1);
    return rec;
  }

  async get(cmdId: string): Promise<CmdRecord | undefined> {
    const raw = await this.redis.get(key(cmdId));
    return raw ? (JSON.parse(raw) as CmdRecord) : undefined;
  }

  async handleAck(code: string, raw: unknown): Promise<void> {
    const parsed = Ack.safeParse(raw);
    if (!parsed.success) return this.warn.warn(`ack:${code}`, `${code} ack 格式錯誤，丟棄`);
    const ack = parsed.data;
    const rec = await this.get(ack.cmdId);
    if (!rec) return; // 不是這個後端發的，或超過 24 小時
    if (rec.code !== code) return this.warn.warn(`ackcode:${ack.cmdId}`, `${code} 回覆了 ${rec.code} 的指令 ${ack.cmdId}，丟棄`);
    if (TERMINAL.has(rec.status)) return;
    if (rec.status === 'accepted' && ack.status === 'accepted') return;
    if (rec.status === 'timeout') this.log.warn(`${rec.code} 指令 ${rec.cmdId} 逾時後才收到 ${ack.status}`);

    const next: CmdRecord = { ...rec, status: ack.status, updatedAt: Date.now(), error: ack.error, result: ack.result };
    await this.redis.multi().set(key(rec.cmdId), JSON.stringify(next), 'KEEPTTL').zrem(PENDING, rec.cmdId).exec();
    this.emit(next);
    if (ack.status === 'rejected' || ack.status === 'failed') this.failures$.next(next);
  }

  /** 逾時判定：deadline 已過、仍在待回覆清單 → timeout */
  async sweep(now = Date.now()): Promise<void> {
    const due = await this.redis.zrangebyscore(PENDING, 0, now);
    for (const cmdId of due) {
      // 只有搶到移除的那一個處理，避免重複判定
      if ((await this.redis.zrem(PENDING, cmdId)) === 0) continue;
      const rec = await this.get(cmdId);
      if (!rec || rec.status !== 'sent') continue;
      // 機器人已刪除或停用（例：測試結束清掉的機器人、停用前送出的指令）：不判逾時、不產生告警，紀錄直接移除
      if (!(await this.registry.resolveId(rec.robotId))) {
        await this.redis.del(key(cmdId));
        this.log.debug(`${rec.code} 已不在登記清單，移除未回覆的指令 ${rec.type}（${cmdId}）`);
        continue;
      }
      const next: CmdRecord = {
        ...rec,
        status: 'timeout',
        updatedAt: now,
        error: { code: 'ROBOT_TIMEOUT', msg: '機器人未在時限內回覆' },
      };
      await this.redis.set(key(cmdId), JSON.stringify(next), 'KEEPTTL');
      this.log.warn(`${rec.code} 指令 ${rec.type}（${cmdId}）逾時`);
      this.emit(next);
      this.failures$.next(next);
    }
  }

  private emit(r: CmdRecord) {
    const status = r.status === 'timeout' ? 'failed' : (r.status as CmdResultOut['data']['status']);
    this.results$.next({
      floor: r.floor,
      userId: r.userId,
      data: { cmdId: r.cmdId, robotId: r.robotId, code: r.code, type: r.type, taskId: r.taskId, status, error: r.error, result: r.result },
    });
  }
}
