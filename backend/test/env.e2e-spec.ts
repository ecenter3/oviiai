/**
 * T-41 環境監測、定點檢測（e2e）：遙測 sensors → env_readings（取樣、只收環境項目）→ 超標告警；
 * 檢測點進出記錄、頻率、立即檢測；閾值設定與權限。遙測直接呼叫 FleetService.handleTelemetry（不經 MQTT）。
 */
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type Redis from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { hashPassword } from '../src/auth/password';
import { loadEnv } from '../src/config';
import { createDatabase, type Database } from '../src/db/database.module';
import { EnvService } from '../src/env/env.service';
import { FleetService } from '../src/fleet/fleet.service';
import { REDIS } from '../src/redis/redis.module';
import { StorageService } from '../src/storage/storage.service';
import { FakeStorage } from './fake-storage';
import { clearOrphanPendingCommands } from './pending-commands';

loadEnv();
const ready = !!(process.env.DATABASE_URL && process.env.REDIS_URL && process.env.MQTT_URL);
const tag = Date.now().toString(36).slice(-6);
const FLOOR = `v${tag}`;
const PW = 'Secret123';
const GAS = `E${tag}-GAS`.toUpperCase();
const PLAIN = `E${tag}-NOE`.toUpperCase();

describe.skipIf(!ready)('環境監測、定點檢測（T-41，e2e）', () => {
  let app: NestExpressApplication;
  let db: Database;
  let fleet: FleetService;
  let env: EnvService;
  let viewer: string;
  let pointsUser: string;
  let dispatcher: string;
  let setter: string;
  let none: string;
  const roles: string[] = [];
  const users: string[] = [];
  const ids: Record<string, string> = {};
  let poiId = '';
  let poi2 = '';
  let t = Date.now() - 10 * 60_000;
  const http = () => request(app.getHttpServer());
  const as = (tok: string, r: request.Test) => r.set('Authorization', `Bearer ${tok}`);

  async function makeUser(perms: string[]) {
    const r = await db.insertInto('roles').values({ name: `${tag}-${roles.length}-${perms.join('+')}`, perms }).returning('id').executeTakeFirstOrThrow();
    roles.push(r.id);
    const username = `${tag}-${roles.length}`;
    const u = await db.insertInto('users').values({ username, display_name: username, password_hash: await hashPassword(PW), role_id: r.id }).returning('id').executeTakeFirstOrThrow();
    users.push(u.id);
    return (await http().post('/api/v1/auth/login').send({ username, password: PW }).expect(200)).body.accessToken as string;
  }

  /** 送一筆遙測（時間每次往後 1 秒） */
  async function tel(code: string, x: number, y: number, sensors?: Record<string, { value: number; unit: string }>, step = 1000) {
    t += step;
    await fleet.handleTelemetry(code, { ts: t, pose: { x, y, yaw: 0, floor: FLOOR }, battery: { pct: 80, charging: false }, state: 'idle', faults: [], ...(sensors && { sensors }) }, t);
  }
  const s = (temp: number, extra: Record<string, number> = {}) => ({
    temp: { value: temp, unit: '°C' },
    humidity: { value: 50, unit: '%' },
    odom_total_m: { value: 1234, unit: 'm' },
    ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, { value: v, unit: k === 'o2' ? '%' : 'ppm' }])),
  });
  const readings = (robot: string, pointNull = true) => {
    let q = db.selectFrom('env_readings').selectAll().where('robot_id', '=', ids[robot]).orderBy('at');
    q = pointNull ? q.where('point_id', 'is', null) : q.where('point_id', 'is not', null);
    return q.execute();
  };
  const alarmsOf = (robot: string) => db.selectFrom('alarms').selectAll().where('robot_id', '=', ids[robot]).orderBy('code').execute();

  beforeAll(async () => {
    process.env.JWT_SECRET ||= 'e2e-secret-e2e-secret-e2e-secret-0';
    process.env.COOKIE_SECURE = 'false';
    db = createDatabase();
    await db.insertInto('floors').values({ id: FLOOR, name: `T41 ${FLOOR}`, sort: 99, width_m: 50, height_m: 40 }).execute();
    ids[GAS] = (await db.insertInto('robots').values({ code: GAS, brand: 'deep', model: 'X30', floor_id: FLOOR, adapter: `e2e-${tag}`, caps: ['env'] }).returning('id').executeTakeFirstOrThrow()).id;
    ids[PLAIN] = (await db.insertInto('robots').values({ code: PLAIN, brand: 'deep', model: 'X30', floor_id: FLOOR, adapter: `e2e-${tag}`, caps: [] }).returning('id').executeTakeFirstOrThrow()).id;
    poiId = (await db.insertInto('pois').values({ floor_id: FLOOR, name: `${tag} 配電室`, x: 20, y: 20 }).returning('id').executeTakeFirstOrThrow()).id;
    poi2 = (await db.insertInto('pois').values({ floor_id: FLOOR, name: `${tag} 機房`, x: 40, y: 5 }).returning('id').executeTakeFirstOrThrow()).id;
    const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(StorageService).useValue(new FakeStorage()).compile();
    app = mod.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.listen(0);
    fleet = app.get(FleetService);
    env = app.get(EnvService);
    viewer = await makeUser(['env']);
    pointsUser = await makeUser(['points', 'nav']);
    dispatcher = await makeUser(['points', 'op.dispatch']);
    setter = await makeUser(['alarmset']);
    none = await makeUser(['monitor']);
  });

  afterAll(async () => {
    if (app) {
      await app.get<Redis>(REDIS).del(...Object.keys(ids).map((c) => `robot:${c}`));
      await app.close();
    }
    if (db) {
      const rids = Object.values(ids);
      await db.deleteFrom('env_readings').where('robot_id', 'in', rids).execute();
      await db.deleteFrom('alarm_events').where('alarm_id', 'in', db.selectFrom('alarms').select('id').where('floor_id', '=', FLOOR)).execute();
      await db.deleteFrom('alarms').where('floor_id', '=', FLOOR).execute();
      await db.deleteFrom('task_events').where('task_id', 'in', db.selectFrom('tasks').select('id').where('floor_id', '=', FLOOR)).execute();
      await db.deleteFrom('tasks').where('floor_id', '=', FLOOR).execute();
      await db.deleteFrom('inspection_points').where('poi_id', 'in', [poiId, poi2]).execute();
      await db.deleteFrom('pois').where('floor_id', '=', FLOOR).execute();
      await db.deleteFrom('telemetry').where('robot_id', 'in', rids).execute();
      await db.deleteFrom('robot_state_log').where('robot_id', 'in', rids).execute();
      await db.deleteFrom('robots').where('id', 'in', rids).execute();
      await db.deleteFrom('floors').where('id', '=', FLOOR).execute();
      await db.deleteFrom('op_logs').where('user_id', 'in', users).execute();
      await db.deleteFrom('users').where('id', 'in', users).execute();
      await db.deleteFrom('roles').where('id', 'in', roles).execute();
      await clearOrphanPendingCommands(db);
      await db.destroy();
    }
  });

  it('只收環境項目、每 30 秒取樣一筆；超標期間每 2 秒一筆', async () => {
    for (let i = 0; i < 5; i++) await tel(PLAIN, 1, 1, s(25 + i * 0.1));
    await env.drain();
    let rows = await readings(PLAIN);
    expect(rows.map((r) => r.kind).sort()).toEqual(['humidity', 'temp']); // 沒有 odom_total_m
    expect(rows.find((r) => r.kind === 'temp')).toMatchObject({ value: 25, unit: '°C', floor_id: FLOOR, x: 1, y: 1 });
    await tel(PLAIN, 1, 1, s(25.5), 30_000);
    await env.drain();
    rows = await readings(PLAIN);
    expect(rows.filter((r) => r.kind === 'temp').map((r) => r.value)).toEqual([25, 25.5]);
    // 沒有 sensors 的遙測不影響
    await tel(PLAIN, 1, 1);
    await env.drain();
    expect((await readings(PLAIN)).length).toBe(4);
  });

  it('連續 2 筆超出閾值才發業務告警（gas、temp_humidity），回到範圍內才會再發', async () => {
    await tel(GAS, 2, 2, s(25, { co: 50, o2: 20.9 }));
    await env.drain();
    expect(await alarmsOf(GAS)).toEqual([]); // 只有 1 筆超標
    await tel(GAS, 2, 2, s(25, { co: 52.4, o2: 18 }));
    await tel(GAS, 2, 2, s(25, { co: 60, o2: 17.5 }));
    await env.drain();
    let al = await alarmsOf(GAS);
    expect(al.map((a) => [a.type, a.category, a.message])).toEqual([
      ['gas', 'business', `${GAS} 一氧化碳 52.4 ppm，超過上限 35 ppm`],
      ['gas', 'business', `${GAS} 氧氣 17.5 %，低於下限 19.5 %`],
    ]);
    expect(al[0].ext).toMatchObject({ env: { kind: 'co', value: 52.4, unit: 'ppm', max: 35 } });
    expect(al[0]).toMatchObject({ floor_id: FLOOR, x: 2, y: 2, level: 2, status: 'open' });
    // 超標期間每 2 秒存一筆（第 1、3 筆；第 2 筆距上一筆只有 1 秒）
    expect((await readings(GAS)).filter((r) => r.kind === 'co').map((r) => r.value)).toEqual([50, 60]);

    // 回到範圍內，再超標：同來源 60 秒內由告警管線合併（repeat_count）
    await tel(GAS, 2, 2, s(25, { co: 5, o2: 20.9 }));
    await tel(GAS, 2, 2, s(41, { co: 40, o2: 20.9 }));
    await tel(GAS, 2, 2, s(42, { co: 41, o2: 20.9 }), 2000); // 超標期間 2 秒一筆：這筆會存
    await env.drain();
    al = await alarmsOf(GAS);
    expect(al.map((a) => [a.type, a.repeat_count])).toEqual([
      ['gas', 2],
      ['gas', 1],
      ['temp_humidity', 1],
    ]);
    expect(al[2].message).toBe(`${GAS} 溫度 42 °C，超過上限 35 °C`);
  });

  it('閾值：讀取（env、points、alarmset），修改要 alarmset；下限要小於上限、告警類型要是業務告警', async () => {
    const list = (await as(viewer, http().get('/api/v1/env/thresholds')).expect(200)).body as { kind: string; max: number | null; min: number | null; alarmType: string | null }[];
    expect(list.slice(0, 3).map((x) => x.kind)).toEqual(['temp', 'humidity', 'co']);
    expect(list.find((x) => x.kind === 'o2')).toMatchObject({ min: 19.5, max: 23.5, alarmType: 'gas' });
    const pm = list.find((x) => x.kind === 'pm25')!;
    await as(viewer, http().put('/api/v1/env/thresholds')).send([{ kind: 'pm25', min: null, max: 50, alarmType: null }]).expect(403);
    await as(setter, http().put('/api/v1/env/thresholds')).send([{ kind: 'pm25', min: 60, max: 50, alarmType: null }]).expect(400);
    await as(setter, http().put('/api/v1/env/thresholds')).send([{ kind: 'pm25', min: null, max: 50, alarmType: 'battery_low' }]).expect(400);
    await as(setter, http().put('/api/v1/env/thresholds')).send([{ kind: 'radon', min: null, max: 50, alarmType: null }]).expect(400);
    try {
      const r = (await as(setter, http().put('/api/v1/env/thresholds')).send([{ kind: 'pm25', min: null, max: 50, alarmType: 'gas' }]).expect(200)).body;
      expect(r.find((x: { kind: string }) => x.kind === 'pm25')).toMatchObject({ max: 50, alarmType: 'gas' });
      // 立刻生效
      await tel(PLAIN, 3, 3, { pm25: { value: 80, unit: 'µg/m³' } });
      await tel(PLAIN, 3, 3, { pm25: { value: 81, unit: 'µg/m³' } });
      await env.drain();
      expect((await alarmsOf(PLAIN)).map((a) => a.message)).toEqual([`${PLAIN} PM2.5 81 µg/m³，超過上限 50 µg/m³`]);
      expect(await db.selectFrom('op_logs').select('action').where('action', '=', 'env.thresholds').where('user_id', 'in', users).execute()).not.toHaveLength(0);
    } finally {
      await as(setter, http().put('/api/v1/env/thresholds')).send([{ kind: 'pm25', min: pm.min, max: pm.max, alarmType: pm.alarmType }]).expect(200);
    }
    await as(none, http().get('/api/v1/env/thresholds')).expect(403);
  });

  it('環境監測頁：趨勢、目前數值（含超標）、超標告警次數；平面圖依格子標示', async () => {
    const from = new Date(Date.now() - 3_600_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();
    const q = `floorId=${FLOOR}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    const sum = (await as(viewer, http().get(`/api/v1/env/summary?${q}`)).expect(200)).body;
    expect(sum.series.map((x: { kind: string }) => x.kind)).toEqual(['temp', 'humidity', 'co', 'o2', 'pm25']);
    const temp = sum.series[0].points as { avg: number; max: number }[];
    expect(Math.max(...temp.map((p) => p.max))).toBe(42);
    const gas = sum.latest.find((x: { code: string }) => x.code === GAS);
    expect(gas.values.temp).toMatchObject({ value: 42, unit: '°C', over: 'high' });
    expect(gas.values.co).toMatchObject({ value: 41, over: 'high' });
    expect(gas.values.humidity.over).toBeNull();
    expect(sum.alarms).toMatchObject({ co: 1, o2: 1, temp: 1 });
    expect(sum.alarmTotal).toBeGreaterThanOrEqual(3);

    const map = (await as(viewer, http().get(`/api/v1/env/map?${q}&kind=temp&cell=4`)).expect(200)).body;
    expect(map).toMatchObject({ kind: 'temp', unit: '°C', cell: 4 });
    expect(map.cells.find((c: { x: number; y: number }) => c.x === 2 && c.y === 2)).toMatchObject({ max: 42, over: 'high' });
    expect(map.cells.find((c: { x: number; y: number }) => c.x === 2 && c.y === 2).n).toBeGreaterThan(1);
    await as(viewer, http().get(`/api/v1/env/map?${q}&kind=radon`)).expect(400);
    await as(viewer, http().get(`/api/v1/env/summary?floorId=${FLOOR}&from=${encodeURIComponent(to)}&to=${encodeURIComponent(from)}`)).expect(400);
    await as(none, http().get(`/api/v1/env/summary?${q}`)).expect(403);
  });

  describe('定點檢測', () => {
    let pid = '';
    it('新增、重複、改頻率；興趣點被檢測點使用時不能刪', async () => {
      await as(viewer, http().post('/api/v1/env/points')).send({ poiId, freq: 'pass' }).expect(403);
      const p = (await as(pointsUser, http().post('/api/v1/env/points')).send({ poiId, freq: 'pass', radiusM: 2 }).expect(201)).body;
      pid = p.id;
      expect(p).toMatchObject({ name: `${tag} 配電室`, floorId: FLOOR, x: 20, y: 20, freq: 'pass', radiusM: 2, status: 'none', lastAt: null });
      await as(pointsUser, http().post('/api/v1/env/points')).send({ poiId, freq: '1h' }).expect(409);
      await as(pointsUser, http().post('/api/v1/env/points')).send({ poiId: '00000000-0000-4000-8000-000000000000' }).expect(400);
      const del = await as(pointsUser, http().delete(`/api/v1/pois/${poiId}`)).expect(409);
      expect(del.body.error.message).toContain('定點檢測點');
    });

    it('每次經過：進入半徑內記一筆，離開再進來再記；超標顯示在檢測點', async () => {
      await tel(PLAIN, 10, 10, s(26));
      await tel(PLAIN, 19, 19.5, s(26.5)); // 進入
      await tel(PLAIN, 20, 20, s(27)); // 還在裡面，不記
      await tel(PLAIN, 25, 25, s(27));
      await tel(PLAIN, 20.5, 20, s(36)); // 再進來
      await env.drain();
      const rows = await readings(PLAIN, false);
      expect(rows.filter((r) => r.kind === 'temp').map((r) => [r.value, r.point_id])).toEqual([
        [26.5, pid],
        [36, pid],
      ]);
      const list = (await as(pointsUser, http().get(`/api/v1/env/points?floorId=${FLOOR}`)).expect(200)).body;
      expect(list[0]).toMatchObject({ id: pid, status: 'over', lastRobot: PLAIN, values: { temp: { value: 36, over: 'high' }, humidity: { value: 50, over: null } } });
      const from = new Date(Date.now() - 3_600_000).toISOString();
      const to = new Date(Date.now() + 60_000).toISOString();
      const h = (await as(pointsUser, http().get(`/api/v1/env/points/${pid}/readings?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)).expect(200)).body;
      expect(h.total).toBe(2);
      expect(h.items[0]).toMatchObject({ robotCode: PLAIN, values: { temp: 36, humidity: 50 } });
    });

    it('每 1 小時：停在點上也只在超過間隔後再記；停用的檢測點不記', async () => {
      await as(pointsUser, http().patch(`/api/v1/env/points/${pid}`)).send({ freq: '1h' }).expect(200);
      const before = (await readings(PLAIN, false)).length;
      await tel(PLAIN, 30, 30, s(25));
      await tel(PLAIN, 20, 20, s(25)); // 上一筆不到 1 小時：不記
      await env.drain();
      expect((await readings(PLAIN, false)).length).toBe(before);
      await tel(PLAIN, 20, 20, s(25.2), 3_600_000); // 停在點上超過 1 小時：記
      await env.drain();
      expect((await readings(PLAIN, false)).length).toBe(before + 2);
      await as(pointsUser, http().patch(`/api/v1/env/points/${pid}`)).send({ freq: 'pass', enabled: false }).expect(200);
      await tel(PLAIN, 30, 30, s(25));
      await tel(PLAIN, 20, 20, s(25));
      await env.drain();
      expect((await readings(PLAIN, false)).length).toBe(before + 2);
      await as(pointsUser, http().patch(`/api/v1/env/points/${pid}`)).send({ enabled: true, freq: '4h' }).expect(200);
    });

    it('立即檢測：派 env 任務到興趣點（指定沒有 env 能力的機器人 400）；到達時不論頻率都記', async () => {
      await as(pointsUser, http().post(`/api/v1/env/points/${pid}/measure`)).send({}).expect(403);
      await as(dispatcher, http().post(`/api/v1/env/points/${pid}/measure`)).send({ robotId: ids[PLAIN] }).expect(400);
      const r = (await as(dispatcher, http().post(`/api/v1/env/points/${pid}/measure`)).send({ robotId: ids[GAS] }).expect(201)).body;
      const task = await db.selectFrom('tasks').selectAll().where('id', '=', r.taskId).executeTakeFirstOrThrow();
      expect(task).toMatchObject({ kind: 'env', priority: 'P3', floor_id: FLOOR, robot_id: ids[GAS], note: `定點檢測 ${tag} 配電室` });
      expect(task.target).toEqual({ poiId });
      expect((await as(dispatcher, http().get(`/api/v1/env/points?floorId=${FLOOR}`)).expect(200)).body[0].measuring).toBe(true);
      const before = (await readings(GAS, false)).length;
      await tel(GAS, 21, 21, s(24)); // 頻率 4 小時、上一筆不久前，但立即檢測：記
      await env.drain();
      expect((await readings(GAS, false)).length).toBe(before + 2);
      expect((await as(dispatcher, http().get(`/api/v1/env/points?floorId=${FLOOR}`)).expect(200)).body[0]).toMatchObject({ measuring: false, lastRobot: GAS });
    });

    it('刪除檢測點後興趣點可刪；權限', async () => {
      await as(none, http().get('/api/v1/env/points')).expect(403);
      // 定點檢測頁新增時要選興趣點
      expect((await as(dispatcher, http().get(`/api/v1/pois?floor=${FLOOR}`)).expect(200)).body.length).toBe(2);
      await as(pointsUser, http().delete(`/api/v1/env/points/${pid}`)).expect(204);
      await as(pointsUser, http().delete(`/api/v1/env/points/${pid}`)).expect(404);
      await as(pointsUser, http().delete(`/api/v1/pois/${poi2}`)).expect(204);
    });
  });
});
