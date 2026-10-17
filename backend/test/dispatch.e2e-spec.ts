/**
 * T-16 派工端對端：真的 PostgreSQL、Redis、EMQX；假轉接器回 ack、發遙測。
 * 用獨立的測試樓層，不會選到開發用的模擬機器人。
 */
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type Redis from 'ioredis';
import mqtt, { type MqttClient } from 'mqtt';
import { io, type Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { hashPassword } from '../src/auth/password';
import { loadEnv } from '../src/config';
import { createDatabase, type Database } from '../src/db/database.module';
import { DispatchService } from '../src/dispatch/dispatch.service';
import { FleetService } from '../src/fleet/fleet.service';
import { RobotRegistry } from '../src/fleet/robot-registry';
import { MqttService } from '../src/mqtt/mqtt.service';
import { REDIS } from '../src/redis/redis.module';
import { SettingsService } from '../src/settings/settings.service';
import { testMqttAuth } from './mqtt-test-auth';

loadEnv();
const ready = !!(process.env.DATABASE_URL && process.env.REDIS_URL && process.env.MQTT_URL);
const tag = Date.now().toString(36).slice(-6);
const FLOOR = `t${tag}`;
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
  /** 收到的指令 */
  cmds: { cmdId: string; type: string; args: Record<string, unknown> }[];
  /** 自動回 accepted；done 由測試呼叫 finish() */
  reject?: boolean;
}

