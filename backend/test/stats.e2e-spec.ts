/**
 * T-40 數據統計（e2e）：寫入兩天的狀態紀錄、遙測、任務、告警、對講紀錄，驗證統計、每日彙總存檔與 Excel 匯出。
 */
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import ExcelJS from 'exceljs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { hashPassword } from '../src/auth/password';
import { loadEnv } from '../src/config';
import { createDatabase, type Database } from '../src/db/database.module';
import { addDay, dayStart, taipeiDay } from '../src/stats/daily-stats.service';
import { clearOrphanPendingCommands } from './pending-commands';

loadEnv();
const ready = !!(process.env.DATABASE_URL && process.env.REDIS_URL && process.env.MQTT_URL);
const tag = `st${Date.now().toString(36)}`;
const FLOOR = tag.slice(-8);
const PW = 'Secret123';
const D1 = addDay(taipeiDay(), -2);
const D2 = addDay(taipeiDay(), -1);
/** 某天台北時間 hh:mm */
const at = (day: string, h: number, m = 0) => new Date(dayStart(day).getTime() + (h * 60 + m) * 60_000);

describe.skipIf(!ready)('數據統計（T-40，e2e）', () => {
  let app: NestExpressApplication;
  let db: Database;
  let robotId: string;
  let otherId: string;
  const roles: string[] = [];
  const users: string[] = [];
  let token = '';
  let noPerm = '';
  const http = () => request(app.getHttpServer());

  async function login(name: string, perms: string[]) {
    const r = await db.insertInto('roles').values({ name: `${tag}-${name}`, perms }).returning('id').executeTakeFirstOrThrow();
    roles.push(r.id);
    const username = `${tag}-${name}`;
    const u = await db.insertInto('users').values({ username, display_name: name, password_hash: await hashPassword(PW), role_id: r.id }).returning('id').executeTakeFirstOrThrow();
    users.push(u.id);
    return (await http().post('/api/v1/auth/login').send({ username, password: PW }).expect(200)).body.accessToken as string;
  }

  beforeAll(async () => {
    process.env.JWT_SECRET ||= 'e2e-secret-e2e-secret-e2e-secret-0';
    process.env.COOKIE_SECURE = 'false';
    db = createDatabase();
    await db.insertInto('floors').values({ id: FLOOR, name: `統計測試 ${FLOOR}`, sort: 99 }).execute();
    const mk = async (code: string) =>
      (await db.insertInto('robots').values({ code, brand: 'anbot', model: 'ANBOT-Y', floor_id: FLOOR, adapter: `e2e-${tag}`, enabled: false }).returning('id').executeTakeFirstOrThrow()).id;
    robotId = await mk(`ST-${tag}`.toUpperCase().slice(0, 32));
    otherId = await mk(`ST2-${tag}`.toUpperCase().slice(0, 32));
    // D1 前一天 22:00 開始待命；D1 08:00～10:00 巡邏、10:00～12:00 充電、12:00 起待命；D2 06:00 離線到隔天
    await db
      .insertInto('robot_state_log')
      .values([
        { at: at(addDay(D1, -1), 22), robot_id: robotId, state: 'idle', reason: null },
        { at: at(D1, 8), robot_id: robotId, state: 'patrolling', reason: null },
        { at: at(D1, 10), robot_id: robotId, state: 'charging', reason: null },
        { at: at(D1, 12), robot_id: robotId, state: 'idle', reason: null },
        { at: at(D2, 6), robot_id: robotId, state: 'offline', reason: 'telemetry_timeout' },
      ])
      .execute();
    // D1 08:00 起每分鐘走 1 m，共 60 m（另一筆 1 秒 100 m 的跳點不算）
    const tele = Array.from({ length: 61 }, (_, i) => ({ at: at(D1, 8, i), robot_id: robotId, x: i, y: 0, yaw: 0, battery: 80, charging: false, state: 'patrolling' }));
    tele.push({ ...tele[30], at: new Date(at(D1, 8, 30).getTime() + 1000), y: 100 }, { ...tele[30], at: new Date(at(D1, 8, 30).getTime() + 2000), y: 0 });
    await db.insertInto('telemetry').values(tele).execute();
    const task = (code: string, status: string, end: Date, robot = robotId) => ({
      code: `T-${tag}-${code}`,
      kind: 'inspect',
      priority: 'P3',
      source: 'manual',
      floor_id: FLOOR,
      target: JSON.stringify({ x: 1, y: 1 }),
      robot_id: robot,
      status,
      started_at: new Date(end.getTime() - 600_000),
      ended_at: end,
    });
    await db
      .insertInto('tasks')
      .values([task('1', 'done', at(D1, 9)), task('2', 'done', at(D1, 11)), task('3', 'failed', at(D2, 9)), task('4', 'cancelled', at(D2, 10)), task('5', 'done', at(D2, 3), otherId)])
      .execute();
    const alarm = (n: number, category: string, status: string, when: Date) => ({
      code: `A-${tag}-${n}`,
      type: category === 'business' ? 'intrusion' : 'offline',
      category,
      level: 2,
      floor_id: FLOOR,
      robot_id: robotId,
      message: 'e2e',
      status,
      occurred_at: when,
    });
    await db
      .insertInto('alarms')
      .values([alarm(1, 'business', 'closed', at(D1, 9)), alarm(2, 'business', 'open', at(D2, 9)), alarm(3, 'system', 'closed', at(D2, 7))])
      .execute();
    await db
      .insertInto('op_logs')
      .values([
        // at 在型別上不可寫入（預設 now()），測試要指定日期
        { at: at(D1, 9), username: `${tag}-op`, action: 'robot.talk_start', target: `robot:${robotId}`, detail: JSON.stringify({ ok: true }) } as never,
        { at: at(D2, 9), username: `${tag}-op`, action: 'robot.speak', target: `robot:${robotId}`, detail: JSON.stringify({ ok: true }) } as never,
        { at: at(D2, 9), username: `${tag}-op`, action: 'robot.speak', target: `robot:${robotId}`, detail: JSON.stringify({ ok: false }) } as never,
      ])
      .execute();

    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();
    token = await login('stats', ['stats']);
    noPerm = await login('none', ['monitor']);
  });

  afterAll(async () => {
    await app?.close();
    if (db) {
      await db.deleteFrom('tasks').where('floor_id', '=', FLOOR).execute();
      await db.deleteFrom('alarms').where('floor_id', '=', FLOOR).execute();
      await db.deleteFrom('op_logs').where('username', 'like', `${tag}-%`).execute();
      await db.deleteFrom('telemetry').where('robot_id', 'in', [robotId, otherId]).execute();
      await db.deleteFrom('robot_state_log').where('robot_id', 'in', [robotId, otherId]).execute();
      await db.deleteFrom('robots').where('floor_id', '=', FLOOR).execute(); // robot_daily_stats ON DELETE CASCADE
      await db.deleteFrom('floors').where('id', '=', FLOOR).execute();
      if (users.length) await db.deleteFrom('op_logs').where('user_id', 'in', users).execute();
      if (users.length) await db.deleteFrom('users').where('id', 'in', users).execute();
      if (roles.length) await db.deleteFrom('roles').where('id', 'in', roles).execute();
      await clearOrphanPendingCommands(db);
      await db.destroy();
    }
  });

  const get = (qs: string) => http().get(`/api/v1/stats/summary?${qs}`).set('Authorization', `Bearer ${token}`);

  it('單台：任務、告警、對講、里程、各狀態時長與稼動率（依日期）', async () => {
    const r = (await get(`from=${D1}&to=${D2}&robotId=${robotId}`).expect(200)).body;
    expect(r.robotCount).toBe(1);
    const [d1, d2] = r.days;
    expect(d1).toMatchObject({ date: D1, tasksDone: 2, alarmsBusiness: 1, alarmsSystem: 0, talks: 1, distanceM: 60, busyH: 2, chargingH: 2, idleH: 20, offlineH: 0 });
    expect(d1.utilization).toBeCloseTo(8.3, 1); // 2 / 24
    expect(d2).toMatchObject({ date: D2, tasksFailed: 1, tasksCancelled: 1, alarmsBusiness: 1, alarmsSystem: 1, talks: 1, idleH: 6, offlineH: 18, distanceM: 0 });
    expect(r.totals).toMatchObject({ tasksDone: 2, tasksFailed: 1, tasksCancelled: 1, alarmsBusiness: 2, alarmsSystem: 1, talks: 2, distanceM: 60, alarmStatus: { closed: 2, open: 1 } });
    expect(r.totals.availability).toBeCloseTo(62.5, 1); // 離線 18 h / 48 h
    // 過去的日子已算好存檔
    const stored = await db.selectFrom('robot_daily_stats').selectAll().where('robot_id', '=', robotId).orderBy('day').execute();
    expect(stored.map((s) => [s.day, s.busy_s, s.offline_s])).toEqual([
      [D1, 7200, 0],
      [D2, 0, 18 * 3600],
    ]);
  });

  it('依樓層：兩台合計，各機器人分列', async () => {
    const r = (await get(`from=${D1}&to=${D2}&floorId=${FLOOR}`).expect(200)).body;
    expect(r.robotCount).toBe(2);
    expect(r.totals.tasksDone).toBe(3);
    const other = r.robots.find((x: { id: string }) => x.id === otherId);
    expect(other).toMatchObject({ tasksDone: 1, distanceM: 0, utilization: null });
  });

  it('匯出 Excel：總覽、每日、各機器人', async () => {
    const res = await http()
      .get(`/api/v1/stats/export?from=${D1}&to=${D2}&floorId=${FLOOR}`)
      .set('Authorization', `Bearer ${token}`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(res.headers['content-disposition']).toContain(`stats-${D1.replace(/-/g, '')}-${D2.replace(/-/g, '')}.xlsx`);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['總覽', '每日', '各機器人']);
    const daily = wb.getWorksheet('每日')!;
    expect(daily.getRow(1).getCell(1).value).toBe('日期');
    expect(daily.getRow(2).getCell(1).value).toBe(D1);
    expect(daily.getRow(2).getCell(2).value).toBe(2);
    expect(wb.getWorksheet('總覽')!.getRow(3).getCell(2).value).toBe(`統計測試 ${FLOOR}`);
  });

  it('權限、日期檢查', async () => {
    await http().get(`/api/v1/stats/summary?from=${D1}&to=${D2}`).set('Authorization', `Bearer ${noPerm}`).expect(403);
    await get(`from=${D2}&to=${D1}`).expect(400);
    await get(`from=2020-01-01&to=${D2}`).expect(400);
    await get(`from=${D1}&to=${D2}&robotId=00000000-0000-4000-8000-000000000000`).expect(404);
  });
});
