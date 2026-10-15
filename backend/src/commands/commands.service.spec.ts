import { describe, expect, it } from 'vitest';
import type { Principal } from '../auth/principal';
import { AppError } from '../common/errors';
import type { FleetService } from '../fleet/fleet.service';
import type { RobotRegistry } from '../fleet/robot-registry';
import type { RobotInfo } from '../fleet/types';
import type { MqttService } from '../mqtt/mqtt.service';
import type { CommandBus } from './command-bus.service';
import { CommandsService } from './commands.service';
import type { TeleopHolder, TeleopLock } from './teleop-lock.service';

const ROBOT: RobotInfo = { id: '11111111-1111-4111-8111-111111111111', code: 'B2-001', floor: '1f', adapter: 'mock', caps: ['ptz'] };

const user = (perms: string[], over: Partial<Principal> = {}): Principal => ({
  sub: 'u1',
  username: 'guard1',
  rid: 'r',
  displayName: 'g',
  roleName: '警衛',
  isSystem: false,
  perms,
  ...over,
});

function setup(opts: { online?: boolean; state?: string; holder?: TeleopHolder } = {}) {
  const sent: { type: string; args: unknown; userId: string | null }[] = [];
  const published: { topic: string; body: string }[] = [];
  let holder = opts.holder;
  const bus = {
    send: async (_r: RobotInfo, type: string, args: unknown, userId: string | null) => {
      sent.push({ type, args, userId });
      return { cmdId: `c_${sent.length}`, status: 'sent' };
    },
  } as unknown as CommandBus;
  const lock = {
    holder: async () => holder,
    ttlSec: async () => 20,
    tryAcquire: async (_c: string, userId: string, username: string) =>
      holder ? undefined : (holder = { lockId: 'l_new', userId, username }),
    takeOver: async (_c: string, userId: string, username: string) => {
      const previous = holder;
      holder = { lockId: 'l_force', userId, username };
      return { holder, previous };
    },
    renew: async (_c: string, lockId: string, userId: string) => holder?.lockId === lockId && holder.userId === userId,
    release: async () => ((holder = undefined), true),
    revoked$: { next: () => {} },
  } as unknown as TeleopLock;
  const registry = { resolveId: async (id: string) => (id === ROBOT.id ? ROBOT : undefined) } as unknown as RobotRegistry;
  const fleet = {
    get: () => (opts.online === false ? { online: false } : { online: true, state: opts.state ?? 'idle' }),
  } as unknown as FleetService;
  const mqtt = {
    connected: true,
    publish: async (topic: string, body: string) => void published.push({ topic, body }),
  } as unknown as MqttService;
  return { svc: new CommandsService(bus, lock, registry, fleet, mqtt), sent, published, getHolder: () => holder };
}

async function code(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    if (e instanceof AppError) return e.code;
    throw e;
  }
  return 'OK';
}

const OPS = ['op.remote', 'op.estop', 'op.dispatch'];

