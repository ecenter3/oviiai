/**
 * T-19 充電排程端對端：真的 PostgreSQL、Redis、EMQX；獨立測試樓層（2 座充電樁）＋假轉接器。
 * 假轉接器：charge → 返航 → 到樁開始充電；navigate → 到點待命。電量由測試以遙測控制。
 */
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type Redis from 'ioredis';
import mqtt, { type MqttClient } from 'mqtt';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { hashPassword } from '../src/auth/password';
import { type ChargeAlert, ChargingService } from '../src/charging/charging.service';
import { loadEnv } from '../src/config';
import { createDatabase, type Database } from '../src/db/database.module';
import { DispatchService } from '../src/dispatch/dispatch.service';
import { FleetService } from '../src/fleet/fleet.service';
import { RobotRegistry } from '../src/fleet/robot-registry';
import { MqttService } from '../src/mqtt/mqtt.service';
import { REDIS } from '../src/redis/redis.module';
import { SettingsService } from '../src/settings/settings.service';

loadEnv();
const ready = !!(process.env.DATABASE_URL && process.env.REDIS_URL && process.env.MQTT_URL);
const tag = Date.now().toString(36).slice(-6);
const FLOOR = `c${tag}`;
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

interface Bot {
  code: string;
  id: string;
  x: number;
  y: number;
  battery: number;
  state: string;
  cmds: { cmdId: string; type: string; args: Record<string, unknown> }[];
  /** 任務導航停在途中（測試「執行任務中」）；往充電點的導航照樣抵達 */
  hold?: boolean;
  /** 每個測試開始時遞增；上一個測試還在路上的指令回應（延遲 60 ms）不再改動狀態 */
  epoch: number;
}

