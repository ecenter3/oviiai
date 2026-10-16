/**
 * T-23 導航後端端對端：興趣點（含待命點）、區域、路徑、巡邏排程（BullMQ）。
 * 驗收：排程依時間自動建任務；被引用路徑不可刪。
 */
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Queue } from 'bullmq';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { hashPassword } from '../src/auth/password';
import { loadEnv } from '../src/config';
import { createDatabase, type Database } from '../src/db/database.module';
import { RobotRegistry } from '../src/fleet/robot-registry';
import { MqttService } from '../src/mqtt/mqtt.service';
import { PatrolService } from '../src/nav/patrol.service';
import { SettingsService } from '../src/settings/settings.service';

loadEnv();
const ready = !!(process.env.DATABASE_URL && process.env.REDIS_URL && process.env.MQTT_URL);
const tag = Date.now().toString(36).slice(-6);
const FLOOR = `n${tag}`;
const PW = 'Secret123';

async function until<T>(fn: () => T | Promise<T>, ms = 6000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('等待逾時');
    await new Promise((r) => setTimeout(r, 100));
  }
}

const taipei = (d: Date) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
const taipeiDay = (d: Date) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(d);

describe.skipIf(!ready)('導航後端與巡邏排程（e2e）', () => {
  let app: NestExpressApplication;
  let db: Database;
  let nav: string;
  let viewer: string;
  let robotId: string;
  let approvalBefore: unknown;
  const roles: string[] = [];
  const users: string[] = [];

  const http = () => request(app.getHttpServer());
  const as = (token: string, r: request.Test) => r.set('Authorization', `Bearer ${token}`);
  const patrol = () => app.get(PatrolService);
  const queue = () => (patrol() as unknown as { queue: Queue }).queue;

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

  async function makePath(name = '巡邏 A') {
    return (
      await as(nav, http().post('/api/v1/paths'))
        .send({ floorId: FLOOR, name, points: [{ x: 1, y: 1 }, { x: 4, y: 5 }, { x: 4, y: 10, dwellSec: 5 }] })
        .expect(201)
    ).body as { id: string; lengthM: number };
  }

  beforeAll(async () => {
    process.env.JWT_SECRET ||= 'e2e-secret-e2e-secret-e2e-secret-0';
    process.env.COOKIE_SECURE = 'false';
    db = createDatabase();
    await db.insertInto('floors').values({ id: FLOOR, name: `導航測試 ${FLOOR}`, sort: 99, width_m: '40', height_m: '20' }).execute();
    robotId = (
      await db
        .insertInto('robots')
        .values({ code: `N${tag}-1`.toUpperCase(), brand: 'anbot', model: 'ANBOT-Y', floor_id: FLOOR, adapter: `e2e-${tag}` })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    approvalBefore = (await db.selectFrom('settings').select('value').where('key', '=', 'dispatch.approval').executeTakeFirst())?.value;
    // 審批開啟：排程觸發的任務仍直接進佇列
    await db.updateTable('settings').set({ value: 'true' }).where('key', '=', 'dispatch.approval').execute();
    await db.updateTable('settings').set({ value: '"2099-12-31"' }).where('key', '=', 'dispatch.approvalUntil').execute();

    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.listen(0);
    await until(() => app.get(MqttService).connected);
    app.get(SettingsService).invalidate();
    await app.get(RobotRegistry).load();
    nav = await makeUser(['nav', 'dispatch', 'op.dispatch', 'monitor']);
    viewer = await makeUser(['monitor']);
  });

  afterAll(async () => {
    if (app) {
      for (const s of await db.selectFrom('patrol_schedules as s').innerJoin('paths as p', 'p.id', 's.path_id').select('s.id').where('p.floor_id', '=', FLOOR).execute()) {
        await patrol().unschedule(s.id);
      }
      await app.close();
    }
    if (db) {
      await db.updateTable('settings').set({ value: JSON.stringify(approvalBefore ?? true) }).where('key', '=', 'dispatch.approval').execute();
      await db.updateTable('settings').set({ value: '"2027-01-31"' }).where('key', '=', 'dispatch.approvalUntil').execute();
      await db.deleteFrom('patrol_schedules').where('path_id', 'in', db.selectFrom('paths').select('id').where('floor_id', '=', FLOOR)).execute();
      await db.deleteFrom('task_events').where('task_id', 'in', db.selectFrom('tasks').select('id').where('floor_id', '=', FLOOR)).execute();
      await db.deleteFrom('tasks').where('floor_id', '=', FLOOR).execute();
      await db.deleteFrom('task_templates').where('floor_id', '=', FLOOR).execute();
      await db.deleteFrom('alarms').where((eb) => eb.or([eb('robot_id', '=', robotId), eb('floor_id', '=', FLOOR)])).execute();
      await db.deleteFrom('paths').where('floor_id', '=', FLOOR).execute();
      await db.deleteFrom('pois').where('floor_id', '=', FLOOR).execute();
      await db.deleteFrom('zones').where('floor_id', '=', FLOOR).execute();
      await db.deleteFrom('robots').where('id', '=', robotId).execute();
      await db.deleteFrom('floors').where('id', '=', FLOOR).execute();
      await db.deleteFrom('op_logs').where('user_id', 'in', users).execute();
      await db.deleteFrom('users').where('id', 'in', users).execute();
      await db.deleteFrom('roles').where('id', 'in', roles).execute();
      await db.destroy();
    }
  });

  describe('興趣點、區域、路徑', () => {
    it('興趣點含待命點；超出樓層 400；被任務範本使用不可刪', async () => {
      await as(nav, http().post('/api/v1/pois')).send({ floorId: FLOOR, name: '外面', x: 41, y: 1 }).expect(400);
      const p = (await as(nav, http().post('/api/v1/pois')).send({ floorId: FLOOR, name: '待命區', x: 10, y: 3, kind: 'parking' }).expect(201)).body;
      expect(p.kind).toBe('parking');
      const q = (await as(nav, http().post('/api/v1/pois')).send({ floorId: FLOOR, name: '大門', x: 20, y: 2 }).expect(201)).body;
      const parking = (await as(viewer, http().get(`/api/v1/pois?floor=${FLOOR}&kind=parking`)).expect(200)).body;
      expect(parking.map((x: { name: string }) => x.name)).toEqual(['待命區']);
      await as(viewer, http().post('/api/v1/pois')).send({ floorId: FLOOR, name: 'x', x: 1, y: 1 }).expect(403);

      await as(nav, http().patch(`/api/v1/pois/${q.id}`)).send({ name: '正門', x: 21 }).expect(200);
      await db.insertInto('task_templates').values({ name: `${tag} 巡大門`, kind: 'inspect', priority: 'P3', floor_id: FLOOR, target: JSON.stringify({ poiId: q.id }) }).execute();
      const r = await as(nav, http().delete(`/api/v1/pois/${q.id}`)).expect(409);
      expect(r.body.error.message).toContain(`任務範本「${tag} 巡大門」`);
      await as(nav, http().delete(`/api/v1/pois/${p.id}`)).expect(204);
    });

    it('區域：至少 3 點、在樓層內', async () => {
      await as(nav, http().post('/api/v1/zones')).send({ floorId: FLOOR, name: '禁區', kind: 'forbidden', polygon: [[1, 1], [2, 2]] }).expect(400);
      await as(nav, http().post('/api/v1/zones')).send({ floorId: FLOOR, name: '禁區', kind: 'forbidden', polygon: [[1, 1], [2, 2], [50, 1]] }).expect(400);
      const z = (await as(nav, http().post('/api/v1/zones')).send({ floorId: FLOOR, name: '禁區', kind: 'forbidden', polygon: [[1, 1], [5, 1], [5, 4]] }).expect(201)).body;
      await as(nav, http().patch(`/api/v1/zones/${z.id}`)).send({ kind: 'slow' }).expect(200);
      const list = (await as(viewer, http().get(`/api/v1/zones?floor=${FLOOR}`)).expect(200)).body;
      expect(list).toEqual([{ id: z.id, floorId: FLOOR, name: '禁區', kind: 'slow', polygon: [[1, 1], [5, 1], [5, 4]] }]);
      await as(nav, http().delete(`/api/v1/zones/${z.id}`)).expect(204);
    });

    it('路徑：長度自動計算；被巡邏排程引用不可刪（409）；解除後可刪', async () => {
      const p = await makePath('巡邏 刪除測試');
      expect(p.lengthM).toBe(10);
      await as(nav, http().post('/api/v1/paths')).send({ floorId: FLOOR, name: '單點', points: [{ x: 1, y: 1 }] }).expect(400);
      const s = (await as(nav, http().post('/api/v1/patrol-schedules')).send({ name: '夜巡', pathId: p.id, startTime: '23:00', repeat: 'daily' }).expect(201)).body;
      const r = await as(nav, http().delete(`/api/v1/paths/${p.id}`)).expect(409);
      expect(r.body.error.message).toContain('巡邏排程「夜巡」');
      const list = (await as(viewer, http().get(`/api/v1/paths?floor=${FLOOR}`)).expect(200)).body;
      expect(list.find((x: { id: string }) => x.id === p.id)).toMatchObject({ lengthM: 10, schedules: 1 });
      await as(nav, http().delete(`/api/v1/patrol-schedules/${s.id}`)).expect(204);
      await as(nav, http().delete(`/api/v1/paths/${p.id}`)).expect(204);
    });
  });

  describe('巡邏排程', () => {
    it('建立每日排程 → BullMQ 排定下一次（台北時間）；停用移除、刪除移除', async () => {
      const p = await makePath();
      const s = (await as(nav, http().post('/api/v1/patrol-schedules')).send({ name: '早巡', pathId: p.id, startTime: '08:30', repeat: 'weekdays', loops: 2 }).expect(201)).body;
      expect(taipei(new Date(s.nextRunAt))).toBe('08:30');
      expect([1, 2, 3, 4, 5]).toContain(new Date(new Date(s.nextRunAt).getTime() + 8 * 3600_000).getUTCDay());
      expect((await queue().getJobScheduler(`patrol:${s.id}`))?.next).toBeTruthy();

      await as(nav, http().patch(`/api/v1/patrol-schedules/${s.id}`)).send({ enabled: false }).expect(200);
      expect((await queue().getJobScheduler(`patrol:${s.id}`))?.next ?? null).toBeNull();
      // 移除後 BullMQ 仍回傳只有 key 的空殼，看 next
      const row = (await as(nav, http().get(`/api/v1/patrol-schedules?floor=${FLOOR}`)).expect(200)).body.find((x: { id: string }) => x.id === s.id);
      expect(row).toMatchObject({ name: '早巡', pathName: '巡邏 A', startTime: '08:30', repeat: 'weekdays', loops: 2, enabled: false, nextRunAt: null });
      await as(nav, http().delete(`/api/v1/patrol-schedules/${s.id}`)).expect(204);
    });

    it('驗證：僅一次要日期且不在過去；機器人要在路徑的樓層', async () => {
      const p = await makePath('巡邏 驗證');
      await as(nav, http().post('/api/v1/patrol-schedules')).send({ name: 'x', pathId: p.id, startTime: '08:30', repeat: 'once' }).expect(400);
      await as(nav, http().post('/api/v1/patrol-schedules')).send({ name: 'x', pathId: p.id, startTime: '08:30', repeat: 'once', onceDate: '2020-01-01' }).expect(400);
      await as(nav, http().post('/api/v1/patrol-schedules')).send({ name: 'x', pathId: p.id, startTime: '25:00', repeat: 'daily' }).expect(400);
      const other = (await db.selectFrom('robots').select('id').where('floor_id', '!=', FLOOR).where('enabled', '=', true).executeTakeFirst())?.id;
      if (other) await as(nav, http().post('/api/v1/patrol-schedules')).send({ name: 'x', pathId: p.id, startTime: '08:30', repeat: 'daily', robotId: other }).expect(400);
    });

    it('立即執行：建立 source=schedule 的巡邏任務，審批開啟也直接進佇列；沒有 op.dispatch 不能執行', async () => {
      const p = await makePath('巡邏 立即');
      const s = (await as(nav, http().post('/api/v1/patrol-schedules')).send({ name: '臨時巡', pathId: p.id, startTime: '03:00', repeat: 'daily', loops: 3, priority: 'P2' }).expect(201)).body;
      const r = (await as(nav, http().post(`/api/v1/patrol-schedules/${s.id}/run`)).expect(201)).body;
      expect(r.status).toBe('queued');
      const t = await db.selectFrom('tasks').selectAll().where('id', '=', r.taskId).executeTakeFirstOrThrow();
      expect(t).toMatchObject({ kind: 'patrol', source: 'schedule', priority: 'P2', floor_id: FLOOR, target: { pathId: p.id, loops: 3 } });
      const row = (await as(nav, http().get(`/api/v1/patrol-schedules?floor=${FLOOR}`)).expect(200)).body.find((x: { id: string }) => x.id === s.id);
      expect(row.lastTask).toMatchObject({ code: r.taskCode });
      await as(viewer, http().post(`/api/v1/patrol-schedules/${s.id}/run`)).expect(403);
      const opt = (await as(nav, http().get(`/api/v1/patrol-schedules/options?floor=${FLOOR}`)).expect(200)).body;
      expect(opt.robots.map((r: { id: string }) => r.id)).toEqual([robotId]);
      await as(viewer, http().get('/api/v1/patrol-schedules/options')).expect(403);
    });

    it('遲到超過 30 分鐘不補跑；停用的排程不跑；僅一次觸發後自動停用', async () => {
      const p = await makePath('巡邏 補跑');
      const s = (await as(nav, http().post('/api/v1/patrol-schedules')).send({ name: '補跑測試', pathId: p.id, startTime: '04:00', repeat: 'daily' }).expect(201)).body;
      expect(await patrol().trigger(s.id, Date.now() - 31 * 60_000)).toBeNull();
      expect(await patrol().trigger(s.id, Date.now() - 29 * 60_000)).toMatchObject({ source: 'schedule' });

      await as(nav, http().patch(`/api/v1/patrol-schedules/${s.id}`)).send({ enabled: false }).expect(200);
      expect(await patrol().trigger(s.id)).toBeNull();

      const tomorrow = taipeiDay(new Date(Date.now() + 86_400_000));
      const once = (await as(nav, http().post('/api/v1/patrol-schedules')).send({ name: '一次', pathId: p.id, startTime: '10:00', repeat: 'once', onceDate: tomorrow }).expect(201)).body;
      expect((await queue().getDelayed()).some((j) => j.data.scheduleId === once.id)).toBe(true);
      expect(await patrol().trigger(once.id)).toBeTruthy();
      expect((await db.selectFrom('patrol_schedules').select('enabled').where('id', '=', once.id).executeTakeFirstOrThrow()).enabled).toBe(false);
    });

    it('依時間自動建任務（BullMQ 實際觸發，等到下一分鐘）', { timeout: 90_000 }, async () => {
      const p = await makePath('巡邏 定時');
      const at = new Date(Date.now() + 60_000);
      const s = (await as(nav, http().post('/api/v1/patrol-schedules')).send({ name: '定時', pathId: p.id, startTime: taipei(at), repeat: 'once', onceDate: taipeiDay(at) }).expect(201)).body;
      const row = await until(
        async () => db.selectFrom('patrol_schedules').select(['last_task_id', 'enabled']).where('id', '=', s.id).where('last_task_id', 'is not', null).executeTakeFirst(),
        80_000,
      );
      const t = await db.selectFrom('tasks').select(['source', 'kind', 'created_at']).where('id', '=', row!.last_task_id!).executeTakeFirstOrThrow();
      expect(t).toMatchObject({ source: 'schedule', kind: 'patrol' });
      expect(t.created_at.getTime()).toBeGreaterThanOrEqual(Math.floor(at.getTime() / 60_000) * 60_000);
      expect(row!.enabled).toBe(false);
    });

    it('指定的機器人不能執行：發三級「巡邏延後」告警一次；30 分鐘內仍未派出 → failed', async () => {
      const p = await makePath('巡邏 指定');
      const s = (await as(nav, http().post('/api/v1/patrol-schedules')).send({ name: '指定車', pathId: p.id, startTime: '05:00', repeat: 'daily', robotId }).expect(201)).body;
      const r = (await as(nav, http().post(`/api/v1/patrol-schedules/${s.id}/run`)).expect(201)).body;
      await patrol().sweep();
      await patrol().sweep();
      const alarms = await db.selectFrom('alarms').selectAll().where('type', '=', 'patrol_delayed').where('robot_id', '=', robotId).execute();
      expect(alarms).toHaveLength(1);
      expect(alarms[0]).toMatchObject({ level: 3, status: 'info' });
      expect(alarms[0].message).toContain(`${r.taskCode} 延後`);
      expect(alarms[0].message).toContain('離線');

      await patrol().sweep(Date.now() + 31 * 60_000);
      const t = await db.selectFrom('tasks').select(['status', 'fail_reason']).where('id', '=', r.taskId).executeTakeFirstOrThrow();
      expect(t.status).toBe('failed');
      expect(t.fail_reason).toContain('30 分鐘內無法執行（離線）');
    });

    it('啟動對齊：資料庫沒有的排程從 BullMQ 移除', async () => {
      await queue().upsertJobScheduler('patrol:00000000-0000-4000-8000-000000000000', { pattern: '0 1 * * *', tz: 'Asia/Taipei' }, { name: 'patrol', data: { scheduleId: '00000000-0000-4000-8000-000000000000' } });
      await patrol().sync();
      expect((await queue().getJobScheduler('patrol:00000000-0000-4000-8000-000000000000'))?.next ?? null).toBeNull();
    });
  });
});
