/**
 * T-11 端對端：指令 API → MQTT cmd → 假轉接器回 ack → WebSocket robot.cmdResult；遙控鎖；逾時。
 * 另含 PR #3 審查第 1 點：停用的機器人從即時狀態移除。需要 PostgreSQL、Redis、EMQX。
 */
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type Redis from 'ioredis';
import mqtt, { type MqttClient } from 'mqtt';
import { io, type Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { hashPassword } from '../src/auth/password';
import { CommandBus } from '../src/commands/command-bus.service';
import { loadEnv } from '../src/config';
import { createDatabase, type Database } from '../src/db/database.module';
import { FleetService } from '../src/fleet/fleet.service';
import { RobotRegistry } from '../src/fleet/robot-registry';
import { MqttService } from '../src/mqtt/mqtt.service';
import { REDIS } from '../src/redis/redis.module';
import { testMqttAuth } from './mqtt-test-auth';

loadEnv();
const ready = !!(process.env.DATABASE_URL && process.env.REDIS_URL && process.env.MQTT_URL);
const tag = `cm${Date.now().toString(36)}`;
const CODE = `E2E-${tag}`;
const PW = 'Secret123';

async function until<T>(fn: () => T | Promise<T>, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('等待逾時');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(!ready)('指令與遙控（e2e）', () => {
  let app: NestExpressApplication;
  let db: Database;
  let adapter: MqttClient;
  let url: string;
  let robotId: string;
  const users: string[] = [];
  const roles: string[] = [];
  const sockets: Socket[] = [];
  const cmds: { cmdId: string; type: string; args: Record<string, unknown> }[] = [];
  const teleops: Record<string, unknown>[] = [];
  /** 假轉接器的回覆方式：accepted→done、只回 rejected、或不回（測逾時） */
  let mode: 'ok' | 'reject' | 'silent' = 'ok';
  let guard: string;
  let guard2: string;
  let admin: string;
  let viewer: string;

  const http = () => request(app.getHttpServer());
  const post = (token: string, path: string) => http().post(`/api/v1/robots/${robotId}${path}`).set('Authorization', `Bearer ${token}`);

  async function makeUser(perms: string[], system = false) {
    const role = system
      ? (await db.selectFrom('roles').select('id').where('is_system', '=', true).executeTakeFirstOrThrow()).id
      : (await db.insertInto('roles').values({ name: `${tag}-${roles.length}`, perms }).returning('id').executeTakeFirstOrThrow()).id;
    if (!system) roles.push(role);
    const username = `${tag}-u${users.length}`;
    const u = await db
      .insertInto('users')
      .values({ username, display_name: username, password_hash: await hashPassword(PW), role_id: role })
      .returning('id')
      .executeTakeFirstOrThrow();
    users.push(u.id);
    return (await http().post('/api/v1/auth/login').send({ username, password: PW }).expect(200)).body.accessToken as string;
  }

  async function telemetry(state = 'idle') {
    await adapter.publishAsync(
      `rms/robot/${CODE}/telemetry`,
      JSON.stringify({ ts: Date.now(), pose: { x: 1, y: 1, yaw: 0, floor: '1f' }, battery: { pct: 80, charging: false }, state, faults: [] }),
    );
    await until(() => app.get(FleetService).get(CODE)?.state === state);
  }

  function connect(token: string) {
    const s = io(url, { path: '/ws', auth: { token }, transports: ['websocket'], reconnection: false });
    sockets.push(s);
    return s;
  }

  beforeAll(async () => {
    process.env.JWT_SECRET ||= 'e2e-secret-e2e-secret-e2e-secret-0';
    process.env.COOKIE_SECURE = 'false';
    db = createDatabase();
    robotId = (
      await db
        .insertInto('robots')
        .values({ code: CODE, brand: 'unitree', model: 'B2', floor_id: '1f', adapter: `e2e-${tag}`, caps: ['ptz'] })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;

    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.listen(0);
    url = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;
    await until(() => app.get(MqttService).connected);

    // 假轉接器
    adapter = await mqtt.connectAsync(process.env.MQTT_URL!, { clientId: `e2e-adapter-${tag}`, ...testMqttAuth() });
    await adapter.subscribeAsync([`rms/robot/${CODE}/cmd`, `rms/robot/${CODE}/teleop`], { qos: 1 });
    adapter.on('message', (topic, payload) => {
      const m = JSON.parse(payload.toString());
      if (topic.endsWith('/teleop')) return void teleops.push(m);
      cmds.push(m);
      const ack = (status: string, extra = {}) =>
        adapter.publish(`rms/robot/${CODE}/ack`, JSON.stringify({ cmdId: m.cmdId, ts: Date.now(), status, ...extra }), { qos: 1 });
      if (mode === 'reject') ack('rejected', { error: { code: 'UNSUPPORTED', msg: 'nope' } });
      if (mode === 'ok') {
        ack('accepted');
        setTimeout(() => ack('done', m.type === 'snapshot' ? { result: { objectKey: 'k.jpg' } } : {}), 30);
      }
    });

    guard = await makeUser(['monitor', 'remote', 'op.remote', 'op.estop']);
    guard2 = await makeUser(['monitor', 'remote', 'op.remote', 'op.estop']);
    admin = await makeUser([], true);
    viewer = await makeUser(['monitor']);
    await telemetry();
  });

  afterAll(async () => {
    for (const s of sockets) s.close();
    await adapter?.endAsync();
    if (app) {
      await app.get<Redis>(REDIS).del(`robot:${CODE}`, `teleop:${CODE}`);
      await app.close();
    }
    if (db) {
      await db.deleteFrom('telemetry').where('robot_id', '=', robotId).execute();
      await db.deleteFrom('robot_state_log').where('robot_id', '=', robotId).execute();
      // 指令失敗、離線等會經告警管線建告警：連同處理歷程一起清掉
      await db.deleteFrom('alarms').where('robot_id', '=', robotId).execute();
      await db.deleteFrom('robots').where('id', '=', robotId).execute();
      await db.deleteFrom('op_logs').where('user_id', 'in', users).execute();
      await db.deleteFrom('users').where('id', 'in', users).execute();
      if (roles.length) await db.deleteFrom('roles').where('id', 'in', roles).execute();
      await db.destroy();
    }
  });

  it('下指令回 202 cmdId；轉接器 accepted → done，WebSocket 依序推 robot.cmdResult', async () => {
    const s = connect(guard);
    const results: { cmdId: string; status: string; result?: unknown }[] = [];
    s.on('robot.cmdResult', (m) => results.push(m));
    await until(() => s.connected);

    const r = await post(guard, '/commands').send({ type: 'snapshot', args: { camera: 'front' } }).expect(202);
    expect(r.body).toEqual({ cmdId: expect.stringMatching(/^c_/), status: 'sent' });
    const sent = await until(() => cmds.find((c) => c.cmdId === r.body.cmdId));
    expect(sent).toMatchObject({ type: 'snapshot', args: { camera: 'front' } });

    await until(() => results.filter((x) => x.cmdId === r.body.cmdId).length === 2);
    expect(results.filter((x) => x.cmdId === r.body.cmdId).map((x) => x.status)).toEqual(['accepted', 'done']);
    expect(results.at(-1)?.result).toEqual({ objectKey: 'k.jpg' });

    // 下指令的人不一定訂閱該樓層，也收得到；別樓層的觀看者收不到
    expect(await s.emitWithAck('subscribe', { floors: [] })).toMatchObject({ ok: true });
  });

  it('rejected 也推給使用者', async () => {
    mode = 'reject';
    const s = connect(guard);
    const results: { cmdId: string; status: string; error?: { code: string } }[] = [];
    s.on('robot.cmdResult', (m) => results.push(m));
    await until(() => s.connected);
    const r = await post(guard, '/commands').send({ type: 'stop' }).expect(202);
    const res = await until(() => results.find((x) => x.cmdId === r.body.cmdId));
    expect(res).toMatchObject({ status: 'rejected', error: { code: 'UNSUPPORTED' } });
    mode = 'ok';
  });

  it('cmd.timeoutSec 內沒回覆 → failed（ROBOT_TIMEOUT）', async () => {
    mode = 'silent';
    const s = connect(guard);
    const results: { cmdId: string; status: string; error?: { code: string } }[] = [];
    s.on('robot.cmdResult', (m) => results.push(m));
    await until(() => s.connected);
    const r = await post(guard, '/commands').send({ type: 'stop' }).expect(202);
    await app.get(CommandBus).sweep(Date.now() + 16_000); // 不等 15 秒，直接以未來時間掃描
    const res = await until(() => results.find((x) => x.cmdId === r.body.cmdId));
    expect(res).toMatchObject({ status: 'failed', error: { code: 'ROBOT_TIMEOUT' } });
    expect((await app.get(CommandBus).get(r.body.cmdId))?.status).toBe('timeout');
    mode = 'ok';
  });

  it('權限依指令類型：只有 monitor 的人不能下指令；警衛沒有 op.dispatch 不能導航', async () => {
    await post(viewer, '/commands').send({ type: 'stop' }).expect(403);
    const r = await post(guard, '/commands').send({ type: 'navigate', args: { x: 1, y: 2 } }).expect(403);
    expect(r.body.error.details.required).toEqual(['op.dispatch']);
    await post(admin, '/commands').send({ type: 'navigate', args: { x: 1, y: 2 } }).expect(202);
  });

  it('能力清單沒有 light 回 409；參數錯誤回 400', async () => {
    await post(guard, '/commands').send({ type: 'light', args: { on: true } }).expect(409);
    await post(guard, '/commands').send({ type: 'ptz', args: { pan: 5, tilt: 0, zoom: 0 } }).expect(400);
    await post(guard, '/commands').send({ type: 'fly' }).expect(400);
  });

  it('指令寫入操作日誌（robot.<type>）', async () => {
    await post(guard, '/commands').send({ type: 'estop' }).expect(202);
    const log = await until(() =>
      db.selectFrom('op_logs').selectAll().where('action', '=', 'robot.estop').where('user_id', 'in', users).executeTakeFirst(),
    );
    expect(log).toMatchObject({ target: `robot:${robotId}` });
  });

  describe('遙控鎖', () => {
    it('取得 → teleop.cmd 轉發到 MQTT → 別人取鎖 409、別人導航 409、停止不受限 → 釋放送 resume', async () => {
      const before = cmds.length;
      const lock = (await post(guard, '/teleop/acquire').expect(200)).body;
      expect(lock).toEqual({ lockId: expect.stringMatching(/^l_/), ttlSec: 30 });
      await until(() => cmds.slice(before).some((c) => c.type === 'pause'));

      const s = connect(guard);
      await until(() => s.connected);
      s.emit('teleop.cmd', { robotId, lockId: lock.lockId, vx: 0.4, vy: 0, wz: 0.1 });
      const t = await until(() => teleops.find((x) => x.lockId === lock.lockId));
      expect(t).toMatchObject({ vx: 0.4, wz: 0.1 });

      const busy = await post(guard2, '/teleop/acquire').expect(409);
      expect(busy.body.error).toMatchObject({ code: 'TELEOP_LOCKED', details: { canForce: false } });
      await post(admin, '/commands').send({ type: 'navigate', args: { x: 3, y: 3 } }).expect(409);
      await post(guard2, '/commands').send({ type: 'stop' }).expect(202);

      // 別人拿錯的 lockId 送 teleop 不會轉發，並收到 teleop.error
      const s2 = connect(guard2);
      const errs: { code: string }[] = [];
      s2.on('teleop.error', (e) => errs.push(e));
      await until(() => s2.connected);
      s2.emit('teleop.cmd', { robotId, lockId: lock.lockId, vx: 1, vy: 0, wz: 0 });
      await until(() => errs.length > 0);
      expect(errs[0].code).toBe('TELEOP_LOCKED');
      expect(teleops.filter((x) => x.vx === 1)).toHaveLength(0);

      const n = cmds.length;
      await post(guard2, '/teleop/release').expect(409);
      await post(guard, '/teleop/release').expect(204);
      await until(() => cmds.slice(n).some((c) => c.type === 'resume'));
      expect(await app.get<Redis>(REDIS).get(`teleop:${CODE}`)).toBeNull();
    });

    it('系統管理員可強制接管，原持有人收到 teleop.revoked', async () => {
      await post(guard, '/teleop/acquire').expect(200);
      const s = connect(guard);
      const revoked: { code: string; by: string }[] = [];
      s.on('teleop.revoked', (m) => revoked.push(m));
      await until(() => s.connected);
      await post(guard2, '/teleop/acquire').send({ force: true }).expect(409);
      const r = await post(admin, '/teleop/acquire').send({ force: true }).expect(200);
      await until(() => revoked.length > 0);
      expect(revoked[0].code).toBe(CODE);
      await post(admin, '/teleop/release').expect(204);
      expect(r.body.lockId).toMatch(/^l_/);
    });

    it('急停：釋放遙控鎖並通知持有人；之後 teleop 不轉發；別人持鎖時不能解除急停（PR #4 審查第 1、2 點）', async () => {
      const lock = (await post(guard, '/teleop/acquire').expect(200)).body;
      const s = connect(guard);
      const revoked: { reason: string; by: string }[] = [];
      const errs: { code: string }[] = [];
      s.on('teleop.revoked', (m) => revoked.push(m));
      s.on('teleop.error', (e) => errs.push(e));
      await until(() => s.connected);

      await post(guard2, '/commands').send({ type: 'estop' }).expect(202);
      await until(() => revoked.length > 0);
      expect(revoked[0]).toMatchObject({ reason: 'estop' });
      expect(await app.get<Redis>(REDIS).get(`teleop:${CODE}`)).toBeNull();

      // 機器人回報進入急停後，就算拿著舊的 lockId 也不轉發
      await telemetry('estop');
      const n = teleops.length;
      s.emit('teleop.cmd', { robotId, lockId: lock.lockId, vx: 0.3, vy: 0, wz: 0 });
      await until(() => errs.length > 0);
      expect(errs[0].code).toBe('ROBOT_ESTOP');
      expect(teleops.length).toBe(n);

      // 急停中有人持鎖（例如鎖在急停前取得、急停由實體按鈕觸發且尚未處理）：別人不能解除
      await app.get<Redis>(REDIS).set(`teleop:${CODE}`, `l_x|${users[1]}|other`, 'EX', 30);
      await post(guard, '/commands').send({ type: 'estop_release' }).expect(409);
      await app.get<Redis>(REDIS).del(`teleop:${CODE}`);
      await post(guard, '/commands').send({ type: 'estop_release' }).expect(202);
      await telemetry('idle');
    });

    it('teleop.cmd 每個連線限制 20 Hz：一次灌 100 筆只轉發約 25 筆，回 RATE_LIMITED（PR #4 審查第 4 點）', async () => {
      const lock = (await post(guard, '/teleop/acquire').expect(200)).body;
      const s = connect(guard);
      const errs: { code: string }[] = [];
      s.on('teleop.error', (e) => errs.push(e));
      await until(() => s.connected);
      const n = teleops.length;
      for (let i = 0; i < 100; i++) s.emit('teleop.cmd', { robotId, lockId: lock.lockId, vx: 0.01 * i, vy: 0, wz: 0 });
      await until(() => errs.some((e) => e.code === 'RATE_LIMITED'));
      await new Promise((r) => setTimeout(r, 300));
      const forwarded = teleops.length - n;
      expect(forwarded).toBeGreaterThan(0);
      expect(forwarded).toBeLessThanOrEqual(25);
      await post(guard, '/teleop/release').expect(204);
    });

    it('急停中不能取鎖', async () => {
      await telemetry('estop');
      await post(guard, '/teleop/acquire').expect(409);
      await telemetry('idle');
    });
  });

  it('機器人在資料庫停用後，從即時狀態移除並推 robot.online removed（PR #3 審查第 1 點）', async () => {
    const s = connect(guard);
    const online: { code: string; online: boolean; removed?: boolean }[] = [];
    s.on('robot.online', (m) => online.push(m));
    await until(() => s.connected);
    await s.emitWithAck('subscribe', { floors: ['1f'] });

    await db.updateTable('robots').set({ enabled: false }).where('id', '=', robotId).execute();
    await app.get(RobotRegistry).load();
    await until(() => online.find((m) => m.code === CODE && m.removed));
    expect(app.get(FleetService).get(CODE)).toBeUndefined();
    expect(await app.get<Redis>(REDIS).exists(`robot:${CODE}`)).toBe(0);
    await post(guard, '/commands').send({ type: 'stop' }).expect(404);

    // 停用後的遙測被擋下，不會重新出現
    await adapter.publishAsync(`rms/robot/${CODE}/telemetry`, JSON.stringify({ ts: Date.now(), pose: { x: 1, y: 1, yaw: 0, floor: '1f' }, battery: { pct: 80, charging: false }, state: 'idle', faults: [] }));
    await new Promise((r) => setTimeout(r, 300));
    expect(app.get(FleetService).get(CODE)).toBeUndefined();
  });
});
