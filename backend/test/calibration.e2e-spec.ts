/**
 * T-26 座標校正端對端。驗收：rmse > 0.5 m 不可儲存；可套用同組機器人。
 */
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type Redis from 'ioredis';
import mqtt, { type MqttClient } from 'mqtt';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { hashPassword } from '../src/auth/password';
import { apply } from '../src/calibration/affine';
import { loadEnv } from '../src/config';
import { createDatabase, type Database } from '../src/db/database.module';
import { FleetService } from '../src/fleet/fleet.service';
import { MqttService } from '../src/mqtt/mqtt.service';
import { REDIS } from '../src/redis/redis.module';
import { testMqttAuth } from './mqtt-test-auth';
import { clearOrphanPendingCommands } from './pending-commands';

loadEnv();
const ready = !!(process.env.DATABASE_URL && process.env.REDIS_URL && process.env.MQTT_URL);
const tag = Date.now().toString(36).slice(-6);
const FLOOR = `k${tag}`;
const ADAPTER = `e2e-${tag}`;
const ADAPTER_KEY = `adapter-key-${tag}-0123456789`;
const PW = 'Secret123';

/** 現場：機器人地圖旋轉 90°、平移 (30, 2) */
const truth = [0, -1, 30, 1, 0, 2];
const pair = (u: number, v: number, dx = 0) => {
  const p = apply(truth, u, v);
  return { u, v, x: Math.round((p.x + dx) * 1000) / 1000, y: Math.round(p.y * 1000) / 1000 };
};
const GOOD = [pair(0, 0), pair(10, 0), pair(0, 20), pair(12, 15, 0.2)];
const BAD = [pair(0, 0), pair(10, 0), pair(0, 20), pair(12, 15, 3)];

