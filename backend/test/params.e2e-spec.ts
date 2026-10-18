/**
 * T-27 機器人參數端對端：真的 PostgreSQL、Redis、EMQX；獨立樓層、兩台機器人＋假轉接器（只收 cmd、回 ack）。
 */
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { paramDefaults } from '@oviiai/contracts';
import mqtt, { type MqttClient } from 'mqtt';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { hashPassword } from '../src/auth/password';
import { loadEnv } from '../src/config';
import { createDatabase, type Database } from '../src/db/database.module';
import { FleetService } from '../src/fleet/fleet.service';
import { MqttService } from '../src/mqtt/mqtt.service';
import { testMqttAuth } from './mqtt-test-auth';
import { clearOrphanPendingCommands } from './pending-commands';

loadEnv();
const ready = !!(process.env.DATABASE_URL && process.env.REDIS_URL && process.env.MQTT_URL);
const tag = Date.now().toString(36).slice(-6);
const FLOOR = `p${tag}`;
const OTHER = `q${tag}`;
const PW = 'Secret123';

async function until<T>(fn: () => T | Promise<T>, ms = 6000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error('等待逾時');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(!ready)('機器人參數（e2e，T-27）', () => {
  let app: NestExpressApplication;
  let db: Database;
  let adapter: MqttClient;
  let viewer: string;
  let editor: string;
  const roles: string[] = [];
  const users: string[] = [];
  const robots: { id: string; code: string }[] = [];
  const cmds: { code: string; type: string; args: Record<string, unknown> }[] = [];
  const http = () => request(app.getHttpServer());
  const as = (t: string, r: request.Test) => r.set('Authorization', `Bearer ${t}`);
  const R = (n: number) => `P${tag}-${n}`.toUpperCase();

  const online = async (code: string, floor = FLOOR) => {
    await adapter.publishAsync(
      `rms/robot/${code}/telemetry`,
      JSON.stringify({ ts: Date.now(), pose: { x: 1, y: 1, yaw: 0, floor }, battery: { pct: 80, charging: false }, state: 'idle', faults: [] }),
    );
    await until(() => app.get(FleetService).get(code)?.online);
  };

  async function makeUser(perms: string[]) {
    const r = await db.insertInto('roles').values({ name: `${tag}-${perms.join('+')}`, perms }).returning('id').executeTakeFirstOrThrow();
    roles.push(r.id);
    const username = `${tag}-${roles.length}`;
    const u = await db
      .insertInto('users')
      .values({ username, display_name: username, password_hash: await hashPassword(PW), role_id: r.id })
      .returning('id')
      .executeTakeFirstOrThrow();
    users.push(u.id);
    return (await http().post('/api/v1/auth/login').send({ username, password: PW }).expect(200)).body.accessToken as string;
  }

  beforeAll(async () => {
    process.env.JWT_SECRET ||= 'e2e-secret-e2e-secret-e2e-secret-0';
    process.env.COOKIE_SECURE = 'false';
    db = createDatabase();
    await db.insertInto('floors').values([
      { id: FLOOR, name: `參數測試 ${FLOOR}`, sort: 99 },
      { id: OTHER, name: `參數測試 ${OTHER}`, sort: 99 },
    ]).execute();
    for (const [n, floor] of [
      [1, FLOOR],
      [2, FLOOR],
      [3, OTHER],
    ] as const) {
      const r = await db
        .insertInto('robots')
        .values({ code: R(n), brand: 'anbot', model: 'ANBOT-Y', floor_id: floor, adapter: `e2e-${tag}` })
        .returning(['id', 'code'])
        .executeTakeFirstOrThrow();
      robots.push(r);
    }
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.listen(0);
    await until(() => app.get(MqttService).connected);
    viewer = await makeUser(['params']);
    editor = await makeUser(['params', 'op.config']);

    adapter = await mqtt.connectAsync(process.env.MQTT_URL!, { clientId: `e2e-params-${tag}`, ...testMqttAuth() });
    await adapter.subscribeAsync(robots.map((r) => `rms/robot/${r.code}/cmd`), { qos: 1 });
    adapter.on('message', (topic, payload) => {
      const m = JSON.parse(payload.toString());
      const code = topic.split('/')[2];
      cmds.push({ code, type: m.type, args: m.args });
      void adapter.publishAsync(`rms/robot/${code}/ack`, JSON.stringify({ cmdId: m.cmdId, ts: Date.now(), status: 'done' }), { qos: 1 }).catch(() => undefined);
    });
  });

  afterAll(async () => {
    await adapter?.endAsync();
    await app?.close();
    if (db) {
      const ids = robots.map((r) => r.id);
      await db.deleteFrom('telemetry').where('robot_id', 'in', ids).execute();
      await db.deleteFrom('robot_state_log').where('robot_id', 'in', ids).execute();
      await db.deleteFrom('robots').where('id', 'in', ids).execute();
      await db.deleteFrom('floors').where('id', 'in', [FLOOR, OTHER]).execute();
      await db.deleteFrom('op_logs').where('user_id', 'in', users).execute();
      await db.deleteFrom('users').where('id', 'in', users).execute();
      await db.deleteFrom('roles').where('id', 'in', roles).execute();
      await clearOrphanPendingCommands(db);
      await db.destroy();
    }
  });

  it('GET：沒存過回預設值；要 params 權限', async () => {
    const r = (await as(viewer, http().get(`/api/v1/robots/${robots[0].id}/params`)).expect(200)).body;
    expect(r).toMatchObject({ code: R(1), floorId: FLOOR, chargeReturnAt: expect.any(Number) });
    expect(r.params.walk).toEqual(paramDefaults('walk'));
    expect(Object.keys(r.params)).toEqual(['walk', 'video', 'talk', 'ext']);
    const noPerm = await makeUser(['monitor']);
    await as(noPerm, http().get(`/api/v1/robots/${robots[0].id}/params`)).expect(403);
  });

  it('PUT：要 op.config；依子系統欄位驗證（範圍、選項、未知欄位、缺欄位）', async () => {
    const walk = paramDefaults('walk');
    await as(viewer, http().put(`/api/v1/robots/${robots[0].id}/params`)).send({ subsystem: 'walk', values: walk }).expect(403);
    const url = `/api/v1/robots/${robots[0].id}/params`;
    const bad = (await as(editor, http().put(url)).send({ subsystem: 'walk', values: { ...walk, speed: 2 } }).expect(400)).body;
    expect(JSON.stringify(bad.error.details)).toContain('values.speed');
    await as(editor, http().put(url)).send({ subsystem: 'walk', values: { ...walk, collide: '安全模式' } }).expect(400);
    await as(editor, http().put(url)).send({ subsystem: 'walk', values: { ...walk, x: 1 } }).expect(400);
    await as(editor, http().put(url)).send({ subsystem: 'walk', values: { speed: 1 } }).expect(400);
    await as(editor, http().put(url)).send({ subsystem: 'nope', values: walk }).expect(400);
  });

  it('儲存後送 set_params（四個子系統完整值）；離線的回 offline、上線時補送', async () => {
    await online(R(1));
    // 上線時會先補送一次（預設值）；等它送完再存，下面只看儲存送出的那一筆
    await until(() => cmds.find((c) => c.code === R(1) && c.type === 'set_params'));
    cmds.length = 0;
    const walk = { ...paramDefaults('walk'), speed: 0.6, collide: 'safe' };
    const r = (await as(editor, http().put(`/api/v1/robots/${robots[0].id}/params`)).send({ subsystem: 'walk', values: walk }).expect(200)).body;
    expect(r.sync).toBe('sent');
    expect(r.params.walk).toEqual(walk);
    const sent = await until(() => cmds.find((c) => c.code === R(1) && c.type === 'set_params'));
    expect(sent.args).toEqual({ params: { walk, video: paramDefaults('video'), talk: paramDefaults('talk'), ext: paramDefaults('ext') } });
    expect((await as(viewer, http().get(`/api/v1/robots/${robots[0].id}/params`)).expect(200)).body.params.walk).toEqual(walk);

    // 第 2 台離線：存了但沒送
    const talk = { ...paramDefaults('talk'), padVol: 40 };
    const r2 = (await as(editor, http().put(`/api/v1/robots/${robots[1].id}/params`)).send({ subsystem: 'talk', values: talk }).expect(200)).body;
    expect(r2.sync).toBe('offline');
    expect(cmds.some((c) => c.code === R(2))).toBe(false);
    await online(R(2));
    const resent = await until(() => cmds.find((c) => c.code === R(2) && c.type === 'set_params'));
    expect((resent.args.params as { talk: unknown }).talk).toEqual(talk);

    const log = await db.selectFrom('op_logs').select(['action', 'target']).where('user_id', 'in', users).where('action', 'like', 'robot.params.%').execute();
    expect(log).toContainEqual({ action: 'robot.params.walk', target: `robot:${robots[0].id}` });
  });

  it('套用同樓層：來源已存的子系統覆蓋同樓層全部機器人，其他子系統不變；別樓層不動', async () => {
    await online(R(1));
    await online(R(2));
    await new Promise((r) => setTimeout(r, 300)); // 上線補送的那幾筆先送完
    cmds.length = 0;
    const r = (await as(editor, http().post('/api/v1/robots/params/apply-floor')).send({ fromRobotId: robots[0].id, floorId: FLOOR, subsystem: 'walk' }).expect(200)).body;
    expect(r.updated).toBe(2);
    expect(r.results).toEqual([
      { code: R(1), sync: 'sent', cmdId: expect.stringMatching(/^c_/) },
      { code: R(2), sync: 'sent', cmdId: expect.stringMatching(/^c_/) },
    ]);
    const p2 = (await as(viewer, http().get(`/api/v1/robots/${robots[1].id}/params`)).expect(200)).body.params;
    expect(p2.walk).toMatchObject({ speed: 0.6, collide: 'safe' });
    expect(p2.talk.padVol).toBe(40); // 第 2 台自己的交互參數保留
    const p3 = (await as(viewer, http().get(`/api/v1/robots/${robots[2].id}/params`)).expect(200)).body.params;
    expect(p3.walk).toEqual(paramDefaults('walk'));
    await until(() => cmds.filter((c) => c.type === 'set_params').length === 2);

    await as(editor, http().post('/api/v1/robots/params/apply-floor')).send({ fromRobotId: robots[0].id, floorId: OTHER, subsystem: 'walk' }).expect(400);
    await as(viewer, http().post('/api/v1/robots/params/apply-floor')).send({ fromRobotId: robots[0].id, floorId: FLOOR, subsystem: 'walk' }).expect(403);
  });

  it('上線補送防抖：30 秒內反覆上下線只補送一次（PR #13 審查第 3 點）', async () => {
    await online(R(2));
    await new Promise((r) => setTimeout(r, 300));
    cmds.length = 0;
    for (let i = 0; i < 3; i++) {
      await adapter.publishAsync(`rms/robot/${R(2)}/online`, JSON.stringify({ online: false, ts: Date.now() }), { qos: 1 });
      await until(() => !app.get(FleetService).get(R(2))?.online);
      await online(R(2));
    }
    await new Promise((r) => setTimeout(r, 500));
    expect(cmds.filter((c) => c.code === R(2) && c.type === 'set_params')).toEqual([]);
  });

  it('GET /robots：只有 remote 或 params 權限也能列出機器人（遙控頁、參數頁的選單）', async () => {
    const remoteOnly = await makeUser(['remote', 'op.remote']);
    const list = (await as(remoteOnly, http().get(`/api/v1/robots?floor=${FLOOR}`)).expect(200)).body;
    expect(list.map((r: { code: string }) => r.code)).toEqual([R(1), R(2)]);
    await as(viewer, http().get(`/api/v1/robots?floor=${FLOOR}`)).expect(200);
  });
});
