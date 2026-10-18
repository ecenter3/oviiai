/**
 * T-39 能耗管理、任務報告、運行日誌（e2e）。直接寫入遙測、狀態紀錄、充電紀錄、任務，驗證 API 的計算與權限。
 */
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { hashPassword } from '../src/auth/password';
import { loadEnv } from '../src/config';
import { createDatabase, type Database } from '../src/db/database.module';
import { clearOrphanPendingCommands } from './pending-commands';

loadEnv();
const ready = !!(process.env.DATABASE_URL && process.env.REDIS_URL && process.env.MQTT_URL);
const tag = `rp${Date.now().toString(36)}`;
const CODE = `RP-${tag}`.toUpperCase().slice(0, 32);
const PW = 'Secret123';
/** 基準時間：2 小時前整分 */
const T0 = new Date(Math.floor((Date.now() - 2 * 3600_000) / 60_000) * 60_000);
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

describe.skipIf(!ready)('能耗、任務報告、運行日誌（T-39，e2e）', () => {
  let app: NestExpressApplication;
  let db: Database;
  let robotId: string;
  let taskId: string;
  let poiId: string;
  const roles: string[] = [];
  const users: string[] = [];
  const tokens: Record<string, string> = {};

  const http = () => request(app.getHttpServer());
  const get = (who: string, url: string) => http().get(url).set('Authorization', `Bearer ${tokens[who]}`);
  const range = (a: number, b: number) => `from=${encodeURIComponent(at(a).toISOString())}&to=${encodeURIComponent(at(b).toISOString())}`;

  async function makeUser(name: string, perms: string[]) {
    const r = await db.insertInto('roles').values({ name: `${tag}-${name}`, perms }).returning('id').executeTakeFirstOrThrow();
    roles.push(r.id);
    const username = `${tag}-${name}`;
    const u = await db.insertInto('users').values({ username, display_name: name, password_hash: await hashPassword(PW), role_id: r.id }).returning('id').executeTakeFirstOrThrow();
    users.push(u.id);
    tokens[name] = (await http().post('/api/v1/auth/login').send({ username, password: PW }).expect(200)).body.accessToken;
  }

  beforeAll(async () => {
    process.env.JWT_SECRET ||= 'e2e-secret-e2e-secret-e2e-secret-0';
    process.env.COOKIE_SECURE = 'false';
    db = createDatabase();
    // 停用的機器人：不會上線、不會被派工，只用來放歷史資料
    robotId = (
      await db
        .insertInto('robots')
        .values({ code: CODE, brand: 'anbot', model: 'ANBOT-Y', floor_id: 'b1', adapter: `e2e-${tag}`, enabled: false })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    // 0～30 分：在 (0,0)→(30,0) 每分鐘走 1 m、電量 80→77；30～60 分充電 77→87（另有一筆 100 m 的跳點不計里程）
    const rows = [];
    for (let m = 0; m <= 60; m++) {
      const charging = m > 30;
      rows.push({
        at: at(m),
        robot_id: robotId,
        x: m <= 30 ? m : 30,
        y: 0,
        yaw: 0,
        battery: m <= 30 ? 80 - m * 0.1 : 77 + (m - 30) / 3,
        charging,
        state: charging ? 'charging' : 'patrolling',
        voltage: 48 + (charging ? 1 : 0),
        current: charging ? 5 : -1.5,
      });
    }
    // 跳點：45 分後 1 秒跳到 100 m 外、再 1 秒跳回（重新定位），速度遠超過 3 m/s
    const jump = (sec: number, y: number) => ({ ...rows[45], at: new Date(at(45).getTime() + sec * 1000), y });
    rows.push(jump(1, 100), jump(2, 0));
    await db.insertInto('telemetry').values(rows).execute();
    await db
      .insertInto('robot_state_log')
      .values([
        { at: at(-30), robot_id: robotId, state: 'idle', reason: null },
        { at: at(0), robot_id: robotId, state: 'patrolling', reason: null },
        { at: at(30), robot_id: robotId, state: 'charging', reason: null },
        { at: at(60), robot_id: robotId, state: 'offline', reason: 'timeout' },
      ])
      .execute();
    await db.insertInto('charge_sessions').values({ robot_id: robotId, mode: 'auto', started_at: at(30), ended_at: at(60), start_pct: 77, end_pct: 87 }).execute();
    poiId = (await db.insertInto('pois').values({ floor_id: 'b1', name: `報告測試點 ${tag}`, x: 30, y: 0 }).returning('id').executeTakeFirstOrThrow()).id;
    taskId = (
      await db
        .insertInto('tasks')
        .values({
          code: `T-${tag}`,
          kind: 'inspect',
          priority: 'P3',
          source: 'manual',
          floor_id: 'b1',
          target: JSON.stringify({ poiId }),
          robot_id: robotId,
          status: 'done',
          started_at: at(0),
          ended_at: at(30),
          note: `巡檢報告 ${tag}`,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;

    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();
    await makeUser('energy', ['energy']);
    await makeUser('reports', ['reports']);
    await makeUser('runlog', ['runlog']);
  });

  afterAll(async () => {
    await app?.close();
    if (db) {
      await db.deleteFrom('task_events').where('task_id', '=', taskId).execute();
      await db.deleteFrom('tasks').where('robot_id', '=', robotId).execute();
      await db.deleteFrom('pois').where('id', '=', poiId).execute();
      await db.deleteFrom('telemetry').where('robot_id', '=', robotId).execute();
      await db.deleteFrom('robot_state_log').where('robot_id', '=', robotId).execute();
      await db.deleteFrom('robots').where('id', '=', robotId).execute(); // charge_sessions ON DELETE CASCADE
      await db.deleteFrom('op_logs').where('user_id', 'in', users).execute();
      await db.deleteFrom('users').where('id', 'in', users).execute();
      await db.deleteFrom('roles').where('id', 'in', roles).execute();
      await clearOrphanPendingCommands(db);
      await db.destroy();
    }
  });

  it('能耗：曲線（電量、電壓、電流、耗電量）、充電紀錄與統計', async () => {
    const r = (await get('energy', `/api/v1/energy/${robotId}?${range(0, 61)}`).expect(200)).body;
    expect(r.code).toBe(CODE);
    expect(r.points.length).toBeGreaterThan(20);
    type P = { at: string; voltage: number; current: number; charging: boolean; consumption: number };
    const near = (m: number) => (r.points as P[]).reduce((a, b) => (Math.abs(+new Date(b.at) - +at(m)) < Math.abs(+new Date(a.at) - +at(m)) ? b : a));
    const walking = near(20);
    expect(walking).toMatchObject({ voltage: 48, current: -1.5, charging: false });
    expect(walking.consumption).toBeCloseTo(6, 0); // 每分鐘 0.1% → 6 %/h
    const charging = near(50);
    expect(charging.consumption).toBeLessThan(-15); // 充電為負（約 -20 %/h）
    expect(r.charges).toEqual([expect.objectContaining({ startPct: 77, endPct: 87, minutes: 30, mode: 'auto' })]);
    expect(r.summary).toMatchObject({ chargeCount: 1, chargeMinutes: 30, chargedPct: 10, chargeRatePctH: 20, usedPct: 3 });
  });

  it('任務報告：列表篩選、單筆報告（軌跡、里程不含跳點、目標名稱）', async () => {
    const list = (await get('reports', `/api/v1/reports/tasks?${range(-10, 120)}&robotId=${robotId}`).expect(200)).body;
    expect(list.total).toBe(1);
    expect(list.items[0]).toMatchObject({ id: taskId, robotCode: CODE, targetName: `報告測試點 ${tag}`, targetType: 'poi', status: 'done' });
    expect((await get('reports', `/api/v1/reports/tasks?${range(-10, 120)}&q=${encodeURIComponent(`報告測試點 ${tag}`)}`).expect(200)).body.total).toBe(1);
    expect((await get('reports', `/api/v1/reports/tasks?${range(-10, 120)}&q=nothing-${tag}`).expect(200)).body.total).toBe(0);
    expect((await get('reports', `/api/v1/reports/tasks?${range(5, 120)}&robotId=${robotId}`).expect(200)).body.total).toBe(0); // 依開始時間

    const rep = (await get('reports', `/api/v1/reports/tasks/${taskId}`).expect(200)).body;
    expect(rep).toMatchObject({ durationMs: 30 * 60_000, distanceM: 30, alarms: 0, snapshots: 0 });
    expect(rep.track[0]).toEqual({ x: 0, y: 0 });
    expect(rep.track.at(-1)).toEqual({ x: 30, y: 0 });

    // 軌跡 API：45 分的跳點（100 m）不算里程
    const tr = (await get('reports', `/api/v1/robots/${robotId}/track?${range(0, 61)}`).expect(200)).body;
    expect(tr.distanceM).toBe(30);
  });

  it('運行日誌：區間開始時持續中的狀態、每段起訖與時長、各狀態總時長', async () => {
    const r = (await get('runlog', `/api/v1/runlog/${robotId}?${range(-10, 45)}`).expect(200)).body;
    expect(r.entries.map((e: { state: string }) => e.state)).toEqual(['charging', 'patrolling', 'idle']); // 新的在前
    expect(r.entries[2]).toMatchObject({ at: at(-10).toISOString(), end: at(0).toISOString(), durationMs: 10 * 60_000 });
    expect(r.entries[0]).toMatchObject({ at: at(30).toISOString(), end: at(45).toISOString(), durationMs: 15 * 60_000 });
    expect(r.totals).toEqual({ idle: 10 * 60_000, patrolling: 30 * 60_000, charging: 15 * 60_000 });
  });

  it('權限與範圍檢查', async () => {
    await get('reports', `/api/v1/energy/${robotId}?${range(0, 60)}`).expect(403);
    await get('energy', `/api/v1/reports/tasks?${range(0, 60)}`).expect(403);
    await get('energy', `/api/v1/runlog/${robotId}?${range(0, 60)}`).expect(403);
    await get('runlog', `/api/v1/robots/${robotId}/track?${range(0, 60)}`).expect(403);
    await get('energy', `/api/v1/energy/${robotId}?${range(60, 0)}`).expect(400);
    await get('energy', `/api/v1/energy/${robotId}?from=${encodeURIComponent(at(0).toISOString())}&to=${encodeURIComponent(at(32 * 1440).toISOString())}`).expect(400);
    await get('energy', `/api/v1/energy/00000000-0000-4000-8000-000000000000?${range(0, 60)}`).expect(404);
    // 選機器人用的清單：有 energy／reports／runlog 任一權限就能讀
    await get('runlog', '/api/v1/robots').expect(200);
  });
});
