import { Logger, OnModuleDestroy } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import type { Subscription } from 'rxjs';
import { z } from 'zod';
import { AuthRepository } from '../auth/auth.repository';
import type { AccessPayload } from '../auth/auth.service';
import { satisfies } from '../auth/perm.decorator';
import type { Principal } from '../auth/principal';
import { FleetService } from './fleet.service';

/** 看得到機器人狀態的頁面：實時監控、機器人狀態 */
const WS_PERMS = { mode: 'any', codes: ['monitor', 'robots'] } as const;

const Subscribe = z.object({ floors: z.array(z.string().regex(/^[a-z0-9]{1,8}$/)).max(10) });

const room = (floor: string) => `floor:${floor}`;

interface SocketData {
  user: Principal;
  floors: string[];
  expiryTimer?: NodeJS.Timeout;
}

function wsError(code: string, message: string) {
  return Object.assign(new Error(message), { data: { code } });
}

/**
 * 介面規格 §4：`wss://<host>/ws?token=<accessToken>`（Socket.IO）。
 * 驗證只在連線時做一次（PR #2 審查第 4 點），不在每則訊息查資料庫。
 * access token 到期時主動斷線，前端以新 token 重連——權限變更最晚在 token 有效期（15 分鐘）內生效。
 */
@WebSocketGateway({ path: '/ws', serveClient: false })
export class FleetGateway implements OnGatewayInit<Server>, OnGatewayDisconnect<Socket>, OnModuleDestroy {
  private readonly log = new Logger('FleetGateway');
  private sub?: Subscription;

  constructor(
    private readonly fleet: FleetService,
    private readonly jwt: JwtService,
    private readonly users: AuthRepository,
  ) {}

  afterInit(server: Server) {
    server.use((socket, next) => {
      this.authenticate(socket).then(
        () => next(),
        (e: Error) => next(e),
      );
    });
    this.sub = this.fleet.out$.subscribe((m) => server.to(room(m.floor)).emit(m.event, m.data));
  }

  onModuleDestroy() {
    this.sub?.unsubscribe();
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
    for (const f of data.floors ?? []) await socket.leave(room(f));
    data.floors = [...new Set(parsed.data.floors)];
    for (const f of data.floors) await socket.join(room(f));
    for (const s of this.fleet.snapshot(data.floors)) socket.emit('robot.state', s);
    return { ok: true, floors: data.floors };
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
    if (!satisfies(u.perms, { mode: WS_PERMS.mode, codes: [...WS_PERMS.codes] })) {
      throw wsError('FORBIDDEN', '沒有權限查看機器人狀態');
    }

    const data = socket.data as SocketData;
    data.user = { sub: u.id, username: u.username, rid: u.roleId, displayName: u.displayName, roleName: u.roleName, perms: u.perms };
    data.floors = [];
    if (payload.exp) {
      const ms = payload.exp * 1000 - Date.now();
      data.expiryTimer = setTimeout(() => {
        socket.emit('auth.expired', { code: 'TOKEN_EXPIRED' });
        socket.disconnect(true);
      }, Math.max(ms, 0));
    }
    this.log.debug(`${u.username} 連線 ${socket.id}`);
  }
}