describe.skipIf(!ready)('派工（e2e）', () => {
  let app: NestExpressApplication;
  let db: Database;
  let adapter: MqttClient;
  let token: string;
  let userId: string;
  let roleId: string;
  const bots: Record<string, Bot> = {};
  const sockets: Socket[] = [];

  const http = () => request(app.getHttpServer());
  const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);
  const tele = (b: Bot) =>
    adapter.publishAsync(
      `rms/robot/${b.code}/telemetry`,
      JSON.stringify({ ts: Date.now(), pose: { x: b.x, y: b.y, yaw: 0, floor: FLOOR }, battery: { pct: b.battery, charging: false }, state: b.state, faults: [] }),
    );
  const ack = (b: Bot, cmdId: string, status: string, error?: { code: string; msg: string }) =>
    adapter.publishAsync(`rms/robot/${b.code}/ack`, JSON.stringify({ cmdId, ts: Date.now(), status, ...(error && { error }) }), { qos: 1 });

  /** 讓機器人狀態在後端生效 */
  async function setBot(code: string, over: Partial<Bot>) {
    Object.assign(bots[code], over);
    await tele(bots[code]);
    await until(() => {
      const l = app.get(FleetService).get(code);
      return l && l.state === bots[code].state && l.battery === bots[code].battery && l.x === bots[code].x;
    });
  }

  /** 這台收到的指令類型 */
  const types = (code: string) => bots[code].cmds.map((c) => c.type);

  /** 完成機器人手上的導航：回 done、回到待命 */
  async function finish(code: string) {
    const b = bots[code];
    const last = b.cmds.filter((c) => c.type === 'navigate' || c.type === 'patrol').at(-1)!;
    await ack(b, last.cmdId, 'done');
    await setBot(code, { state: 'idle', x: last.args.x as number, y: last.args.y as number });
  }

  const createTask = (body: Record<string, unknown>) =>
    auth(http().post('/api/v1/tasks')).send({ kind: 'inspect', priority: 'P3', floorId: FLOOR, ...body });
  const task = async (id: string) => (await auth(http().get(`/api/v1/tasks/${id}`)).expect(200)).body;
  const waitStatus = (id: string, status: string) => until(async () => ((await task(id)).status === status ? task(id) : null));

  beforeAll(async () => {
    process.env.JWT_SECRET ||= 'e2e-secret-e2e-secret-e2e-secret-0';
    process.env.COOKIE_SECURE = 'false';
    db = createDatabase();
    await db.insertInto('floors').values({ id: FLOOR, name: `測試 ${FLOOR}`, sort: 99, width_m: '50', height_m: '30' }).execute();
    for (const [code, x] of [
      [`D${tag}-1`, 5],
      [`D${tag}-2`, 20],
      [`D${tag}-3`, 40],
    ] as const) {
      const { id } = await db
        .insertInto('robots')
        .values({ code, brand: 'anbot', model: 'ANBOT-Y', floor_id: FLOOR, adapter: `e2e-${tag}` })
        .returning('id')
        .executeTakeFirstOrThrow();
      bots[code] = { code, id, x, y: 5, battery: 80, state: 'idle', cmds: [] };
    }
    roleId = (
      await db
        .insertInto('roles')
        .values({ name: `${tag}-派工`, perms: ['monitor', 'robots', 'remote', 'dispatch', 'op.dispatch', 'op.approve', 'op.remote', 'op.estop'] })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    userId = (
      await db
        .insertInto('users')
        .values({ username: `${tag}-disp`, display_name: '派工員', password_hash: await hashPassword(PW), role_id: roleId })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;

    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.listen(0);
    await until(() => app.get(MqttService).connected);
    token = (await http().post('/api/v1/auth/login').send({ username: `${tag}-disp`, password: PW }).expect(200)).body.accessToken;

    // 測試期間關閉審批（審批流程另有一個測試）
    await db.updateTable('settings').set({ value: 'false' }).where('key', '=', 'dispatch.approval').execute();
    app.get(SettingsService).invalidate();

    adapter = await mqtt.connectAsync(process.env.MQTT_URL!, { clientId: `e2e-disp-${tag}`, ...testMqttAuth() });
    await adapter.subscribeAsync(Object.keys(bots).map((c) => `rms/robot/${c}/cmd`), { qos: 1 });
    adapter.on('message', (topic, payload) => {
      const b = bots[topic.split('/')[2]];
      const m = JSON.parse(payload.toString());
      b.cmds.push(m);
      if (b.reject) void ack(b, m.cmdId, 'rejected', { code: 'MOCK_REJECT', msg: 'nope' });
      else if (m.type === 'navigate' || m.type === 'patrol') {
        b.state = 'navigating';
        void ack(b, m.cmdId, 'accepted').then(() => tele(b));
      } else {
        // 真機行為：pause 停在原地（paused）；resume 接續原本的導航（navigating）；stop 回待命
        if (m.type === 'pause') b.state = 'paused';
        if (m.type === 'resume') b.state = 'navigating';
        if (m.type === 'stop') b.state = 'idle';
        void ack(b, m.cmdId, 'accepted')
          .then(() => ack(b, m.cmdId, 'done'))
          .then(() => tele(b));
      }
    });
    await app.get(RobotRegistry).load();
    for (const b of Object.values(bots)) await setBot(b.code, {});
  });

  beforeEach(async () => {
    // 每個測試從乾淨的狀態開始：清掉這個樓層的任務，機器人回到待命
    await db.deleteFrom('task_events').where('task_id', 'in', db.selectFrom('tasks').select('id').where('floor_id', '=', FLOOR)).execute();
    await db.deleteFrom('tasks').where('floor_id', '=', FLOOR).execute();
    for (const [i, b] of Object.values(bots).entries()) {
      b.reject = false;
      b.cmds.length = 0;
      await setBot(b.code, { state: 'idle', battery: 80, x: [5, 20, 40][i], y: 5 });
    }
  });

  afterAll(async () => {
    for (const s of sockets) s.close();
    await adapter?.endAsync();
    if (db) {
      await db.updateTable('settings').set({ value: 'true' }).where('key', '=', 'dispatch.approval').execute();
    }
    if (app) {
      const redis = app.get<Redis>(REDIS);
      await redis.del(...Object.keys(bots).flatMap((c) => [`robot:${c}`, `teleop:${c}`]));
      await app.close();
    }
    if (db) {
      const ids = Object.values(bots).map((b) => b.id);
      await db.deleteFrom('task_events').where('task_id', 'in', db.selectFrom('tasks').select('id').where('floor_id', '=', FLOOR)).execute();
      await db.deleteFrom('tasks').where('floor_id', '=', FLOOR).execute();
      await db.deleteFrom('telemetry').where('robot_id', 'in', ids).execute();
      await db.deleteFrom('robot_state_log').where('robot_id', 'in', ids).execute();
      // 插隊、無車、離線等會經告警管線建告警：連同處理歷程一起清掉
      await db.deleteFrom('alarms').where((eb) => eb.or([eb('robot_id', 'in', ids), eb('floor_id', '=', FLOOR)])).execute();
      await db.deleteFrom('robots').where('id', 'in', ids).execute();
      await db.deleteFrom('floors').where('id', '=', FLOOR).execute();
      await db.deleteFrom('op_logs').where('user_id', '=', userId).execute();
      await db.deleteFrom('users').where('id', '=', userId).execute();
      await db.deleteFrom('roles').where('id', '=', roleId).execute();
      await db.destroy();
    }
  });

  it('自動派到最近的那台；accepted → running、done → done；WebSocket 推 task.updated', async () => {
    const url = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;
    const s = io(url, { path: '/ws', auth: { token }, transports: ['websocket'] });
    sockets.push(s);
    const seen: { code: string; status: string }[] = [];
    s.on('task.updated', (t) => seen.push(t));
    await until(() => s.connected);

    const r = await createTask({ target: { x: 18, y: 5 } }).expect(201);
    expect(r.body).toMatchObject({ code: expect.stringMatching(/^T-\d{8}-\d{4}$/), status: 'queued' });
    const t = await waitStatus(r.body.id, 'running');
    expect(t.robotCode).toBe(`D${tag}-2`); // x=20 最近
    expect(bots[`D${tag}-2`].cmds.at(-1)).toMatchObject({ type: 'navigate', args: { x: 18, y: 5 } });

    await finish(`D${tag}-2`);
    const done = await waitStatus(r.body.id, 'done');
    expect(done.events.map((e: { type: string }) => e.type)).toEqual(['created', 'assigned', 'started', 'done']);
    await until(() => seen.some((x) => x.code === r.body.code && x.status === 'done'));
    expect(seen.filter((x) => x.code === r.body.code).map((x) => x.status)).toEqual(['queued', 'assigned', 'running', 'done']);
  });

  it('電量低於接單門檻（40%）的不選：最近那台 35% → 派給次近的', async () => {
    await setBot(`D${tag}-2`, { battery: 35 });
    const r = await createTask({ target: { x: 18, y: 5 } }).expect(201);
    const t = await waitStatus(r.body.id, 'running');
    expect(t.robotCode).toBe(`D${tag}-1`);
  });

  it('無可用機器人時任務排隊，有車空出後自動派出', async () => {
    for (const b of Object.values(bots)) await setBot(b.code, { state: 'charging' });
    const r = await createTask({ target: { x: 10, y: 5 } }).expect(201);
    await app.get(DispatchService).runFloor(FLOOR);
    expect((await task(r.body.id)).status).toBe('queued');

    await setBot(`D${tag}-3`, { state: 'idle' }); // 變待命會觸發派工
    const t = await waitStatus(r.body.id, 'running');
    expect(t.robotCode).toBe(`D${tag}-3`);
  });

  it('兩個任務同時建立不會派到同一台；車不夠時多出的留在佇列，空出後再派', async () => {
    await setBot(`D${tag}-3`, { state: 'charging' }); // 只剩 2 台可用
    const created = await Promise.all([1, 2, 3, 4].map((i) => createTask({ target: { x: 10 + i, y: 5 } }).expect(201)));
    const ids = created.map((r) => r.body.id);
    await until(async () => (await Promise.all(ids.map(task))).filter((t) => t.status === 'running').length === 2);
    // 再多跑幾輪也不會重複派
    await Promise.all([app.get(DispatchService).runFloor(FLOOR), app.get(DispatchService).runFloor(FLOOR)]);
    const all = await Promise.all(ids.map(task));
    const running = all.filter((t) => t.status === 'running');
    expect(new Set(running.map((t) => t.robotCode)).size).toBe(2);
    expect(all.filter((t) => t.status === 'queued')).toHaveLength(2);
    for (const b of Object.values(bots)) expect(b.cmds.filter((c) => c.type === 'navigate').length).toBeLessThanOrEqual(1);

    await finish(running[0].robotCode);
    await until(async () => (await Promise.all(ids.map(task))).filter((t) => t.status === 'queued').length === 1);
  });

  it('同時大量建單（10 筆、3 台）：每台最多一筆執行中', async () => {
    const created = await Promise.all(Array.from({ length: 10 }, (_, i) => createTask({ target: { x: i * 4, y: 5 } })));
    const ids = created.map((r) => r.body.id);
    await until(async () => (await Promise.all(ids.map(task))).filter((t) => t.status === 'running').length === 3);
    const running = (await Promise.all(ids.map(task))).filter((t) => t.status === 'running');
    expect(new Set(running.map((t) => t.robotCode)).size).toBe(3);
  });

  it('優先級：P1 先派，再 P2，同級先建先做', async () => {
    for (const b of Object.values(bots)) await setBot(b.code, { state: 'charging' });
    const p4 = (await createTask({ priority: 'P4', target: { x: 10, y: 5 } })).body.id;
    const p2 = (await createTask({ priority: 'P2', target: { x: 10, y: 5 } })).body.id;
    const p1 = (await createTask({ priority: 'P1', target: { x: 10, y: 5 } })).body.id;
    await setBot(`D${tag}-1`, { state: 'idle' });
    await waitStatus(p1, 'running');
    await setBot(`D${tag}-2`, { state: 'idle' });
    await waitStatus(p2, 'running');
    expect((await task(p4)).status).toBe('queued');
  });

  it('指定機器人：只派那台，它忙就等', async () => {
    await setBot(`D${tag}-3`, { state: 'charging' });
    const r = await createTask({ robotId: bots[`D${tag}-3`].id, target: { x: 6, y: 5 } }).expect(201);
    await app.get(DispatchService).runFloor(FLOOR);
    expect((await task(r.body.id)).status).toBe('queued');
    await setBot(`D${tag}-3`, { state: 'idle' });
    expect((await waitStatus(r.body.id, 'running')).robotCode).toBe(`D${tag}-3`);
  });

  it('機器人拒絕指令 → failed（附原因）', async () => {
    bots[`D${tag}-1`].reject = true;
    const r = await createTask({ robotId: bots[`D${tag}-1`].id, target: { x: 6, y: 5 } }).expect(201);
    const t = await waitStatus(r.body.id, 'failed');
    expect(t.failReason).toContain('MOCK_REJECT');
  });

  it('離線 → 暫停；恢復上線 → 回佇列並派回同一台', async () => {
    const r = await createTask({ target: { x: 6, y: 5 } }).expect(201);
    const t = await waitStatus(r.body.id, 'running');
    const code = t.robotCode as string;
    await adapter.publishAsync(`rms/robot/${code}/online`, JSON.stringify({ online: false, ts: Date.now() }), { qos: 1 });
    const p = await waitStatus(r.body.id, 'paused');
    expect(p.progress.pausedBy).toBe('offline');
    await setBot(code, { state: 'idle' }); // 遙測恢復 → 上線
    const again = await waitStatus(r.body.id, 'running');
    expect(again.robotCode).toBe(code);
    expect(bots[code].cmds.filter((c) => c.type === 'navigate')).toHaveLength(2);
  });

  it('遙控接管 → 暫停；歸還 → 由派工重送導航給同一台，不送 resume、不派給別台（PR #6 審查第 2 點）', async () => {
    const r = await createTask({ target: { x: 21, y: 5 } }).expect(201);
    const t = await waitStatus(r.body.id, 'running');
    const code = t.robotCode as string;
    expect(code).toBe(`D${tag}-2`);
    await auth(http().post(`/api/v1/robots/${t.robotId}/teleop/acquire`)).expect(200);
    expect((await waitStatus(r.body.id, 'paused')).progress.pausedBy).toBe('teleop');
    await until(() => app.get(FleetService).get(code)?.state === 'paused');

    await auth(http().post(`/api/v1/robots/${t.robotId}/teleop/release`)).expect(204);
    const again = await waitStatus(r.body.id, 'running');
    expect(again.robotCode).toBe(code);
    expect(types(code)).not.toContain('resume');
    expect(types(code).filter((x) => x === 'navigate')).toHaveLength(2);
    // 別台都沒收到導航（真機 resume 會接續舊導航，若同時又回佇列就會派給別台）
    for (const other of Object.keys(bots).filter((c) => c !== code)) expect(types(other)).not.toContain('navigate');

    await finish(code);
    expect((await waitStatus(r.body.id, 'done')).robotCode).toBe(code);
  });

  it('沒有平台任務時歸還遙控照常送 resume', async () => {
    const id = bots[`D${tag}-1`].id;
    await auth(http().post(`/api/v1/robots/${id}/teleop/acquire`)).expect(200);
    await auth(http().post(`/api/v1/robots/${id}/teleop/release`)).expect(204);
    await until(() => types(`D${tag}-1`).includes('resume'));
  });

  it('遙控鎖到期（瀏覽器關掉沒歸還）→ 保底掃描自動恢復（PR #6 審查第 1 點）', async () => {
    const r = await createTask({ target: { x: 21, y: 5 } }).expect(201);
    const t = await waitStatus(r.body.id, 'running');
    await auth(http().post(`/api/v1/robots/${t.robotId}/teleop/acquire`)).expect(200);
    await waitStatus(r.body.id, 'paused');
    await app.get<Redis>(REDIS).del(`teleop:${t.robotCode}`); // 模擬 30 秒沒續期、鎖過期
    await app.get(DispatchService).sweep();
    expect((await waitStatus(r.body.id, 'running')).robotCode).toBe(t.robotCode);
  });

  it('遙控中按急停 → 暫停原因改為急停；解除急停後才恢復（PR #6 審查第 1 點）', async () => {
    const r = await createTask({ target: { x: 21, y: 5 } }).expect(201);
    const t = await waitStatus(r.body.id, 'running');
    const code = t.robotCode as string;
    await auth(http().post(`/api/v1/robots/${t.robotId}/teleop/acquire`)).expect(200);
    await waitStatus(r.body.id, 'paused');
    await auth(http().post(`/api/v1/robots/${t.robotId}/commands`)).send({ type: 'estop' }).expect(202);
    await until(async () => (await task(r.body.id)).progress.pausedBy === 'estop');
    await setBot(code, { state: 'estop' });
    await app.get(DispatchService).sweep();
    expect((await task(r.body.id)).status).toBe('paused'); // 還在急停
    await auth(http().post(`/api/v1/robots/${t.robotId}/commands`)).send({ type: 'estop_release' }).expect(202);
    await setBot(code, { state: 'idle' });
    expect((await waitStatus(r.body.id, 'running')).robotCode).toBe(code);
  });

  it('使用者對執行中的機器人按停止 → 任務 failed（人工介入）', async () => {
    const r = await createTask({ target: { x: 6, y: 5 } }).expect(201);
    const t = await waitStatus(r.body.id, 'running');
    await auth(http().post(`/api/v1/robots/${t.robotId}/commands`)).send({ type: 'stop' }).expect(202);
    expect((await waitStatus(r.body.id, 'failed')).failReason).toContain('人工介入');
  });

  it('取消執行中的任務：任務 cancelled，機器人收到 stop', async () => {
    const r = await createTask({ target: { x: 6, y: 5 } }).expect(201);
    const t = await waitStatus(r.body.id, 'running');
    await auth(http().post(`/api/v1/tasks/${r.body.id}/cancel`)).expect(200);
    expect((await task(r.body.id)).status).toBe('cancelled');
    await until(() => bots[t.robotCode].cmds.some((c) => c.type === 'stop'));
    // 已結束的任務不能再取消
    const again = await auth(http().post(`/api/v1/tasks/${r.body.id}/cancel`)).expect(409);
    expect(again.body.error.code).toBe('INVALID_STATE');
  });

  it('審批開啟：非 P1 進待審批不會派出；核准後才派；P1 直接排隊；駁回需理由', async () => {
    await db.updateTable('settings').set({ value: 'true' }).where('key', '=', 'dispatch.approval').execute();
    app.get(SettingsService).invalidate();
    try {
      const p3 = (await createTask({ target: { x: 6, y: 5 } }).expect(201)).body;
      expect(p3.status).toBe('pending_approval');
      await app.get(DispatchService).runFloor(FLOOR);
      expect((await task(p3.id)).status).toBe('pending_approval');
      await auth(http().post(`/api/v1/tasks/${p3.id}/approve`)).expect(200);
      expect((await waitStatus(p3.id, 'running')).approvedBy).toBe(userId);

      const p1 = (await createTask({ priority: 'P1', target: { x: 30, y: 5 } }).expect(201)).body;
      expect(p1.status).toBe('queued');

      const other = (await createTask({ target: { x: 6, y: 5 } }).expect(201)).body;
      await auth(http().post(`/api/v1/tasks/${other.id}/reject`)).send({}).expect(400);
      await auth(http().post(`/api/v1/tasks/${other.id}/reject`)).send({ reason: '重複' }).expect(200);
      expect(await task(other.id)).toMatchObject({ status: 'rejected', rejectReason: '重複' });
    } finally {
      await db.updateTable('settings').set({ value: 'false' }).where('key', '=', 'dispatch.approval').execute();
      app.get(SettingsService).invalidate();
    }
  });

  it('建單驗證：座標超出樓層、機器人不在這個樓層、樓層不存在都回 400', async () => {
    await createTask({ target: { x: 99, y: 5 } }).expect(400);
    await createTask({ floorId: 'nofloor', target: { x: 1, y: 1 } }).expect(400);
    const other = await db.selectFrom('robots').select('id').where('floor_id', '<>', FLOOR).executeTakeFirst();
    if (other) await createTask({ robotId: other.id, target: { x: 1, y: 1 } }).expect(400);
  });

  it('GET /robots：即時狀態、目前任務', async () => {
    const r = await createTask({ target: { x: 6, y: 5 } }).expect(201);
    const t = await waitStatus(r.body.id, 'running');
    const list = (await auth(http().get(`/api/v1/robots?floor=${FLOOR}`)).expect(200)).body as { code: string; live: { state: string }; task: { code: string } | null }[];
    expect(list).toHaveLength(3);
    const mine = list.find((x) => x.code === t.robotCode)!;
    expect(mine.task?.code).toBe(r.body.code);
    expect(mine.live.state).toBe('navigating');
    const filtered = (await auth(http().get(`/api/v1/robots?floor=${FLOOR}&state=charging`)).expect(200)).body;
    expect(filtered).toEqual([]);
  });

  it('task.updated 只推給有 dispatch 或 monitor 權限的連線（PR #6 審查第 3 點）', async () => {
    const url = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;
    const role = await db.insertInto('roles').values({ name: `${tag}-robots`, perms: ['robots', 'remote'] }).returning('id').executeTakeFirstOrThrow();
    const u = await db
      .insertInto('users')
      .values({ username: `${tag}-rb`, display_name: 'rb', password_hash: await hashPassword(PW), role_id: role.id })
      .returning('id')
      .executeTakeFirstOrThrow();
    try {
      const rbToken = (await http().post('/api/v1/auth/login').send({ username: `${tag}-rb`, password: PW }).expect(200)).body.accessToken;
      const watcher = io(url, { path: '/ws', auth: { token: rbToken }, transports: ['websocket'] });
      const monitorSock = io(url, { path: '/ws', auth: { token }, transports: ['websocket'] });
      sockets.push(watcher, monitorSock);
      const gotRb: unknown[] = [];
      const gotMon: unknown[] = [];
      watcher.on('task.updated', (m) => gotRb.push(m));
      monitorSock.on('task.updated', (m) => gotMon.push(m));
      await until(() => watcher.connected && monitorSock.connected);
      await createTask({ target: { x: 6, y: 5 } }).expect(201);
      await until(() => gotMon.length > 0);
      await new Promise((r) => setTimeout(r, 300));
      expect(gotRb).toEqual([]);
      // robots 權限也打不了 GET /tasks
      await http().get('/api/v1/tasks').set('Authorization', `Bearer ${rbToken}`).expect(403);
    } finally {
      await db.deleteFrom('op_logs').where('user_id', '=', u.id).execute();
      await db.deleteFrom('users').where('id', '=', u.id).execute();
      await db.deleteFrom('roles').where('id', '=', role.id).execute();
    }
  });

  it('任務編號：Redis 流水號遺失時以資料庫最大值 + 1 重試，不會重複（PR #6 審查第 4 點）', async () => {
    const a = (await createTask({ target: { x: 6, y: 5 } }).expect(201)).body;
    const redis = app.get<Redis>(REDIS);
    const day = a.code.slice(2, 10);
    const n = Number(a.code.slice(-4));
    // 模擬 Redis 資料遺失後流水號倒退：下一個 INCR 會產生和 a 相同的編號 → 唯一約束衝突 → 以資料庫最大值重試
    await redis.set(`task:seq:${day}`, String(n - 1));
    const b = (await createTask({ target: { x: 6, y: 5 } }).expect(201)).body;
    expect(b.code).not.toBe(a.code);
    expect(Number(b.code.slice(-4))).toBeGreaterThan(n);
    const c = (await createTask({ target: { x: 6, y: 5 } }).expect(201)).body;
    expect(Number(c.code.slice(-4))).toBe(Number(b.code.slice(-4)) + 1);
  });

  describe('P1 插隊（T-17）', () => {
    const alerts: { type: string; task: { code: string } }[] = [];
    beforeEach(() => {
      alerts.length = 0;
    });
    beforeAll(() => {
      app.get(DispatchService).alerts$.subscribe((a) => alerts.push(a));
    });

    /** 三台都在跑 P3（各自在原位附近） */
    async function allBusy() {
      const ids: string[] = [];
      for (const [i, b] of Object.values(bots).entries()) {
        const r = await createTask({ robotId: b.id, target: { x: [5, 20, 40][i], y: 6 } }).expect(201);
        ids.push(r.body.id);
      }
      for (const id of ids) await waitStatus(id, 'running');
      return ids;
    }

    it('中斷：沒有空車 → 中斷離 P1 目標最近的非 P1；被中斷的任務 paused（preempted_by）；送 stop 再派 P1', async () => {
      const [, mid] = await allBusy();
      const p1 = (await createTask({ priority: 'P1', target: { x: 22, y: 5 } }).expect(201)).body;
      const t = await waitStatus(p1.id, 'running');
      expect(t.robotCode).toBe(`D${tag}-2`); // x=20 最近
      const victim = await task(mid);
      expect(victim).toMatchObject({ status: 'paused', preemptedBy: p1.id, progress: { pausedBy: 'preempt' } });
      const cmds = types(`D${tag}-2`);
      expect(cmds.slice(-2)).toEqual(['stop', 'navigate']);
      expect(alerts.map((a) => a.type)).toEqual(['p1_preempt']);
    });

    it('續做：P1 完成後被中斷的任務回佇列，派回同一台', async () => {
      const [, mid] = await allBusy();
      const p1 = (await createTask({ priority: 'P1', target: { x: 22, y: 5 } }).expect(201)).body;
      await waitStatus(p1.id, 'running');
      await finish(`D${tag}-2`);
      await waitStatus(p1.id, 'done');
      const back = await waitStatus(mid, 'running');
      expect(back.robotCode).toBe(`D${tag}-2`);
      expect(back.events.map((e: { type: string }) => e.type)).toContain('paused');
    });

    it('電量不足的不中斷：最近那台 35% → 中斷次近的', async () => {
      await allBusy();
      await setBot(`D${tag}-2`, { battery: 35 });
      const p1 = (await createTask({ priority: 'P1', target: { x: 22, y: 5 } }).expect(201)).body;
      expect((await waitStatus(p1.id, 'running')).robotCode).not.toBe(`D${tag}-2`);
    });

    it('無車告警：全部都在跑 P1 → 新的 P1 留在佇列最前、發一級告警一次；有車空出後派出', async () => {
      const ids: string[] = [];
      for (const [i, b] of Object.values(bots).entries()) {
        ids.push((await createTask({ priority: 'P1', robotId: b.id, target: { x: [5, 20, 40][i], y: 6 } }).expect(201)).body.id);
      }
      for (const id of ids) await waitStatus(id, 'running');
      const p1 = (await createTask({ priority: 'P1', target: { x: 22, y: 5 } }).expect(201)).body;
      await until(() => alerts.some((a) => a.type === 'p1_no_robot'));
      await app.get(DispatchService).runFloor(FLOOR);
      await app.get(DispatchService).runFloor(FLOOR);
      expect(alerts.filter((a) => a.type === 'p1_no_robot')).toHaveLength(1);
      const q = await task(p1.id);
      expect(q.status).toBe('queued');
      expect(q.progress.noRobotAt).toBeGreaterThan(0);
      expect(q.events.map((e: { type: string }) => e.type)).toContain('no_robot');

      await finish(`D${tag}-1`);
      await waitStatus(p1.id, 'running');
    });

    it('插隊關閉（dispatch.p1Preempt=false）→ 不中斷，發無車告警', async () => {
      await allBusy();
      await db.updateTable('settings').set({ value: 'false' }).where('key', '=', 'dispatch.p1Preempt').execute();
      app.get(SettingsService).invalidate();
      try {
        const p1 = (await createTask({ priority: 'P1', target: { x: 22, y: 5 } }).expect(201)).body;
        await until(() => alerts.some((a) => a.type === 'p1_no_robot'));
        expect((await task(p1.id)).status).toBe('queued');
        expect(alerts.some((a) => a.type === 'p1_preempt')).toBe(false);
      } finally {
        await db.updateTable('settings').set({ value: 'true' }).where('key', '=', 'dispatch.p1Preempt').execute();
        app.get(SettingsService).invalidate();
      }
    });

    it('P1 被取消時，被中斷的任務也會回來', async () => {
      const [, mid] = await allBusy();
      const p1 = (await createTask({ priority: 'P1', target: { x: 22, y: 5 } }).expect(201)).body;
      await waitStatus(p1.id, 'running');
      await auth(http().post(`/api/v1/tasks/${p1.id}/cancel`)).expect(200);
      expect((await waitStatus(mid, 'running')).robotCode).toBe(`D${tag}-2`);
    });
  });

  describe('審批到期自動關閉（T-18）', () => {
    const setSetting = async (key: string, value: string) => {
      await db.updateTable('settings').set({ value }).where('key', '=', key).execute();
      app.get(SettingsService).invalidate();
    };
    let until0: unknown;
    beforeAll(async () => {
      until0 = (await db.selectFrom('settings').select('value').where('key', '=', 'dispatch.approvalUntil').executeTakeFirst())?.value;
    });
    afterAll(async () => {
      await setSetting('dispatch.approvalUntil', JSON.stringify(until0));
      await setSetting('dispatch.approval', 'false');
    });

    it('過了 approvalUntil：審批自動關閉，待審批任務轉入佇列並派出；GET /dispatch/mode 反映', async () => {
      await setSetting('dispatch.approval', 'true');
      await setSetting('dispatch.approvalUntil', '"2099-12-31"');
      const p = (await createTask({ target: { x: 6, y: 5 } }).expect(201)).body;
      expect(p.status).toBe('pending_approval');
      expect((await auth(http().get('/api/v1/dispatch/mode')).expect(200)).body).toMatchObject({ approval: true, approvalUntil: '2099-12-31' });

      await setSetting('dispatch.approvalUntil', '"2020-01-01"');
      await app.get(DispatchService).sweep();
      const t = await waitStatus(p.id, 'running');
      expect(t.events.find((e: { type: string }) => e.type === 'queued').data).toMatchObject({ auto: true });
      expect((await auth(http().get('/api/v1/dispatch/mode')).expect(200)).body).toMatchObject({ approval: false, approvalSetting: false });
      const row = await db.selectFrom('settings').select('value').where('key', '=', 'dispatch.approval').executeTakeFirstOrThrow();
      expect(row.value).toBe(false);
      // PR #7 審查第 2 點：自動關閉寫操作日誌，操作者記系統
      const log = await db
        .selectFrom('op_logs')
        .selectAll()
        .where('action', '=', 'settings.update')
        .where('target', '=', 'dispatch.approval')
        .orderBy('at', 'desc')
        .executeTakeFirstOrThrow();
      expect(log).toMatchObject({ user_id: null, username: '系統', detail: { ok: true, from: true, to: false } });
      expect((log.detail as { reason: string }).reason).toContain('2020-01-01');
      await db.deleteFrom('op_logs').where('id', '=', log.id).execute();
    });

    it('手動關閉審批：待審批任務也自動轉入佇列', async () => {
      await setSetting('dispatch.approval', 'true');
      await setSetting('dispatch.approvalUntil', '"2099-12-31"');
      const p = (await createTask({ target: { x: 6, y: 5 } }).expect(201)).body;
      expect(p.status).toBe('pending_approval');
      await setSetting('dispatch.approval', 'false');
      await app.get(DispatchService).sweep();
      await waitStatus(p.id, 'running');
    });
  });
});