describe('CommandsService.issue', () => {
  it('依指令類型檢查權限：警衛沒有 op.dispatch 不能 navigate，但能急停', async () => {
    const { svc, sent } = setup();
    const guard = user(['op.remote', 'op.estop']);
    expect(await code(svc.issue(ROBOT.id, 'navigate', { x: 1, y: 2 }, guard))).toBe('FORBIDDEN');
    expect(await code(svc.issue(ROBOT.id, 'estop', {}, guard))).toBe('OK');
    expect(sent.map((s) => s.type)).toEqual(['estop']);
  });

  it('參數驗證：缺座標、雲台超出 -1..1、多餘欄位都回 VALIDATION_FAILED', async () => {
    const { svc } = setup();
    const u = user(OPS);
    expect(await code(svc.issue(ROBOT.id, 'navigate', { x: 1 }, u))).toBe('VALIDATION_FAILED');
    expect(await code(svc.issue(ROBOT.id, 'ptz', { pan: 2, tilt: 0, zoom: 0 }, u))).toBe('VALIDATION_FAILED');
    expect(await code(svc.issue(ROBOT.id, 'stop', { now: true }, u))).toBe('VALIDATION_FAILED');
  });

  it('能力清單沒有的功能回 INVALID_STATE（不做品牌判斷）', async () => {
    const { svc } = setup();
    expect(await code(svc.issue(ROBOT.id, 'ptz', { pan: 0, tilt: 0, zoom: 0 }, user(OPS)))).toBe('OK');
    expect(await code(svc.issue(ROBOT.id, 'light', { on: true }, user(OPS)))).toBe('INVALID_STATE');
  });

  it('離線回 ROBOT_OFFLINE；但 stop、estop 仍送出', async () => {
    const { svc, sent } = setup({ online: false });
    expect(await code(svc.issue(ROBOT.id, 'navigate', { x: 1, y: 2 }, user(OPS)))).toBe('ROBOT_OFFLINE');
    expect(await code(svc.issue(ROBOT.id, 'stop', {}, user(OPS)))).toBe('OK');
    expect(await code(svc.issue(ROBOT.id, 'estop', {}, user(OPS)))).toBe('OK');
    expect(sent.map((s) => s.type)).toEqual(['stop', 'estop']);
  });

  it('急停中：移動類回 ROBOT_ESTOP，解除急停可送', async () => {
    const { svc } = setup({ state: 'estop' });
    expect(await code(svc.issue(ROBOT.id, 'navigate', { x: 1, y: 2 }, user(OPS)))).toBe('ROBOT_ESTOP');
    expect(await code(svc.issue(ROBOT.id, 'estop_release', {}, user(OPS)))).toBe('OK');
  });

  it('別人遙控中：移動類回 TELEOP_LOCKED；停止、急停、雲台不受影響；持有人自己可以', async () => {
    const holder = { lockId: 'l_1', userId: 'other', username: '王小明' };
    const { svc } = setup({ holder });
    expect(await code(svc.issue(ROBOT.id, 'navigate', { x: 1, y: 2 }, user(OPS)))).toBe('TELEOP_LOCKED');
    expect(await code(svc.issue(ROBOT.id, 'stop', {}, user(OPS)))).toBe('OK');
    expect(await code(svc.issue(ROBOT.id, 'estop', {}, user(OPS)))).toBe('OK');
    expect(await code(svc.issue(ROBOT.id, 'ptz', { pan: 0, tilt: 0, zoom: 0 }, user(OPS)))).toBe('OK');
    expect(await code(svc.issue(ROBOT.id, 'navigate', { x: 1, y: 2 }, user(OPS, { sub: 'other' })))).toBe('OK');
  });

  it('找不到或已停用的機器人回 NOT_FOUND', async () => {
    const { svc } = setup();
    expect(await code(svc.issue('22222222-2222-4222-8222-222222222222', 'stop', {}, user(OPS)))).toBe('NOT_FOUND');
  });
});

describe('遙控鎖', () => {
  it('取得鎖後送 pause；同一人再取回同一把鎖、不重送 pause', async () => {
    const { svc, sent } = setup();
    const a = await svc.acquire(ROBOT.id, user(OPS), false);
    expect(a).toEqual({ lockId: 'l_new', ttlSec: 30 });
    const b = await svc.acquire(ROBOT.id, user(OPS), false);
    expect(b.lockId).toBe('l_new');
    expect(sent.map((s) => s.type)).toEqual(['pause']);
  });

  it('第二人取鎖回 TELEOP_LOCKED；非系統管理員帶 force 也不行；系統管理員可強制接管', async () => {
    const { svc, getHolder } = setup({ holder: { lockId: 'l_1', userId: 'other', username: '王小明' } });
    expect(await code(svc.acquire(ROBOT.id, user(OPS), false))).toBe('TELEOP_LOCKED');
    expect(await code(svc.acquire(ROBOT.id, user(OPS), true))).toBe('TELEOP_LOCKED');
    expect(await code(svc.acquire(ROBOT.id, user(OPS, { isSystem: true, sub: 'admin' }), true))).toBe('OK');
    expect(getHolder()?.userId).toBe('admin');
  });

  it('釋放：持有人釋放後送 resume；別人不能釋放', async () => {
    const { svc, sent } = setup({ holder: { lockId: 'l_1', userId: 'u1', username: 'guard1' } });
    expect(await code(svc.release(ROBOT.id, user(OPS, { sub: 'other' })))).toBe('TELEOP_LOCKED');
    await svc.release(ROBOT.id, user(OPS));
    expect(sent.map((s) => s.type)).toEqual(['resume']);
  });

  it('teleop.cmd：鎖對才轉發到 MQTT；鎖錯、無權限、超速都不轉發', async () => {
    const { svc, published } = setup({ holder: { lockId: 'l_1', userId: 'u1', username: 'guard1' } });
    const msg = { robotId: ROBOT.id, lockId: 'l_1', vx: 0.5, vy: 0, wz: 0.2 };
    expect(await svc.teleop(user(OPS), msg)).toBe('ok');
    expect(published[0].topic).toBe('rms/robot/B2-001/teleop');
    expect(JSON.parse(published[0].body)).toMatchObject({ lockId: 'l_1', vx: 0.5, wz: 0.2 });

    expect(await svc.teleop(user(OPS), { ...msg, lockId: 'l_x' })).toBe('not_holder');
    expect(await svc.teleop(user(OPS, { sub: 'other' }), msg)).toBe('not_holder');
    expect(await svc.teleop(user(['op.estop']), msg)).toBe('forbidden');
    expect(await svc.teleop(user(OPS), { ...msg, vx: 9 })).toBe('not_holder');
    expect(published).toHaveLength(1);
  });
});