async function until<T>(fn: () => T | Promise<T>, ms = 6000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('等待逾時');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(!ready)('座標校正（e2e）', () => {
  let app: NestExpressApplication;
  let db: Database;
  let pub: MqttClient;
  let maps: string;
  let viewer: string;
  const roles: string[] = [];
  const users: string[] = [];
  const ids: Record<string, string> = {};
  const code = (n: number) => `K${tag}-${n}`.toUpperCase();

  const http = () => request(app.getHttpServer());
  const as = (token: string, r: request.Test) => r.set('Authorization', `Bearer ${token}`);

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
    process.env[`ADAPTER_KEY_${ADAPTER.toUpperCase().replace(/-/g, '_')}`] = ADAPTER_KEY;
    db = createDatabase();
    await db.insertInto('floors').values({ id: FLOOR, name: `校正測試 ${FLOOR}`, sort: 99, width_m: '50', height_m: '40' }).execute();
    for (const [n, brand] of [
      [1, 'anbot'],
      [2, 'anbot'],
      [3, 'unitree'],
    ] as const) {
      ids[n] = (
        await db
          .insertInto('robots')
          .values({ code: code(n), brand, model: 'X', floor_id: FLOOR, adapter: ADAPTER })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    }
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.listen(0);
    await until(() => app.get(MqttService).connected);
    pub = await mqtt.connectAsync(process.env.MQTT_URL!, { clientId: `e2e-cal-${tag}`, ...testMqttAuth() });
    maps = await makeUser(['maps']);
    viewer = await makeUser(['monitor']);
  });

  afterAll(async () => {
    await pub?.endAsync();
    if (app) {
      for (const n of [1, 2, 3]) await app.get<Redis>(REDIS).del(`robot:${code(n)}`);
      await app.close();
    }
    if (db) {
      const all = Object.values(ids);
      await db.deleteFrom('alarms').where('robot_id', 'in', all).execute();
      await db.deleteFrom('telemetry').where('robot_id', 'in', all).execute();
      await db.deleteFrom('robot_state_log').where('robot_id', 'in', all).execute();
      await db.deleteFrom('robots').where('id', 'in', all).execute(); // robot_map_calib ON DELETE CASCADE
      await db.deleteFrom('floors').where('id', '=', FLOOR).execute();
      await db.deleteFrom('op_logs').where('user_id', 'in', users).execute();
      await db.deleteFrom('users').where('id', 'in', users).execute();
      await db.deleteFrom('roles').where('id', 'in', roles).execute();
      await clearOrphanPendingCommands(db);
      await db.destroy();
    }
  });

  it('試算：點不足、共線回原因；分散的點回矩陣、RMSE、每點誤差', async () => {
    const few = (await as(maps, http().post(`/api/v1/robots/${ids[1]}/calibration/fit`)).send({ points: GOOD.slice(0, 2) }).expect(200)).body;
    expect(few).toMatchObject({ ok: false, reason: '至少要 3 組對應點' });
    const line = (await as(maps, http().post(`/api/v1/robots/${ids[1]}/calibration/fit`)).send({ points: [pair(0, 0), pair(1, 1), pair(2, 2)] }).expect(200)).body;
    expect(line.reason).toContain('共線');
    const r = (await as(maps, http().post(`/api/v1/robots/${ids[1]}/calibration/fit`)).send({ points: GOOD }).expect(200)).body;
    expect(r.ok).toBe(true);
    expect(r.rmseM).toBeLessThan(0.5);
    expect(r.residuals).toHaveLength(4);
    expect(Math.abs(r.rotationDeg - 90)).toBeLessThan(2); // 第 4 點有 0.2 m 偏差，角度略偏
  });

  it('RMSE 超過 0.5 m 不能儲存（400，附誤差）', async () => {
    const r = await as(maps, http().put(`/api/v1/robots/${ids[1]}/calibration`)).send({ mapId: 'b1-v1', points: BAD }).expect(400);
    expect(r.body.error.message).toContain('超過 0.5 m');
    expect(r.body.error.details.rmseM).toBeGreaterThan(0.5);
    expect(await db.selectFrom('robot_map_calib').select('robot_id').where('robot_id', '=', ids[1]).executeTakeFirst()).toBeUndefined();
  });

  it('儲存並套用同組（同樓層同品牌）；不同品牌不能套用；轉接器設定帶出矩陣', async () => {
    await as(maps, http().put(`/api/v1/robots/${ids[1]}/calibration`)).send({ mapId: 'b1-v1', points: GOOD, applyTo: [ids[3]] }).expect(400);
    const r = (await as(maps, http().put(`/api/v1/robots/${ids[1]}/calibration`)).send({ mapId: 'b1-v1', points: GOOD, applyTo: [ids[2]] }).expect(200)).body;
    expect(r.applied.sort()).toEqual([ids[1], ids[2]].sort());
    r.matrix.forEach((v: number, i: number) => expect(v).toBeCloseTo(truth[i], 1));

    const list = (await as(maps, http().get(`/api/v1/calibrations?floor=${FLOOR}`)).expect(200)).body;
    expect(list.map((x: { code: string; calib: { mapId: string } | null }) => [x.code, x.calib?.mapId ?? null])).toEqual([
      [code(1), 'b1-v1'],
      [code(2), 'b1-v1'],
      [code(3), null],
    ]);

    const cfg = (await http().get(`/api/v1/adapter-config/${ADAPTER}`).set('X-Adapter-Key', ADAPTER_KEY).expect(200)).body;
    const c1 = cfg.robots.find((x: { code: string }) => x.code === code(1));
    expect(c1.calib.mapId).toBe('b1-v1');
    expect(c1.calib.matrix).toEqual(r.matrix);
    expect(cfg.robots.find((x: { code: string }) => x.code === code(3)).calib).toBeNull();

    const log = await db.selectFrom('op_logs').select(['action', 'target']).where('user_id', '=', users[0]).where('action', '=', 'calibration.save').execute();
    expect(log.map((l) => l.target)).toContain(`robot:${ids[1]}`);
  });

  it('目前位置換回機器人地圖座標（帶入目前位置用）', async () => {
    // 轉接器已套用校正：回報的是平台座標 = truth(5, 8)
    const p = apply(truth, 5, 8);
    await pub.publishAsync(
      `rms/robot/${code(1)}/telemetry`,
      JSON.stringify({ ts: Date.now(), pose: { x: p.x, y: p.y, yaw: 0, floor: FLOOR }, battery: { pct: 80, charging: false }, state: 'idle', faults: [] }),
    );
    await until(() => app.get(FleetService).get(code(1))?.online);
    const g = (await as(maps, http().get(`/api/v1/robots/${ids[1]}/calibration`)).expect(200)).body;
    expect(g.calib.points).toHaveLength(4);
    expect(g.live.u).toBeCloseTo(5, 0);
    expect(g.live.v).toBeCloseTo(8, 0);
    expect(g.maxRmseM).toBe(0.5);
  });

  it('清除校正；沒有 maps 權限 403', async () => {
    await as(viewer, http().get(`/api/v1/robots/${ids[2]}/calibration`)).expect(403);
    await as(viewer, http().put(`/api/v1/robots/${ids[2]}/calibration`)).send({ mapId: 'x', points: GOOD }).expect(403);
    await as(maps, http().delete(`/api/v1/robots/${ids[2]}/calibration`)).expect(204);
    expect((await as(maps, http().get(`/api/v1/robots/${ids[2]}/calibration`)).expect(200)).body.calib).toBeNull();
  });
});
