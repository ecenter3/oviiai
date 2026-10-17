import { Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import { merge, type Subscription } from 'rxjs';
import type { Server, Socket } from 'socket.io';
import { z } from 'zod';
import { AuthRepository } from '../auth/auth.repository';
import type { AccessPayload } from '../auth/auth.service';
import { satisfies } from '../auth/perm.decorator';
import type { Principal } from '../auth/principal';
import { visibleCategories } from '../alarms/alarms.controller';
import { type AlarmCategory, AlarmsService } from '../alarms/alarms.service';
import { ChargingService } from '../charging/charging.service';
import { IntercomService } from '../intercom/intercom.service';
import { MediaService } from '../media/media.service';
import { CommandBus } from '../commands/command-bus.service';
import { CommandsService, type TeleopResult } from '../commands/commands.service';
import { TeleopLock } from '../commands/teleop-lock.service';
import { TasksService } from '../dispatch/tasks.service';
import { FleetService } from '../fleet/fleet.service';
import { TokenBucket } from './rate-limit';
import { StatsService } from './stats.service';

/** 看得到機器人即時狀態的頁面：實時監控、機器人狀態、實時遙控（subscribe 樓層需要） */
const ROBOT_PERMS = { mode: 'any' as const, codes: ['monitor' as const, 'robots' as const, 'remote' as const] };
/** 可以連線：看機器人，或只看告警（告警頁的使用者也要收 alarm.new 彈窗響鈴） */
// params：參數頁收自己送出的 set_params 結果（robot.cmdResult 只送到樓層房間與送出者本人）
const WS_PERMS = { mode: 'any' as const, codes: [...ROBOT_PERMS.codes, 'sysalarm' as const, 'bizalarm' as const, 'captures' as const, 'records' as const, 'params' as const] };

const Subscribe = z.object({ floors: z.array(z.string().regex(/^[a-z0-9]{1,8}$/)).max(10) });

export const floorRoom = (floor: string) => `floor:${floor}`;
export const userRoom = (userId: string) => `user:${userId}`;
/** 看得到任務內容的連線（與 GET /tasks 相同：dispatch 或 monitor；PR #6 審查第 3 點） */
export const TASKS_ROOM = 'tasks';
const TASK_PERMS = { mode: 'any' as const, codes: ['dispatch' as const, 'monitor' as const] };
/** 告警依類別分房間：與 GET /alarms 相同的可見範圍 */
export const alarmRoom = (category: AlarmCategory) => `alarms:${category}`;
/** 新抓拍給有抓拍圖片權限的、新錄影給有錄像回放權限的；錄影中狀態給看影像的頁面（T-28） */
export const mediaRoom = (kind: 'snapshot' | 'clip') => `media:${kind}`;
export const RECORDING_ROOM = 'media:recording';
const RECORDING_PERMS = { mode: 'any' as const, codes: ['monitor' as const, 'robots' as const, 'remote' as const, 'records' as const] };

interface SocketData {
  user: Principal;
  floors: string[];
  expiryTimer?: NodeJS.Timeout;
  lastTeleopError?: TeleopResult | 'rate_limited';
  teleopBucket?: TokenBucket;
}

function wsError(code: string, message: string) {
  return Object.assign(new Error(message), { data: { code } });
}

/**
 * 介面規格 §4：`wss://<host>/ws?token=<accessToken>`（Socket.IO），唯一的即時通道。
 * 驗證只在連線時做一次（PR #2 審查第 4 點）；access token 到期主動斷線，前端以新 token 重連。
 *
 * 伺服器 → 瀏覽器：robot.state、robot.online（fleet）、robot.cmdResult（指令匯流排）、teleop.revoked、teleop.error、talk.ended、
 *   stats.tick（每 5 秒，所有連線；連線時先送一次）、task.updated（有 dispatch 或 monitor 權限的連線）、
 *   alarm.new／alarm.updated（依類別：sysalarm 或 monitor 收系統告警，bizalarm 或 monitor 收業務告警）
 * 瀏覽器 → 伺服器：subscribe {floors}、teleop.cmd {robotId, lockId, vx, vy, wz}
 */
@WebSocketGateway({ path: '/ws', serveClient: false })
export class RealtimeGateway
  implements OnGatewayInit<Server>, OnGatewayConnection<Socket>, OnGatewayDisconnect<Socket>, OnModuleDestroy, OnApplicationBootstrap
{
  private readonly log = new Logger('Realtime');
  private subs: Subscription[] = [];
  private statsTimer?: NodeJS.Timeout;
  private server?: Server;

  constructor(
    private readonly fleet: FleetService,
    private readonly bus: CommandBus,
    private readonly lock: TeleopLock,
    private readonly commands: CommandsService,
    private readonly jwt: JwtService,
    private readonly users: AuthRepository,
    private readonly stats: StatsService,
    private readonly tasks: TasksService,
    private readonly charging: ChargingService,
    private readonly alarms: AlarmsService,
    private readonly media: MediaService,
    private readonly intercom: IntercomService,
  ) {}

  afterInit(server: Server) {
    this.server = server;
    server.use((socket, next) => {
      this.authenticate(socket).then(
        () => next(),
        (e: Error) => next(e),
      );
    });
    this.subs = [
      this.fleet.out$.subscribe((m) => server.to(floorRoom(m.floor)).emit(m.event, m.data)),
      // 指令結果：樓層監控畫面＋下指令的人（可能沒訂閱該樓層）
      this.bus.results$.subscribe((m) => {
        const rooms = [floorRoom(m.floor), ...(m.userId ? [userRoom(m.userId)] : [])];
        server.to(rooms).emit('robot.cmdResult', m.data);
      }),
      // 任務更新只推給有 dispatch 或 monitor 權限的連線（不分樓層：監控頁任務面板顯示全部樓層）
      this.tasks.changes$.subscribe((t) => server.to(TASKS_ROOM).emit('task.updated', t)),
      // 充電樁佔用、排隊、人工充電變化（介面規格 §4 charger.updated；這裡一次送整個樓層）
      this.charging.updates$.subscribe((v) => server.to(floorRoom(v.floor)).emit('charger.updated', v)),
      // 告警（介面規格 §4 alarm.new：告警物件＋通知設定；alarm.updated：狀態、處理人、重複次數）
      this.alarms.created$.subscribe((m) => server.to(alarmRoom(m.alarm.category)).emit('alarm.new', m)),
      this.alarms.updated$.subscribe((m) => server.to(alarmRoom(m.category)).emit('alarm.updated', m)),
      this.media.created$.subscribe((m) => server.to(mediaRoom(m.kind as 'snapshot' | 'clip')).emit('media.new', m)),
      this.media.recordings$.subscribe((m) => server.to(RECORDING_ROOM).emit('media.recording', m)),
      // 對講被結束（機器人端斷線、管理員結束）：只通知對講者本人
      this.intercom.ended$.subscribe(({ userId, ...m }) => server.to(userRoom(userId)).emit('talk.ended', m)),
      this.lock.revoked$.subscribe((m) =>
        server.to(userRoom(m.previous.userId)).emit('teleop.revoked', { robotId: m.robotId, code: m.code, by: m.by, reason: m.reason }),
      ),
    ];
  }

  onModuleDestroy() {
    for (const s of this.subs) s.unsubscribe();
    clearInterval(this.statsTimer);
  }

  /** 介面規格 §4：stats.tick 首頁統計卡數字，每 5 秒 */
  onApplicationBootstrap() {
    this.statsTimer = setInterval(() => void this.broadcastStats(), STATS_MS);
  }

  private async broadcastStats() {
    if (!this.server || this.server.engine.clientsCount === 0) return;
    try {
      this.server.emit('stats.tick', await this.stats.compute());
    } catch (e) {
      this.log.error(`統計失敗：${e instanceof Error ? e.message : e}`);
    }
  }

  async handleConnection(socket: Socket) {
    try {
      socket.emit('stats.tick', await this.stats.compute());
    } catch {
      /* 下一次 tick 會補上 */
    }
  }

  handleDisconnect(socket: Socket) {
    clearTimeout((socket.data as SocketData).expiryTimer);
  }

  /** `subscribe {floors}`：只收這些樓層；回傳確認，並先送一次目前全量狀態 */
  @SubscribeMessage('subscribe')
  async subscribe(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown) {
    const parsed = Subscribe.safeParse(body);
    if (!parsed.success) return { ok: false, error: { code: 'VALIDATION_FAILED', message: '樓層格式錯誤' } };
    const data = socket.data as SocketData;
    if (!satisfies(data.user.perms, ROBOT_PERMS)) return { ok: false, error: { code: 'FORBIDDEN', message: '沒有權限查看機器人狀態' } };
    for (const f of data.floors ?? []) await socket.leave(floorRoom(f));
    data.floors = [...new Set(parsed.data.floors)];
    for (const f of data.floors) await socket.join(floorRoom(f));
    for (const s of this.fleet.snapshot(data.floors)) socket.emit('robot.state', s);
    return { ok: true, floors: data.floors };
  }

  /** 遙控速度，每 100 ms 一筆，不回 ack；失敗只在原因改變時送一次 teleop.error，避免 10 Hz 洗版 */
  @SubscribeMessage('teleop.cmd')
  async teleop(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown) {
    const data = socket.data as SocketData;
    data.teleopBucket ??= new TokenBucket(TELEOP_MAX_HZ, TELEOP_BURST);
    if (!data.teleopBucket.take()) {
      if (data.lastTeleopError !== 'rate_limited') socket.emit('teleop.error', { code: 'RATE_LIMITED', reason: 'rate_limited' });
      data.lastTeleopError = 'rate_limited';
      return;
    }
    const r = await this.commands.teleop(data.user, body);
    if (r !== 'ok' && r !== data.lastTeleopError) socket.emit('teleop.error', { code: TELEOP_ERRORS[r], reason: r });
    data.lastTeleopError = r === 'ok' ? undefined : r;
  }

  private async authenticate(socket: Socket) {
    const h = socket.handshake;
    const token = (h.auth?.token as string | undefined) ?? (typeof h.query.token === 'string' ? h.query.token : undefined);
    if (!token) throw wsError('UNAUTHENTICATED', '未登入');

    let payload: AccessPayload & { exp?: number };
    try {
      payload = await this.jwt.verifyAsync(token);
    } catch (e) {
      const expired = e instanceof Error && e.name === 'TokenExpiredError';
      throw wsError(expired ? 'TOKEN_EXPIRED' : 'UNAUTHENTICATED', expired ? '登入已過期' : '未登入');
    }
    const u = await this.users.findById(payload.sub);
    if (!u || !u.enabled) throw wsError('UNAUTHENTICATED', '帳號已停用或不存在');
    if (!satisfies(u.perms, WS_PERMS)) throw wsError('FORBIDDEN', '沒有權限查看機器人狀態或告警');

    const data = socket.data as SocketData;
    data.user = {
      sub: u.id,
      username: u.username,
      rid: u.roleId,
      displayName: u.displayName,
      roleName: u.roleName,
      isSystem: u.isSystem,
      perms: u.perms,
    };
    data.floors = [];
    await socket.join(userRoom(u.id));
    if (satisfies(u.perms, TASK_PERMS)) await socket.join(TASKS_ROOM);
    for (const c of visibleCategories(u.perms)) await socket.join(alarmRoom(c));
    if (u.perms.includes('captures')) await socket.join(mediaRoom('snapshot'));
    if (u.perms.includes('records')) await socket.join(mediaRoom('clip'));
    if (satisfies(u.perms, RECORDING_PERMS)) await socket.join(RECORDING_ROOM);
    if (payload.exp) {
      data.expiryTimer = setTimeout(
        () => {
          socket.emit('auth.expired', { code: 'TOKEN_EXPIRED' });
          socket.disconnect(true);
        },
        Math.max(payload.exp * 1000 - Date.now(), 0),
      );
    }
    this.log.debug(`${u.username} 連線 ${socket.id}`);
  }
}

const STATS_MS = 5_000;
/** teleop.cmd 每個連線上限（正常 10 Hz） */
export const TELEOP_MAX_HZ = 20;
const TELEOP_BURST = 5;

const TELEOP_ERRORS: Record<Exclude<TeleopResult, 'ok'>, string> = {
  forbidden: 'FORBIDDEN',
  not_holder: 'TELEOP_LOCKED',
  not_found: 'NOT_FOUND',
  offline: 'ROBOT_OFFLINE',
  estop: 'ROBOT_ESTOP',
};
