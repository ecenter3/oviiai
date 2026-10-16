/**
 * T-21 告警管線端對端：真的 PostgreSQL、Redis、EMQX；獨立測試樓層＋1 台假機器人。
 * 驗收：非法轉換回 409；同事件 60 秒內合併；系統告警規則（離線、急停、故障、低電量、訊號偏弱、指令失敗、P1 無車、充電）。
 */
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type Redis from 'ioredis';
import mqtt, { type MqttClient } from 'mqtt';
import { io, type Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AlarmSourcesService } from '../src/alarms/alarm-sources.service';
import { type AlarmNew, AlarmsService, type AlarmUpdated } from '../src/alarms/alarms.service';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { hashPassword } from '../src/auth/password';
import { ChargingService } from '../src/charging/charging.service';
import { loadEnv } from '../src/config';
import { createDatabase, type Database } from '../src/db/database.module';
import { FleetService } from '../src/fleet/fleet.service';
import { RobotRegistry } from '../src/fleet/robot-registry';
import { MqttService } from '../src/mqtt/mqtt.service';
import { REDIS } from '../src/redis/redis.module';
import { RetentionService } from '../src/maintenance/retention.service';
import { SettingsService } from '../src/settings/settings.service';
import { StorageService } from '../src/storage/storage.service';
import { FakeStorage } from './fake-storage';

loadEnv();
const ready = !!(process.env.DATABASE_URL && process.env.REDIS_URL && process.env.MQTT_URL);
const tag = Date.now().toString(36).slice(-6);
const FLOOR = `a${tag}`;
const CODE = `A${tag}-1`;
const PW = 'Secret123';

