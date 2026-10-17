/**
 * T-10 端對端：MQTT → fleet → Redis／TimescaleDB／WebSocket。
 * 需要真的 PostgreSQL、Redis、EMQX（make up && make migrate）；缺任何一個就略過。
 */
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import mqtt, { type MqttClient } from 'mqtt';
import type Redis from 'ioredis';
import { io, type Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { hashPassword } from '../src/auth/password';
import { loadEnv } from '../src/config';
import { createDatabase, type Database } from '../src/db/database.module';
import { FleetService } from '../src/fleet/fleet.service';
import { TelemetryWriter } from '../src/fleet/telemetry-writer';
import { MqttService } from '../src/mqtt/mqtt.service';
import { REDIS } from '../src/redis/redis.module';
import { testMqttAuth } from './mqtt-test-auth';

loadEnv();
const ready = !!(process.env.DATABASE_URL && process.env.REDIS_URL && process.env.MQTT_URL);
const tag = `fl${Date.now().toString(36)}`;
const CODE = `E2E-${tag}`;
const ADAPTER = `e2e-${tag}`;
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

describe.skipIf(!ready)('fleet（e2e）', () => {
  let app: NestExpressApplication;
  let db: Database;
  let pub: MqttClient;
  let url: string;
  let robotId: string;
  const users: string[] = [];
  const roles: string[] = [];
  let token: string;
  let noPermToken: string;
  const sockets: Socket[] = [];

  const tele = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      ts: Date.now(),
      pose: { x: 3, y: 4, yaw: 0, floor: '1f' },
      battery: { pct: 77, charging: false },
      state: 'idle',
      faults: [],
      ...over,
    });
  const publish = (topic: string, body: string) => pub.publishAsync(topic, body, { qos: 1 });

  async function makeUser(perms: string[]) {
    const r = await db.insertInto('roles').values({ name: `${tag}-${perms.join('+') || 'none'}`, perms }).returning('id').executeTakeFirstOrThrow();
    roles.push(r.id);
    const username = `${tag}-${roles.length}`;
    const u = await db
      .insertInto('users')
      .values({ username, display_name: username, password_hash: await hashPassword(PW), role_id: r.id })
      .returning('id')
      .executeTakeFirstOrThrow();
    users.push(u.id);
    const res = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ username, password: PW }).expect(200);
    return res.body.accessToken as string;
  }

  function connect(auth: Record<string, unknown>) {
    const s = io(url, { path: '/ws', auth, transports: ['websocket'], reconnection: false });
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
        .values({ code: CODE, brand: 'unitree', model: 'B2', floor_id: '1f', adapter: ADAPTER })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;

    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.listen(0);
    url = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;
    await until(() => app.get(MqttService).connected);

    pub = await mqtt.connectAsync(process.env.MQTT_URL!, { clientId: `e2e-pub-${tag}`, ...testMqttAuth() });
    token = await makeUser(['monitor']);
    noPermToken = await makeUser(['users']);
  });

  afterAll(async () => {
    for (const s of sockets) s.close();
    await pub?.endAsync();
    if (app) {
      await app.get<Redis>(REDIS).del(`robot:${CODE}`, `adapter:${ADAPTER}`);
      await app.close();
    }
    if (db) {
      await db.deleteFrom('telemetry').where('robot_id', '=', robotId).execute();
      await db.deleteFrom('robot_state_log').where('robot_id', '=', robotId).execute();
      // 離線等事件會經告警管線建告警：連同處理歷程一起清掉
      await db.deleteFrom('alarms').where('robot_id', '=', robotId).execute();
      await db.deleteFrom('robots').where('id', '=', robotId).execute();
      await db.deleteFrom('op_logs').where('user_id', 'in', users).execute();
      if (users.length) await db.deleteFrom('users').where('id', 'in', users).execute();
      if (roles.length) await db.deleteFrom('roles').where('id', 'in', roles).execute();
      await db.destroy();
    }
  });

  it('WebSocket 沒帶 token、權限不足都在連線時拒絕', async () => {
    const errOf = (s: Socket) => new Promise<{ data?: { code: string } }>((r) => s.on('connect_error', r));
    expect((await errOf(connect({}))).data?.code).toBe('UNAUTHENTICATED');
    expect((await errOf(connect({ token: 'garbage' }))).data?.code).toBe('UNAUTHENTICATED');
    expect((await errOf(connect({ token: noPermToken }))).data?.code).toBe('FORBIDDEN');
  });

  it('遙測 → Redis、WebSocket robot.state（只送訂閱的樓層）、robot_state_log', async () => {
    const s1 = connect({ token });
    const sB1 = connect({ token });
    const got: Record<string, unknown>[] = [];
    const gotB1: unknown[] = [];
    s1.on('robot.state', (m) => got.push(m));
    sB1.on('robot.state', (m) => gotB1.push(m));
    expect(await s1.emitWithAck('subscribe', { floors: ['1f'] })).toEqual({ ok: true, floors: ['1f'] });
    await sB1.emitWithAck('subscribe', { floors: ['b1'] });

    await publish(`rms/robot/${CODE}/telemetry`, tele());
    const m = await until(() => got.find((x) => x.code === CODE));
    expect(m).toMatchObject({ robotId, floor: '1f', x: 3, y: 4, battery: 77, state: 'idle', online: true });
    expect(gotB1.find((x) => (x as { code: string }).code === CODE)).toBeUndefined();

    const live = JSON.parse((await app.get<Redis>(REDIS).hget(`robot:${CODE}`, 'live'))!);
    expect(live).toMatchObject({ robotId, x: 3, online: true });

    const log = await until(() =>
      db.selectFrom('robot_state_log').selectAll().where('robot_id', '=', robotId).executeTakeFirst(),
    );
    expect(log).toMatchObject({ state: 'idle', reason: 'first_seen' });
  });

  it('訂閱時先送一次目前狀態（畫面不必等下一筆遙測）', async () => {
    const s = connect({ token });
    const got: { code: string }[] = [];
    s.on('robot.state', (m) => got.push(m));
    await s.emitWithAck('subscribe', { floors: ['1f'] });
    await until(() => got.some((x) => x.code === CODE));
  });

  it('遙測每秒最多一筆批次寫入 TimescaleDB', async () => {
    // 對齊到整秒，+0、+200、+400 ms 才保證落在同一秒
    const base = Math.ceil((Date.now() + 2000) / 1000) * 1000;
    for (const dt of [0, 200, 400, 1100]) await publish(`rms/robot/${CODE}/telemetry`, tele({ ts: base + dt }));
    await until(() => app.get(FleetService).get(CODE)?.ts === base + 1100);
    await app.get(TelemetryWriter).flush();
    const rows = await db.selectFrom('telemetry').select('at').where('robot_id', '=', robotId).where('at', '>=', new Date(base)).execute();
    expect(rows).toHaveLength(2);
  });

  it('轉接器 Last Will（alive=false）→ robot.online false、狀態 offline', async () => {
    const s = connect({ token });
    const online: { code: string; online: boolean }[] = [];
    s.on('robot.online', (m) => online.push(m));
    await s.emitWithAck('subscribe', { floors: ['1f'] });
    await publish(`rms/adapter/${ADAPTER}/status`, JSON.stringify({ name: ADAPTER, alive: false }));
    await until(() => online.find((x) => x.code === CODE && x.online === false));
    expect(app.get(FleetService).get(CODE)).toMatchObject({ online: false, state: 'offline' });
    const last = await db
      .selectFrom('robot_state_log')
      .selectAll()
      .where('robot_id', '=', robotId)
      .orderBy('at', 'desc')
      .executeTakeFirstOrThrow();
    expect(last).toMatchObject({ state: 'offline', reason: 'adapter_down' });

    // 再收到遙測就恢復
    await publish(`rms/robot/${CODE}/telemetry`, tele({ ts: Date.now() + 5000 }));
    await until(() => online.find((x) => x.code === CODE && x.online === true));
  });

  it('未登記的機器人代碼不會出現在畫面上', async () => {
    const s = connect({ token });
    const got: { code: string }[] = [];
    s.on('robot.state', (m) => got.push(m));
    await s.emitWithAck('subscribe', { floors: ['1f'] });
    await publish(`rms/robot/NOPE-${tag}/telemetry`, tele());
    await new Promise((r) => setTimeout(r, 300));
    expect(got.find((x) => x.code === `NOPE-${tag}`)).toBeUndefined();
  });

  it('連線時先收到一次 stats.tick（統計卡），內容含線上台數', async () => {
    const s = connect({ token });
    const stats = await new Promise<Record<string, number>>((r) => s.once('stats.tick', r));
    expect(stats).toEqual(
      expect.objectContaining({ total: expect.any(Number), online: expect.any(Number), working: expect.any(Number), todayTasks: expect.any(Number), openAlarms: expect.any(Number) }),
    );
  });

  it('攝影機、充電樁點位：有 monitor 權限可讀（不含 RTSP），沒有回 403', async () => {
    const cams = await request(app.getHttpServer()).get('/api/v1/cameras?floor=1f').set('Authorization', `Bearer ${token}`).expect(200);
    expect(Array.isArray(cams.body)).toBe(true);
    for (const c of cams.body) {
      expect(c.floorId).toBe('1f');
      expect(c).not.toHaveProperty('rtspUrl');
      expect(c).not.toHaveProperty('rtsp_url');
    }
    await request(app.getHttpServer()).get('/api/v1/chargers').set('Authorization', `Bearer ${token}`).expect(200);
    await request(app.getHttpServer()).get('/api/v1/cameras').set('Authorization', `Bearer ${noPermToken}`).expect(403);
  });

  it('健康檢查回報 db、redis、mqtt', async () => {
    const r = await request(app.getHttpServer()).get('/api/v1/health').expect(200);
    expect(r.body.checks).toMatchObject({ db: 'ok', redis: 'ok', mqtt: 'ok' });
  });
});