describe.skipIf(!ready)('充電排程（e2e）', () => {
  let app: NestExpressApplication;
  let db: Database;
  let adapter: MqttClient;
  let token: string;
  let userId: string;
  let roleId: string;
  const bots: Record<string, Bot> = {};
  const chargerIds: string[] = [];
  const alerts: ChargeAlert[] = [];
  let modeBefore: unknown;
  const B = (n: number) => `C${tag}-${n}`;

  const http = () => request(app.getHttpServer());
  const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);
  const tele = (b: Bot) =>
    adapter.publishAsync(
      `rms/robot/${b.code}/telemetry`,
      JSON.stringify({ ts: Date.now(), pose: { x: b.x, y: b.y, yaw: 0, floor: FLOOR }, battery: { pct: b.battery, charging: b.state === 'charging' }, state: b.state, faults: [] }),
    );
  const ack = (b: Bot, cmdId: string, status: string) =>
    adapter.publishAsync(`rms/robot/${b.code}/ack`, JSON.stringify({ cmdId, ts: Date.now(), status }), { qos: 1 });

  async function setBot(code: string, over: Partial<Bot>) {
    Object.assign(bots[code], over);
    await tele(bots[code]);
    await until(() => {
      const l = app.get(FleetService).get(code);
      return l && l.state === bots[code].state && l.battery === bots[code].battery;
    });
  }
  const charging = () => app.get(ChargingService);
  const tick = () => charging().tick();
  const floorView = async () => (await charging().view(FLOOR))[0];
  const types = (code: string) => bots[code].cmds.map((c) => c.type);
  const task = async (id: string) => (await auth(http().get(`/api/v1/tasks/${id}`)).expect(200)).body;
  const waitStatus = (id: string, s: string) => until(async () => ((await task(id)).status === s ? task(id) : null));
  const waitAny = (id: string, s: string[]) => until(async () => (s.includes((await task(id)).status) ? task(id) : null));
  const atCharger = (x: number, y: number) => [[2, 2], [2, 6]].some(([cx, cy]) => cx === x && cy === y);

  beforeAll(async () => {
    process.env.JWT_SECRET ||= 'e2e-secret-e2e-secret-e2e-secret-0';
    process.env.COOKIE_SECURE = 'false';
    db = createDatabase();
    await db.insertInto('floors').values({ id: FLOOR, name: `充電測試 ${FLOOR}`, sort: 99, width_m: '40', height_m: '20' }).execute();
    for (const [code, x, y] of [
      [`CHG-${tag}-1`, 2, 2],
      [`CHG-${tag}-2`, 2, 6],
    ] as const) {
      const { id } = await db.insertInto('chargers').values({ code, floor_id: FLOOR, x, y, brand: 'anbot' }).returning('id').executeTakeFirstOrThrow();
      chargerIds.push(id);
    }
    for (const [n, x] of [
      [1, 5],
      [2, 8],
      [3, 30],
      [4, 35],
    ] as const) {
      const code = B(n);
      const { id } = await db
        .insertInto('robots')
        .values({ code, brand: 'anbot', model: 'ANBOT-Y', floor_id: FLOOR, adapter: `e2e-${tag}` })
        .returning('id')
        .executeTakeFirstOrThrow();
      bots[code] = { code, id, x, y: 10, battery: 80, state: 'idle', cmds: [], epoch: 0 };
    }
    roleId = (
      await db
        .insertInto('roles')
        .values({ name: `${tag}-充電`, perms: ['monitor', 'robots', 'dispatch', 'settings', 'maps', 'op.dispatch', 'op.approve', 'op.remote', 'op.estop', 'op.config'] })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    userId = (
      await db
        .insertInto('users')
        .values({ username: `${tag}-chg`, display_name: '充電測試', password_hash: await hashPassword(PW), role_id: roleId })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    modeBefore = (await db.selectFrom('settings').select('value').where('key', '=', 'charge.mode.anbot').executeTakeFirst())?.value;
    await db.updateTable('settings').set({ value: '"auto"' }).where('key', '=', 'charge.mode.anbot').execute();
    await db.updateTable('settings').set({ value: 'false' }).where('key', '=', 'dispatch.approval').execute();

    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.listen(0);
    await until(() => app.get(MqttService).connected);
    app.get(SettingsService).invalidate();
    token = (await http().post('/api/v1/auth/login').send({ username: `${tag}-chg`, password: PW }).expect(200)).body.accessToken;
    charging().alerts$.subscribe((a) => alerts.push(a));

    adapter = await mqtt.connectAsync(process.env.MQTT_URL!, { clientId: `e2e-chg-${tag}` });
    await adapter.subscribeAsync(Object.keys(bots).map((c) => `rms/robot/${c}/cmd`), { qos: 1 });
    adapter.on('message', (topic, payload) => {
      const b = bots[topic.split('/')[2]];
      const m = JSON.parse(payload.toString());
      b.cmds.push(m);
      const epoch = b.epoch;
      const stale = () => b.epoch !== epoch;
      void (async () => {
        await ack(b, m.cmdId, 'accepted');
        if (m.type === 'charge') {
          b.state = 'returning';
          await tele(b);
          await new Promise((r) => setTimeout(r, 60));
          if (stale()) return;
          Object.assign(b, { x: m.args.x, y: m.args.y, state: 'charging' });
        } else if (m.type === 'navigate') {
          b.state = 'navigating';
          await tele(b);
          if (b.hold && !atCharger(m.args.x, m.args.y)) return; // 停在途中，不回 done
          await new Promise((r) => setTimeout(r, 60));
          if (stale()) return;
          Object.assign(b, { x: m.args.x, y: m.args.y, state: 'idle' });
        } else if (m.type === 'stop') b.state = 'idle';
        if (stale()) return;
        await ack(b, m.cmdId, 'done');
        await tele(b);
      })();
    });
    await app.get(RobotRegistry).load();
    for (const b of Object.values(bots)) await setBot(b.code, {});
  });

  beforeEach(async () => {
    const redis = app.get<Redis>(REDIS);
    const ids = Object.values(bots).map((b) => b.id);
    // 清掉這個樓層的充電狀態與任務，機器人回到原位、電量 80%
    for (const id of ids) {
      await redis.hdel('charge:assign', id);
      await redis.hdel('charge:manual', id);
    }
    await redis.del(`charge:queue:${FLOOR}`);
    await db.updateTable('chargers').set({ occupied_by: null }).where('id', 'in', chargerIds).execute();
    await db.deleteFrom('task_events').where('task_id', 'in', db.selectFrom('tasks').select('id').where('floor_id', '=', FLOOR)).execute();
    await db.deleteFrom('tasks').where('floor_id', '=', FLOOR).execute();
    await db.updateTable('settings').set({ value: '"auto"' }).where('key', '=', 'charge.mode.anbot').execute();
    app.get(SettingsService).invalidate();
    alerts.length = 0;
    for (const [i, b] of Object.values(bots).entries()) {
      b.epoch++;
      b.cmds.length = 0;
      b.hold = false;
      await setBot(b.code, { state: 'idle', battery: 80, x: [5, 8, 30, 35][i], y: 10 });
    }
  });

  afterAll(async () => {
    await adapter?.endAsync();
    if (db) {
      await db.updateTable('settings').set({ value: JSON.stringify(modeBefore ?? 'auto') }).where('key', '=', 'charge.mode.anbot').execute();
      await db.updateTable('settings').set({ value: 'true' }).where('key', '=', 'dispatch.approval').execute();
    }
    if (app) {
      const redis = app.get<Redis>(REDIS);
      for (const b of Object.values(bots)) {
        await redis.hdel('charge:assign', b.id);
        await redis.hdel('charge:manual', b.id);
        await redis.del(`robot:${b.code}`, `teleop:${b.code}`);
      }
      await redis.del(`charge:queue:${FLOOR}`);
      await app.close();
    }
    if (db) {
      const ids = Object.values(bots).map((b) => b.id);
      await db.deleteFrom('task_events').where('task_id', 'in', db.selectFrom('tasks').select('id').where('floor_id', '=', FLOOR)).execute();
      await db.deleteFrom('tasks').where('floor_id', '=', FLOOR).execute();
      await db.deleteFrom('charge_sessions').where('robot_id', 'in', ids).execute();
      await db.deleteFrom('telemetry').where('robot_id', 'in', ids).execute();
      await db.deleteFrom('robot_state_log').where('robot_id', 'in', ids).execute();
      // 充電樁的 occupied_by 參照機器人：先刪樁，否則測試失敗時刪不掉機器人
      await db.deleteFrom('chargers').where('id', 'in', chargerIds).execute();
      await db.deleteFrom('robots').where('id', 'in', ids).execute();
      await db.deleteFrom('floors').where('id', '=', FLOOR).execute();
      await db.deleteFrom('op_logs').where('user_id', '=', userId).execute();
      // 設定 API 測試會記錄 settings.updated_by：先清掉，才刪得掉測試帳號
      await db.updateTable('settings').set({ updated_by: null }).where('updated_by', '=', userId).execute();
      await db.deleteFrom('users').where('id', '=', userId).execute();
      await db.deleteFrom('roles').where('id', '=', roleId).execute();
      await db.destroy();
    }
  });

  it('同一輪多台同時低電量：電量低的先拿到樁', async () => {
    await setBot(B(1), { battery: 24 });
    await setBot(B(2), { battery: 22 });
    await setBot(B(4), { battery: 18 });
    await tick();
    const v = await floorView();
    expect(v.chargers.map((c) => c.occupiedBy?.code).sort()).toEqual([B(2), B(4)].sort());
    expect(v.queue.map((q) => q.code)).toEqual([B(1)]);
  });

  it('3 台同時低電量、只有 2 座樁：第 3 台排隊；第 1 台充到 90% 後讓位（測試計畫必測）', async () => {
    await setBot(B(1), { battery: 20 });
    await setBot(B(2), { battery: 22 });
    await setBot(B(3), { battery: 24 });
    await tick();

    // 依觸發順序先到先得：1、2 拿到樁，3 排隊並到等候點
    await until(() => bots[B(1)].state === 'charging' && bots[B(2)].state === 'charging');
    let v = await floorView();
    expect(v.chargers.map((c) => c.occupiedBy?.code).sort()).toEqual([B(1), B(2)]);
    expect(v.queue.map((q) => q.code)).toEqual([B(3)]);
    expect(types(B(3))).toEqual(['navigate']);
    expect(types(B(1))).toEqual(['charge']);
    expect(bots[B(1)].cmds[0].args).toMatchObject({ chargerId: expect.any(String), x: 2, y: 6 }); // (5,10) 最近的是 (2,6)

    await tick(); // 進入「充電中」，開始記錄充電
    await setBot(B(1), { battery: 89 });
    await tick();
    expect(types(B(1))).toEqual(['charge']); // 89% 還不讓位

    await setBot(B(1), { battery: 90 });
    await tick(); // 讓位：送導航離樁
    await until(() => bots[B(1)].state === 'idle');
    await tick(); // 釋放樁 → 指派給排隊的第 3 台
    await until(() => bots[B(3)].state === 'charging');
    v = await floorView();
    expect(v.queue).toEqual([]);
    expect(v.chargers.find((c) => c.occupiedBy?.code === B(3))).toBeTruthy();

    // 充電紀錄：第 1 台一筆，開始 20%、結束 90%
    const sessions = await db.selectFrom('charge_sessions').selectAll().where('robot_id', '=', bots[B(1)].id).execute();
    expect(sessions.at(-1)).toMatchObject({ mode: 'auto', start_pct: 20, end_pct: 90 });
  });

  it('兩座都充到 90% 以上、只有 1 台排隊：只讓出一座（實測發現的問題）', async () => {
    await setBot(B(1), { battery: 20 });
    await setBot(B(2), { battery: 21 });
    await tick();
    await until(() => bots[B(1)].state === 'charging' && bots[B(2)].state === 'charging');
    await tick();
    await setBot(B(3), { battery: 22 });
    await tick();
    expect((await floorView()).queue.map((q) => q.code)).toEqual([B(3)]);

    await setBot(B(1), { battery: 93 });
    await setBot(B(2), { battery: 95 });
    for (let i = 0; i < 4; i++) {
      await tick();
      await new Promise((r) => setTimeout(r, 150));
    }
    await until(() => bots[B(3)].state === 'charging');
    await tick();
    const leftCharger = [B(1), B(2)].filter((c) => types(c).includes('navigate'));
    expect(leftCharger).toHaveLength(1); // 只有一台讓位
    const v = await floorView();
    expect(v.chargers.map((c) => c.occupiedBy?.code).filter(Boolean).sort()).toHaveLength(2);
  });

  it('沒人排隊：充到 90% 留在樁上；仍視為可接任務，派任務時自動離樁', async () => {
    await setBot(B(1), { battery: 20 });
    await tick();
    await until(() => bots[B(1)].state === 'charging');
    await tick();
    await setBot(B(1), { battery: 95 });
    await tick();
    expect(types(B(1))).toEqual(['charge']);

    // 其他三台都不能接（電量不足）：任務派給在樁上 95% 的第 1 台
    for (const n of [2, 3, 4]) await setBot(B(n), { battery: 30 });
    const r = await auth(http().post('/api/v1/tasks')).send({ kind: 'inspect', priority: 'P3', floorId: FLOOR, target: { x: 20, y: 10 } }).expect(201);
    const t = await waitAny(r.body.id, ['running', 'done']);
    expect(t.robotCode).toBe(B(1));
    await until(() => bots[B(1)].state === 'idle');
    await tick();
    expect((await floorView()).chargers.every((c) => !c.occupiedBy)).toBe(true);
  });

  it('執行任務中低電量：任務暫停（回充）→ 充到 90% 自動續做，派回同一台', async () => {
    for (const n of [2, 3, 4]) await setBot(B(n), { battery: 30 }); // 只讓第 1 台接
    bots[B(1)].hold = true;
    const r = await auth(http().post('/api/v1/tasks')).send({ kind: 'inspect', priority: 'P3', floorId: FLOOR, target: { x: 30, y: 15 } }).expect(201);
    await waitStatus(r.body.id, 'running');
    await setBot(B(1), { battery: 24, state: 'navigating' });
    await tick();
    const p = await waitStatus(r.body.id, 'paused');
    expect(p.progress.pausedBy).toBe('charge');
    await until(() => bots[B(1)].state === 'charging');
    await tick();

    await setBot(B(1), { battery: 90 });
    await tick(); // 通知派工續做
    const again = await waitStatus(r.body.id, 'running');
    expect(again.robotCode).toBe(B(1));
  });

  it('使用者按回充：走排程（帶充電樁 id 與座標）；樁滿時排隊', async () => {
    const r1 = await auth(http().post(`/api/v1/robots/${bots[B(1)].id}/commands`)).send({ type: 'charge' }).expect(202);
    expect(r1.body.cmdId).toMatch(/^c_/);
    await until(() => types(B(1)).includes('charge'));
    expect(bots[B(1)].cmds.find((c) => c.type === 'charge')!.args).toMatchObject({ chargerId: expect.any(String), x: 2, y: 6 });
    await auth(http().post(`/api/v1/robots/${bots[B(2)].id}/commands`)).send({ type: 'charge' }).expect(202);
    await auth(http().post(`/api/v1/robots/${bots[B(3)].id}/commands`)).send({ type: 'charge' }).expect(202);
    expect((await floorView()).queue.map((q) => q.code)).toEqual([B(3)]);
    // 已在排隊再按一次 → 409
    await auth(http().post(`/api/v1/robots/${bots[B(3)].id}/commands`)).send({ type: 'charge' }).expect(409);
  });

  it('排隊過久告警：電量 < 10% 且排第二以後 → 二級告警一次', async () => {
    await setBot(B(1), { battery: 20 });
    await setBot(B(2), { battery: 20 });
    await tick();
    await until(() => bots[B(1)].state === 'charging' && bots[B(2)].state === 'charging');
    await setBot(B(3), { battery: 8 });
    await setBot(B(4), { battery: 9 });
    await tick();
    await tick();
    const v = await floorView();
    expect(v.queue.map((q) => q.code)).toEqual([B(3), B(4)]);
    expect(alerts.filter((a) => a.type === 'charge_queue').map((a) => a.robot.code)).toEqual([B(4)]);
    await tick();
    expect(alerts.filter((a) => a.type === 'charge_queue')).toHaveLength(1);
  });

  describe('人工充電模式（charge.mode.{brand} = manual）', () => {
    beforeEach(async () => {
      await db.updateTable('settings').set({ value: '"manual"' }).where('key', '=', 'charge.mode.anbot').execute();
      app.get(SettingsService).invalidate();
    });

    it('低電量 → 派到充電點、發需人工充電告警、任務暫停；按「完成充電」後充到 90% 自動續做', async () => {
      for (const n of [2, 3, 4]) await setBot(B(n), { battery: 30 });
      bots[B(1)].hold = true;
      const r = await auth(http().post('/api/v1/tasks')).send({ kind: 'inspect', priority: 'P3', floorId: FLOOR, target: { x: 30, y: 15 } }).expect(201);
      await waitStatus(r.body.id, 'running');
      await setBot(B(1), { battery: 22, state: 'navigating' });
      await tick();
      expect((await waitStatus(r.body.id, 'paused')).progress.pausedBy).toBe('charge');
      expect(alerts.map((a) => a.type)).toEqual(['manual_charge']);
      expect(types(B(1))).not.toContain('charge'); // 人工模式不送 charge
      expect((await floorView()).manual.map((m) => m.code)).toEqual([B(1)]);
      await until(() => bots[B(1)].x === 2 && bots[B(1)].y === 6); // 到最近的充電點

      // 人員充好電：電量回升、按完成充電
      await setBot(B(1), { battery: 95 });
      await auth(http().post(`/api/v1/robots/${bots[B(1)].id}/charge-complete`)).expect(204);
      expect((await floorView()).manual).toEqual([]);
      expect((await waitStatus(r.body.id, 'running')).robotCode).toBe(B(1));
      const s = await db.selectFrom('charge_sessions').selectAll().where('robot_id', '=', bots[B(1)].id).orderBy('started_at', 'desc').executeTakeFirstOrThrow();
      expect(s).toMatchObject({ mode: 'manual', start_pct: 22, end_pct: 95 });
    });

    it('換電池：電量跳升 20 點以上自動判定完成', async () => {
      await setBot(B(2), { battery: 15 });
      await tick();
      await until(async () => (await floorView()).manual.length === 1);
      await setBot(B(2), { battery: 98 });
      await tick();
      expect((await floorView()).manual).toEqual([]);
    });

    it('沒在等人工充電時按完成充電 → 409', async () => {
      await auth(http().post(`/api/v1/robots/${bots[B(3)].id}/charge-complete`)).expect(409);
    });
  });

  describe('派工與充電規則 API（T-20）', () => {
    it('GET /settings 回傳目前值、預設值、品牌', async () => {
      const r = await auth(http().get('/api/v1/settings')).expect(200);
      expect(r.body.values).toMatchObject({ 'charge.returnAt': expect.any(Number), 'charge.mode.anbot': 'auto' });
      expect(r.body.defaults).toMatchObject({ 'charge.returnAt': 25, 'charge.minAccept': 40, 'charge.resumeAt': 90 });
      expect(r.body.brands).toContain('anbot');
    });

    it('驗證：範圍、順序（回充 < 接單 < 充電完成）、未知鍵、充電模式值', async () => {
      await auth(http().put('/api/v1/settings')).send({ values: { 'charge.returnAt': 70 } }).expect(400);
      const order = await auth(http().put('/api/v1/settings')).send({ values: { 'charge.returnAt': 45 } }).expect(400);
      expect(order.body.error.message).toContain('回充門檻必須低於接單最低電量');
      await auth(http().put('/api/v1/settings')).send({ values: { 'auth.lockMinutes': 1 } }).expect(400);
      await auth(http().put('/api/v1/settings')).send({ values: { 'charge.mode.anbot': 'sometimes' } }).expect(400);
    });

    it('儲存後立即生效：回充門檻改 30% → 31% 不回充、30% 回充', async () => {
      try {
        await auth(http().put('/api/v1/settings')).send({ values: { 'charge.returnAt': 30 } }).expect(200);
        await setBot(B(1), { battery: 31 });
        await tick();
        expect(types(B(1))).toEqual([]);
        await setBot(B(1), { battery: 30 });
        await tick();
        expect(types(B(1))).toEqual(['charge']);
      } finally {
        await auth(http().put('/api/v1/settings')).send({ values: { 'charge.returnAt': 25 } }).expect(200);
      }
    });

    it('關閉審批：回傳立即派出的待審批筆數；/dispatch/mode 的 pending 先反映筆數', async () => {
      await auth(http().put('/api/v1/settings')).send({ values: { 'dispatch.approval': true, 'dispatch.approvalUntil': '2099-12-31' } }).expect(200);
      for (const n of [1, 2]) await auth(http().post('/api/v1/tasks')).send({ kind: 'inspect', priority: 'P3', floorId: FLOOR, target: { x: 10 * n, y: 5 } }).expect(201);
      const mode = (await auth(http().get('/api/v1/dispatch/mode')).expect(200)).body;
      expect(mode.pending).toBeGreaterThanOrEqual(2);
      const r = await auth(http().put('/api/v1/settings')).send({ values: { 'dispatch.approval': false } }).expect(200);
      expect(r.body.released).toBeGreaterThanOrEqual(2);
      expect((await auth(http().get('/api/v1/dispatch/mode')).expect(200)).body).toMatchObject({ approval: false, pending: 0 });
      const log = await db.selectFrom('op_logs').selectAll().where('user_id', '=', userId).where('action', '=', 'settings.update').orderBy('at', 'desc').executeTakeFirstOrThrow();
      expect(log.detail).toMatchObject({ ok: true, body: { values: { 'dispatch.approval': false } } });
      await auth(http().put('/api/v1/settings')).send({ values: { 'dispatch.approvalUntil': '2027-01-31' } }).expect(200);
    });

    it('樓層配置台數、任務範本 CRUD、興趣點', async () => {
      await auth(http().put(`/api/v1/floors/${FLOOR}`)).send({ robotQuota: 4 }).expect(200);
      expect((await auth(http().get('/api/v1/floors')).expect(200)).body.find((f: { id: string }) => f.id === FLOOR).robotQuota).toBe(4);

      const t = (await auth(http().post('/api/v1/task-templates')).send({ name: `${tag} 巡檢`, kind: 'inspect', priority: 'P3', floorId: FLOOR, target: { x: 10, y: 5 } }).expect(201)).body;
      expect(t).toMatchObject({ name: `${tag} 巡檢`, floorId: FLOOR, target: { x: 10, y: 5 } });
      await auth(http().patch(`/api/v1/task-templates/${t.id}`)).send({ priority: 'P2' }).expect(200);
      const list = (await auth(http().get('/api/v1/task-templates')).expect(200)).body;
      expect(list.find((x: { id: string }) => x.id === t.id).priority).toBe('P2');
      await auth(http().delete(`/api/v1/task-templates/${t.id}`)).expect(204);
      await auth(http().get('/api/v1/pois')).expect(200);
    });
  });
});