async function until<T>(fn: () => T | Promise<T>, ms = 6000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('等待逾時');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(!ready)('告警管線（e2e）', () => {
  let app: NestExpressApplication;
  let db: Database;
  let adapter: MqttClient;
  let url: string;
  let robotId: string;
  let full: string;
  let sysOnly: string;
  const roles: string[] = [];
  const users: string[] = [];
  const sockets: Socket[] = [];
  const storage = new FakeStorage();
  const bot = { x: 10, y: 5, battery: 80, state: 'idle', rssi: -50 as number | null, faults: [] as unknown[], failCmd: false };

  const http = () => request(app.getHttpServer());
  const as = (token: string, r: request.Test) => r.set('Authorization', `Bearer ${token}`);
  const alarms = () => app.get(AlarmsService);
  const sources = () => app.get(AlarmSourcesService);
  const tele = () =>
    adapter.publishAsync(
      `rms/robot/${CODE}/telemetry`,
      JSON.stringify({
        ts: Date.now(),
        pose: { x: bot.x, y: bot.y, yaw: 0, floor: FLOOR },
        battery: { pct: bot.battery, charging: false },
        state: bot.state,
        ...(bot.rssi === null ? {} : { net: { rssi: bot.rssi } }),
        faults: bot.faults,
      }),
    );
  async function setBot(over: Partial<typeof bot>) {
    Object.assign(bot, over);
    await tele();
    await until(() => {
      const l = app.get(FleetService).get(CODE);
      return l?.online && l.state === bot.state && l.battery === bot.battery && l.rssi === bot.rssi && l.faults.length === bot.faults.length;
    });
  }
  const ofType = (type: string) =>
    db.selectFrom('alarms').selectAll().where('floor_id', '=', FLOOR).where('type', '=', type).orderBy('occurred_at', 'desc').execute();

  async function makeUser(perms: string[]) {
    const r = await db.insertInto('roles').values({ name: `${tag}-${perms.join('+')}`, perms }).returning('id').executeTakeFirstOrThrow();
    roles.push(r.id);
    const username = `${tag}-${roles.length}`;
    const u = await db
      .insertInto('users')
      .values({ username, display_name: `告警測試${roles.length}`, password_hash: await hashPassword(PW), role_id: r.id })
      .returning('id')
      .executeTakeFirstOrThrow();
    users.push(u.id);
    return (await http().post('/api/v1/auth/login').send({ username, password: PW }).expect(200)).body.accessToken as string;
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
    await db.insertInto('floors').values({ id: FLOOR, name: `告警測試 ${FLOOR}`, sort: 99, width_m: '40', height_m: '20' }).execute();
    robotId = (
      await db
        .insertInto('robots')
        .values({ code: CODE, brand: 'anbot', model: 'ANBOT-Y', floor_id: FLOOR, adapter: `e2e-${tag}` })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    await db.updateTable('settings').set({ value: 'false' }).where('key', '=', 'dispatch.approval').execute();

    const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(StorageService).useValue(storage).compile();
    app = mod.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.listen(0);
    url = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;
    await until(() => app.get(MqttService).connected);
    app.get(SettingsService).invalidate();
    full = await makeUser(['monitor', 'sysalarm', 'bizalarm', 'alarmset', 'dispatch', 'op.alarm', 'op.dispatch', 'op.remote']);
    sysOnly = await makeUser(['sysalarm']);

    adapter = await mqtt.connectAsync(process.env.MQTT_URL!, { clientId: `e2e-alarm-${tag}` });
    await adapter.subscribeAsync(`rms/robot/${CODE}/cmd`, { qos: 1 });
    adapter.on('message', (_topic, payload) => {
      const m = JSON.parse(payload.toString());
      void adapter.publishAsync(
        `rms/robot/${CODE}/ack`,
        JSON.stringify({ cmdId: m.cmdId, ts: Date.now(), status: bot.failCmd ? 'failed' : 'done', ...(bot.failCmd ? { error: { code: 'E_TEST', msg: '測試失敗' } } : {}) }),
        { qos: 1 },
      );
    });
    await app.get(RobotRegistry).load();
    await setBot({});
  });

  beforeEach(async () => {
    await db.deleteFrom('alarms').where('floor_id', '=', FLOOR).execute();
    Object.assign(bot, { x: 10, y: 5, battery: 80, state: 'idle', rssi: -50, faults: [], failCmd: false });
    await setBot({});
    await sources().check(); // 重設邊緣觸發狀態（電量、訊號、故障碼）
  });

  afterAll(async () => {
    for (const s of sockets) s.close();
    await adapter?.endAsync();
    if (db) await db.updateTable('settings').set({ value: 'true' }).where('key', '=', 'dispatch.approval').execute();
    if (app) {
      await app.get<Redis>(REDIS).del(`robot:${CODE}`);
      await app.close();
    }
    if (db) {
      await db.deleteFrom('task_events').where('task_id', 'in', db.selectFrom('tasks').select('id').where('floor_id', '=', FLOOR)).execute();
      await db.deleteFrom('tasks').where('floor_id', '=', FLOOR).execute();
      await db.deleteFrom('alarms').where((eb) => eb.or([eb('robot_id', '=', robotId), eb('floor_id', '=', FLOOR)])).execute();
      await db.deleteFrom('telemetry').where('robot_id', '=', robotId).execute();
      await db.deleteFrom('robot_state_log').where('robot_id', '=', robotId).execute();
      await db.deleteFrom('robots').where('id', '=', robotId).execute();
      await db.deleteFrom('floors').where('id', '=', FLOOR).execute();
      await db.deleteFrom('op_logs').where('user_id', 'in', users).execute();
      await db.deleteFrom('users').where('id', 'in', users).execute();
      await db.deleteFrom('roles').where('id', 'in', roles).execute();
      await db.destroy();
    }
  });

  describe('管線：去重、初始狀態、通知', () => {
    it('同一事件 60 秒內合併（repeat_count+1，推 alarm.updated）；超過窗口另建一筆', async () => {
      const s = connect(full);
      const updates: AlarmUpdated[] = [];
      s.on('alarm.updated', (m: AlarmUpdated) => updates.push(m));
      await until(() => s.connected);
      const a = await alarms().raise({ type: 'offline', robotId, message: `${CODE} 離線（測試）` });
      const b = await alarms().raise({ type: 'offline', robotId, message: `${CODE} 離線（測試）` });
      expect(a!.repeated).toBe(false);
      expect(b).toMatchObject({ repeated: true, alarm: { id: a!.alarm.id, repeatCount: 2 } });
      await until(() => updates.some((u) => u.id === a!.alarm.id && u.repeatCount === 2));
      // 位置、樓層由機器人即時狀態補上；代碼 A-YYYYMMDD-NNNN
      expect(a!.alarm).toMatchObject({ floorId: FLOOR, x: 10, y: 5, level: 2, status: 'open', name: '機器人離線', robotCode: CODE });
      expect(a!.alarm.code).toMatch(/^A-\d{8}-\d{4}$/);

      const later = await alarms().raise({ type: 'offline', robotId, message: `${CODE} 離線（測試）`, at: new Date(Date.now() + 61_000) });
      expect(later).toMatchObject({ repeated: false });
      expect(await ofType('offline')).toHaveLength(2);
    });

    it('同時送入多筆相同事件只建一筆（advisory lock）', async () => {
      await Promise.all(Array.from({ length: 5 }, () => alarms().raise({ type: 'estop', robotId, message: `${CODE} 進入急停` })));
      const rows = await ofType('estop');
      expect(rows).toHaveLength(1);
      expect(rows[0].repeat_count).toBe(5);
    });

    it('已結案的不合併：再發生另建一筆', async () => {
      const a = (await alarms().raise({ type: 'fault', robotId, message: 'x' }))!.alarm;
      const me = { id: users[0], name: '告警測試1' };
      await alarms().transition(a.id, 'false_alarm', null, me);
      const b = (await alarms().raise({ type: 'fault', robotId, message: 'x' }))!;
      expect(b.repeated).toBe(false);
      expect(b.alarm.id).not.toBe(a.id);
    });

    it('AI 信心度低於門檻 → 待人工複判；足夠 → 未處理；不需處理的 → 無需處理（已結束）', async () => {
      const low = (await alarms().raise({ type: 'intrusion', floorId: FLOOR, x: 3, y: 4, source: 'camera-test-1', confidence: 55, message: '偵測到人員闖入' }))!.alarm;
      const high = (await alarms().raise({ type: 'intrusion', floorId: FLOOR, x: 3, y: 4, source: 'camera-test-2', confidence: 92, message: '偵測到人員闖入' }))!.alarm;
      const info = (await alarms().raise({ type: 'weak_signal', robotId, message: '訊號偏弱' }))!.alarm;
      expect(low).toMatchObject({ status: 'review', confidence: 55, category: 'business', level: 1 });
      expect(high.status).toBe('open');
      expect(info.status).toBe('info');
      expect(info.closedAt).not.toBeNull();
    });

    it('alarm.new 帶通知設定；只推給看得到該類別的連線', async () => {
      const sFull = connect(full);
      const sSys = connect(sysOnly);
      const gotFull: AlarmNew[] = [];
      const gotSys: AlarmNew[] = [];
      sFull.on('alarm.new', (m: AlarmNew) => gotFull.push(m));
      sSys.on('alarm.new', (m: AlarmNew) => gotSys.push(m));
      await until(() => sFull.connected && sSys.connected);
      await alarms().raise({ type: 'blacklist', floorId: FLOOR, x: 1, y: 1, source: 'face-1', message: '黑名單人員出現' });
      await alarms().raise({ type: 'cmd_failed', robotId, message: '指令失敗' });
      await until(() => gotFull.length === 2 && gotSys.length === 1);
      expect(gotFull.find((m) => m.alarm.type === 'blacklist')!.notify).toEqual({ popup: true, sound: true });
      expect(gotFull.find((m) => m.alarm.type === 'cmd_failed')!.notify).toEqual({ popup: false, sound: false });
      expect(gotSys.map((m) => m.alarm.type)).toEqual(['cmd_failed']);
    });

    it('只看告警的帳號可以連 WebSocket，但不能訂閱樓層的機器人狀態', async () => {
      const s = connect(sysOnly);
      await until(() => s.connected);
      const r = await s.emitWithAck('subscribe', { floors: [FLOOR] });
      expect(r).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    });
  });

  describe('API：狀態轉換、查詢、匯出', () => {
    it('非法轉換回 409；合法流程 open → handling → reported → closed，歷程完整', async () => {
      const a = (await alarms().raise({ type: 'battery_low', robotId, message: '低電量' }))!.alarm;
      const bad = await as(full, http().post(`/api/v1/alarms/${a.id}/transition`)).send({ to: 'closed' }).expect(409);
      expect(bad.body.error).toMatchObject({ code: 'INVALID_STATE', details: { from: 'open', to: 'closed' } });

      await as(full, http().post(`/api/v1/alarms/${a.id}/transition`)).send({ to: 'handling', note: '已派人前往' }).expect(200);
      await as(full, http().post(`/api/v1/alarms/${a.id}/transition`)).send({ to: 'reported' }).expect(200);
      await as(full, http().post(`/api/v1/alarms/${a.id}/transition`)).send({ to: 'handling' }).expect(409);
      const done = (await as(full, http().post(`/api/v1/alarms/${a.id}/transition`)).send({ to: 'closed', note: '充電完成' }).expect(200)).body;
      expect(done).toMatchObject({ status: 'closed', handlerName: '告警測試1' });
      expect(done.closedAt).not.toBeNull();
      await as(full, http().post(`/api/v1/alarms/${a.id}/transition`)).send({ to: 'false_alarm' }).expect(409);

      const detail = (await as(full, http().get(`/api/v1/alarms/${a.id}`)).expect(200)).body;
      expect(detail.events.map((e: { from: string | null; to: string; userName: string; note: string | null }) => [e.from, e.to, e.userName, e.note])).toEqual([
        [null, 'open', '系統', '建立'],
        ['open', 'handling', '告警測試1', '已派人前往'],
        ['handling', 'reported', '告警測試1', null],
        ['reported', 'closed', '告警測試1', '充電完成'],
      ]);
      const logs = await db.selectFrom('op_logs').select(['action', 'target']).where('user_id', '=', users[0]).where('target', '=', `alarm:${a.id}`).orderBy('at').orderBy('id').execute();
      // 失敗（409）的嘗試也記錄
      expect(logs.map((l) => l.action)).toEqual(['alarm.closed', 'alarm.handling', 'alarm.reported', 'alarm.handling', 'alarm.closed', 'alarm.false_alarm']);
    });

    it('待人工複判 → 確認屬實（open）或判定誤報；無需處理的不能轉', async () => {
      const r = (await alarms().raise({ type: 'intrusion', floorId: FLOOR, source: 'cam-x', confidence: 40, message: '疑似闖入' }))!.alarm;
      await as(full, http().post(`/api/v1/alarms/${r.id}/transition`)).send({ to: 'handling' }).expect(409);
      expect((await as(full, http().post(`/api/v1/alarms/${r.id}/transition`)).send({ to: 'open' }).expect(200)).body.status).toBe('open');
      const i = (await alarms().raise({ type: 'p1_preempt', robotId, source: 'task:x', message: '插隊' }))!.alarm;
      expect(i.status).toBe('info');
      await as(full, http().post(`/api/v1/alarms/${i.id}/transition`)).send({ to: 'handling' }).expect(409);
    });

    it('回報上位：未處理的先轉處理中再轉已回報，兩步都留歷程', async () => {
      const a = (await alarms().raise({ type: 'estop', robotId, message: '急停' }))!.alarm;
      const r = (await as(full, http().post(`/api/v1/alarms/${a.id}/report`)).send({ note: '通知保全中心' }).expect(200)).body;
      expect(r.status).toBe('reported');
      const ev = (await as(full, http().get(`/api/v1/alarms/${a.id}`)).expect(200)).body.events;
      expect(ev.map((e: { to: string }) => e.to)).toEqual(['open', 'handling', 'reported']);
    });

    it('派機器人查看：建立 inspect 任務到告警位置；沒有位置回 409', async () => {
      const a = (await alarms().raise({ type: 'smoke', floorId: FLOOR, x: 20, y: 8, source: 'cam-smoke', message: '偵測到煙霧' }))!.alarm;
      const r = (await as(full, http().post(`/api/v1/alarms/${a.id}/dispatch`)).expect(201)).body;
      expect(r.taskCode).toMatch(/^T-/);
      const t = await db.selectFrom('tasks').selectAll().where('id', '=', r.taskId).executeTakeFirstOrThrow();
      expect(t).toMatchObject({ kind: 'inspect', priority: 'P1', source: 'alarm', floor_id: FLOOR });
      expect(t.target).toEqual({ x: 20, y: 8 });
      const ev = (await as(full, http().get(`/api/v1/alarms/${a.id}`)).expect(200)).body.events;
      expect(ev.at(-1).note).toContain(r.taskCode);

      const noPos = (await alarms().raise({ type: 'gas', floorId: FLOOR, source: 'env-1', message: 'CO 35ppm' }))!.alarm;
      await as(full, http().post(`/api/v1/alarms/${noPos.id}/dispatch`)).expect(409);
    });

    it('權限：沒有 op.alarm 不能處理；看不到的類別回 404、列表也不含', async () => {
      const sys = (await alarms().raise({ type: 'estop', robotId, message: '急停' }))!.alarm;
      const biz = (await alarms().raise({ type: 'fire', floorId: FLOOR, source: 'cam-fire', message: '火焰' }))!.alarm;
      await as(sysOnly, http().post(`/api/v1/alarms/${sys.id}/transition`)).send({ to: 'handling' }).expect(403);
      await as(sysOnly, http().get(`/api/v1/alarms/${sys.id}`)).expect(200);
      await as(sysOnly, http().get(`/api/v1/alarms/${biz.id}`)).expect(404);
      const list = (await as(sysOnly, http().get(`/api/v1/alarms?floor=${FLOOR}`)).expect(200)).body;
      expect(list.items.map((a: { id: string }) => a.id)).toEqual([sys.id]);
      const biz2 = (await as(sysOnly, http().get(`/api/v1/alarms?floor=${FLOOR}&category=business`)).expect(200)).body;
      expect(biz2.items).toEqual([]);
      await as(sysOnly, http().get('/api/v1/alarm-rules')).expect(403);
      // 篩選選項：只含看得到的類別
      const opt = (await as(sysOnly, http().get('/api/v1/alarms/options')).expect(200)).body;
      expect(opt.robots.some((r: { code: string }) => r.code === CODE)).toBe(true);
      expect(new Set(opt.types.map((x: { category: string }) => x.category))).toEqual(new Set(['system']));
    });

    it('列表篩選、未處理筆數、CSV 匯出', async () => {
      await alarms().raise({ type: 'estop', robotId, message: '急停' });
      await alarms().raise({ type: 'cmd_failed', robotId, message: '指令 stop 執行失敗' });
      await alarms().raise({ type: 'fire', floorId: FLOOR, source: 'cam-f', message: '=SUM(A1)' });
      const all = (await as(full, http().get(`/api/v1/alarms?floor=${FLOOR}`)).expect(200)).body;
      expect(all).toMatchObject({ total: 3, unhandled: 2, page: 1 });
      const l2 = (await as(full, http().get(`/api/v1/alarms?floor=${FLOOR}&level=2,3&category=system`)).expect(200)).body;
      expect(l2.items.map((a: { type: string }) => a.type).sort()).toEqual(['cmd_failed', 'estop']);
      const open = (await as(full, http().get(`/api/v1/alarms?floor=${FLOOR}&status=open&q=${encodeURIComponent('急停')}`)).expect(200)).body;
      expect(open.items.map((a: { type: string }) => a.type)).toEqual(['estop']);
      await as(full, http().get('/api/v1/alarms?status=bogus')).expect(400);

      const csv = await as(full, http().get(`/api/v1/alarms?floor=${FLOOR}&format=csv`)).expect(200);
      expect(csv.headers['content-type']).toContain('text/csv');
      expect(csv.text.charCodeAt(0)).toBe(0xfeff);
      expect(csv.text).toContain('告警名稱');
      expect(csv.text).toContain("'=SUM(A1)"); // 公式注入防護
      expect(csv.text.trim().split('\r\n')).toHaveLength(4);
    });
  });

  describe('系統告警規則（後端邏輯 §5）', () => {
    it('離線、急停', async () => {
      await adapter.publishAsync(`rms/robot/${CODE}/online`, JSON.stringify({ online: false, ts: Date.now() }), { qos: 1 });
      await until(async () => (await ofType('offline')).length === 1);
      await setBot({ state: 'estop' });
      await until(async () => (await ofType('estop')).length === 1);
      expect((await ofType('estop'))[0].message).toContain('急停');
    });

    it('低電量：進入門檻時一次；回升後再低才會再發', async () => {
      await setBot({ battery: 24 });
      await sources().check();
      await sources().check();
      expect(await ofType('battery_low')).toHaveLength(1);
      await setBot({ battery: 50 });
      await sources().check();
      await db.deleteFrom('alarms').where('floor_id', '=', FLOOR).execute(); // 避開 60 秒合併窗口
      await setBot({ battery: 20 });
      await sources().check();
      expect((await ofType('battery_low'))[0].message).toContain('20%');
    });

    it('訊號偏弱：rssi < -75 持續 30 秒才發（三級，無需處理）', async () => {
      await setBot({ rssi: -80 });
      const t0 = Date.now();
      await sources().check(t0);
      await sources().check(t0 + 29_000);
      expect(await ofType('weak_signal')).toHaveLength(0);
      await sources().check(t0 + 31_000);
      const [a] = await ofType('weak_signal');
      expect(a).toMatchObject({ level: 3, status: 'info' });
      await sources().check(t0 + 60_000);
      expect(await ofType('weak_signal')).toHaveLength(1);
    });

    it('故障：新的 1 級故障碼才發；2 級不發', async () => {
      await setBot({ faults: [{ code: 'E_MOTOR', level: 2, msg: '馬達溫度偏高' }] });
      await sources().check();
      expect(await ofType('fault')).toHaveLength(0);
      await setBot({ faults: [{ code: 'E_MOTOR', level: 2, msg: '馬達溫度偏高' }, { code: 'E_JOINT', level: 1, msg: '關節過熱' }] });
      await sources().check();
      await sources().check();
      const rows = await ofType('fault');
      expect(rows).toHaveLength(1);
      expect(rows[0].message).toContain('E_JOINT');
    });

    it('同一台 60 秒內兩個不同故障碼：各自一筆（PR #9 審查第 1 點）；同一碼重複才合併', async () => {
      await setBot({ faults: [{ code: 'E_MOTOR_HOT', level: 1, msg: '馬達過熱' }] });
      await sources().check();
      await setBot({ faults: [{ code: 'E_MOTOR_FAIL', level: 1, msg: '馬達失效' }] });
      await sources().check();
      await adapter.publishAsync(`rms/robot/${CODE}/event`, JSON.stringify({ ts: Date.now(), type: 'fault', data: { code: 'E_MOTOR_FAIL', level: 1, msg: '馬達失效' } }), { qos: 1 });
      await until(async () => (await ofType('fault')).some((a) => a.repeat_count === 2));
      const rows = await ofType('fault');
      const by = Object.fromEntries(rows.map((a) => [a.source_key, a]));
      expect(by[`robot:${robotId}:fault:E_MOTOR_HOT`]).toMatchObject({ repeat_count: 1, message: `${CODE} 故障 E_MOTOR_HOT：馬達過熱` });
      expect(by[`robot:${robotId}:fault:E_MOTOR_FAIL`]).toMatchObject({ repeat_count: 2, message: `${CODE} 故障 E_MOTOR_FAIL：馬達失效` });
      expect(rows).toHaveLength(2);
    });

    it('轉接器斷線：底下多台合併成一筆「轉接器斷線」告警，不逐台發離線（PR #9 審查第 3 點）', async () => {
      const code2 = `A${tag}-2`;
      const id2 = (
        await db.insertInto('robots').values({ code: code2, brand: 'anbot', model: 'ANBOT-Y', floor_id: FLOOR, adapter: `e2e-${tag}` }).returning('id').executeTakeFirstOrThrow()
      ).id;
      try {
        await app.get(RobotRegistry).load();
        await adapter.publishAsync(
          `rms/robot/${code2}/telemetry`,
          JSON.stringify({ ts: Date.now(), pose: { x: 5, y: 5, yaw: 0, floor: FLOOR }, battery: { pct: 80, charging: false }, state: 'idle', faults: [] }),
        );
        await until(() => app.get(FleetService).get(code2)?.online);
        await adapter.publishAsync(`rms/adapter/e2e-${tag}/status`, JSON.stringify({ name: `e2e-${tag}`, alive: false }), { qos: 1 });
        await until(() => !app.get(FleetService).get(CODE)?.online && !app.get(FleetService).get(code2)?.online);
        // 收集 1 秒後合併送出
        const rows = (await until(async () => {
          const r = await ofType('adapter_down');
          return r.length ? r : null;
        }))!;
        expect(await ofType('offline')).toHaveLength(0);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ source_key: `adapter:e2e-${tag}`, floor_id: FLOOR, level: 2, status: 'open' });
        expect(rows[0].message).toBe(`轉接器 e2e-${tag} 斷線，2 台機器人離線：${[CODE, code2].sort().join('、')}`);
      } finally {
        await db.deleteFrom('alarms').where('robot_id', '=', id2).execute();
        await db.deleteFrom('telemetry').where('robot_id', '=', id2).execute();
        await db.deleteFrom('robot_state_log').where('robot_id', '=', id2).execute();
        await db.deleteFrom('robots').where('id', '=', id2).execute();
        await app.get<Redis>(REDIS).del(`robot:${code2}`);
        await app.get(RobotRegistry).load();
      }
    });

    it('機器人事件 estop_pressed、fault（MQTT event 主題）', async () => {
      await adapter.publishAsync(`rms/robot/${CODE}/event`, JSON.stringify({ ts: Date.now(), type: 'estop_pressed' }), { qos: 1 });
      await adapter.publishAsync(`rms/robot/${CODE}/event`, JSON.stringify({ ts: Date.now(), type: 'fault', data: { code: 'E_LIDAR', level: 1, msg: '光達異常' } }), { qos: 1 });
      await until(async () => (await ofType('estop')).length === 1 && (await ofType('fault')).length === 1);
      expect((await ofType('fault'))[0].message).toContain('E_LIDAR');
    });

    it('指令失敗（三級）', async () => {
      bot.failCmd = true;
      await as(full, http().post(`/api/v1/robots/${robotId}/commands`)).send({ type: 'stop' }).expect(202);
      await until(async () => (await ofType('cmd_failed')).length === 1);
      expect((await ofType('cmd_failed'))[0]).toMatchObject({ level: 3, status: 'info' });
    });

    it('P1 無可用機器人（一級，彈窗）', async () => {
      const s = connect(full);
      const got: AlarmNew[] = [];
      s.on('alarm.new', (m: AlarmNew) => got.push(m));
      await until(() => s.connected);
      await setBot({ battery: 30 }); // 低於接單門檻
      const r = await as(full, http().post('/api/v1/tasks')).send({ kind: 'inspect', priority: 'P1', floorId: FLOOR, target: { x: 15, y: 5 } }).expect(201);
      const m = (await until(() => got.find((x) => x.alarm.type === 'p1_no_robot')))!;
      expect(m.notify.popup).toBe(true);
      expect(m.alarm).toMatchObject({ level: 1, status: 'open', floorId: FLOOR, x: 15, y: 5 });
      expect(m.alarm.message).toContain(r.body.code);
      await as(full, http().post(`/api/v1/tasks/${r.body.id}/cancel`)).expect(200);
    });

    it('充電排程事件：排隊過久、需人工充電、回充失敗', async () => {
      const robot = app.get(RobotRegistry).get(CODE)!;
      const c = app.get(ChargingService);
      c.alerts$.next({ type: 'charge_queue', robot, battery: 8, position: 2, at: Date.now() });
      c.alerts$.next({ type: 'manual_charge', robot, battery: 20, chargerCode: 'CHG-X', at: Date.now() });
      c.alerts$.next({ type: 'charge_failed', robot, battery: 18, fails: 3, at: Date.now() });
      await until(async () => (await ofType('charge_queue')).length && (await ofType('manual_charge')).length && (await ofType('charge_failed')).length);
      expect((await ofType('charge_failed'))[0].message).toContain('連續 3 次');
    });
  });

  describe('保存期限（PR #9 審查第 4 點）', () => {
    it('超過 1 年的已結束告警（含歷程）與操作日誌：先匯出 CSV 再刪除；未結束的、未滿 1 年的保留', async () => {
      const old = new Date(Date.now() - 400 * 86_400_000);
      const closed = (await alarms().raise({ type: 'estop', robotId, message: `${tag} 舊的已結案`, at: old }))!.alarm;
      await alarms().transition(closed.id, 'false_alarm', '測試', { id: users[0], name: '告警測試1' });
      const open = (await alarms().raise({ type: 'offline', robotId, message: `${tag} 舊的未處理`, at: old }))!.alarm;
      const recent = (await alarms().raise({ type: 'cmd_failed', robotId, message: `${tag} 新的` }))!.alarm;
      await db.insertInto('op_logs').values({ user_id: users[0], username: `${tag}-old`, action: 'test.old', target: null, detail: JSON.stringify({}), ip: null }).execute();
      await db.updateTable('op_logs').set({ at: old } as never).where('username', '=', `${tag}-old`).execute();

      const r = await app.get(RetentionService).purge();
      expect(r.alarms).toBeGreaterThanOrEqual(1);
      expect(r.oplogs).toBeGreaterThanOrEqual(1);
      const ids = (await db.selectFrom('alarms').select('id').where('id', 'in', [closed.id, open.id, recent.id]).execute()).map((a) => a.id);
      expect(ids.sort()).toEqual([open.id, recent.id].sort());
      expect(await db.selectFrom('alarm_events').select('id').where('alarm_id', '=', closed.id).execute()).toEqual([]);
      expect(await db.selectFrom('op_logs').select('id').where('username', '=', `${tag}-old`).execute()).toEqual([]);

      const files = r.files.map((k) => storage.objects.get(k)!.body.toString('utf8'));
      expect(files[0]).toContain(`${tag} 舊的已結案`);
      expect(files[0]).toContain('告警測試1 open→false_alarm 測試');
      expect(files[0]).not.toContain(`${tag} 舊的未處理`);
      expect(files[1]).toContain('test.old');
      expect(r.files[0]).toMatch(/^retention\/alarms-\d{8}-\d+\.csv$/);
    });
  });

  describe('告警設置 /alarm-rules', () => {
    it('讀取規則與可選接收人；修改後立即影響新告警', async () => {
      const g = (await as(full, http().get('/api/v1/alarm-rules')).expect(200)).body;
      const weak = g.rules.find((r: { type: string }) => r.type === 'weak_signal');
      expect(weak).toMatchObject({ category: 'system', level: 3, needHandle: false });
      expect(g.users.length).toBeGreaterThan(0);
      try {
        await as(full, http().put('/api/v1/alarm-rules'))
          .send({ rules: [{ ...weak, level: 2, sound: true, needHandle: true, smsUserIds: [users[0]] }] })
          .expect(200);
        const a = (await alarms().raise({ type: 'weak_signal', robotId, message: '訊號偏弱' }))!.alarm;
        expect(a).toMatchObject({ level: 2, status: 'open' });
        expect((await alarms().rule('weak_signal'))!.smsUserIds).toEqual([users[0]]);
      } finally {
        await as(full, http().put('/api/v1/alarm-rules')).send({ rules: [{ ...weak, smsUserIds: [] }] }).expect(200);
      }
    });

    it('驗證：未知類型、不存在的接收人、等級範圍', async () => {
      const base = { level: 2, popup: false, sound: true, needHandle: true, smsUserIds: [], dedupSec: 60 };
      await as(full, http().put('/api/v1/alarm-rules')).send({ rules: [{ ...base, type: 'nope' }] }).expect(400);
      await as(full, http().put('/api/v1/alarm-rules')).send({ rules: [{ ...base, type: 'estop', smsUserIds: ['00000000-0000-4000-8000-000000000000'] }] }).expect(400);
      await as(full, http().put('/api/v1/alarm-rules')).send({ rules: [{ ...base, type: 'estop', level: 4 }] }).expect(400);
    });
  });
});
