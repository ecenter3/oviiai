/**
 * T-25 機器人管理、地圖管理、平面圖上傳端對端：真的 PostgreSQL、Redis、EMQX；物件儲存用記憶體替身。
 * 驗收：新增機器人後立即被接受（監控頁出現），轉接器設定立即包含它。
 */
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type Redis from 'ioredis';
import { sql } from 'kysely';
import mqtt, { type MqttClient } from 'mqtt';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { hashPassword } from '../src/auth/password';
import { dataEncKey, loadEnv } from '../src/config';
import { createDatabase, type Database } from '../src/db/database.module';
import { FleetService } from '../src/fleet/fleet.service';
import { MqttService } from '../src/mqtt/mqtt.service';
import { REDIS } from '../src/redis/redis.module';
import { StorageService } from '../src/storage/storage.service';
import { FakeStorage } from './fake-storage';
import { testMqttAuth } from './mqtt-test-auth';
import { clearOrphanPendingCommands } from './pending-commands';

loadEnv();
const ready = !!(process.env.DATABASE_URL && process.env.REDIS_URL && process.env.MQTT_URL);
const tag = Date.now().toString(36).slice(-6);
const FLOOR = `s${tag}`;
const ADAPTER = `e2e-${tag}`;
const ADAPTER_KEY = `adapter-key-${tag}-0123456789`;
const PW = 'Secret123';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

async function until<T>(fn: () => T | Promise<T>, ms = 6000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('等待逾時');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(!ready)('機器人管理、地圖管理（e2e）', () => {
  let app: NestExpressApplication;
  let db: Database;
  let pub: MqttClient;
  let admin: string;
  let viewer: string;
  const storage = new FakeStorage();
  const roles: string[] = [];
  const users: string[] = [];
  const codes: string[] = [];

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
    await db.insertInto('floors').values({ id: FLOOR, name: `場域測試 ${FLOOR}`, sort: 99, width_m: '40', height_m: '20' }).execute();
    const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(StorageService).useValue(storage).compile();
    app = mod.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.listen(0);
    await until(() => app.get(MqttService).connected);
    pub = await mqtt.connectAsync(process.env.MQTT_URL!, { clientId: `e2e-site-${tag}`, ...testMqttAuth() });
    admin = await makeUser(['robotmgr', 'maps', 'robots', 'monitor']);
    viewer = await makeUser(['monitor']);
  });

  afterAll(async () => {
    await pub?.endAsync();
    if (app) {
      for (const c of codes) await app.get<Redis>(REDIS).del(`robot:${c}`);
      await app.close();
    }
    if (db) {
      const ids = (await db.selectFrom('robots').select('id').where('floor_id', '=', FLOOR).execute()).map((r) => r.id);
      if (ids.length) {
        await db.deleteFrom('alarms').where('robot_id', 'in', ids).execute();
        await db.deleteFrom('telemetry').where('robot_id', 'in', ids).execute();
        await db.deleteFrom('robot_state_log').where('robot_id', 'in', ids).execute();
      }
      await db.deleteFrom('chargers').where('floor_id', '=', FLOOR).execute();
      await db.deleteFrom('cameras').where('floor_id', '=', FLOOR).execute();
      await db.deleteFrom('robots').where('floor_id', '=', FLOOR).execute();
      await db.deleteFrom('alarms').where('floor_id', '=', FLOOR).execute();
      await db.deleteFrom('floors').where('id', '=', FLOOR).execute();
      await db.deleteFrom('op_logs').where('user_id', 'in', users).execute();
      await db.deleteFrom('users').where('id', 'in', users).execute();
      await db.deleteFrom('roles').where('id', 'in', roles).execute();
      await clearOrphanPendingCommands(db);
      await db.destroy();
    }
  });

  describe('機器人管理', () => {
    const CODE = `M${tag}-1`.toUpperCase();

    it('新增 → 立即接受遙測（監控頁出現）；轉接器設定立即包含它；密碼加密存放、不回傳', async () => {
      codes.push(CODE);
      const r = await as(admin, http().post('/api/v1/robots'))
        .send({ code: CODE, brand: 'anbot', model: 'ANBOT-Y', floorId: FLOOR, adapter: ADAPTER, conn: { host: '10.0.0.8', port: 9000 }, secret: 'robot-pass', caps: ['ptz', 'light'] })
        .expect(201);
      expect(r.body.code).toBe(CODE);

      await pub.publishAsync(
        `rms/robot/${CODE}/telemetry`,
        JSON.stringify({ ts: Date.now(), pose: { x: 3, y: 4, yaw: 0, floor: FLOOR }, battery: { pct: 77, charging: false }, state: 'idle', faults: [] }),
      );
      await until(() => app.get(FleetService).get(CODE)?.online);

      const row = await db.selectFrom('robots').select(['conn', 'conn_secret']).where('code', '=', CODE).executeTakeFirstOrThrow();
      expect(row.conn).toEqual({ host: '10.0.0.8', port: 9000 });
      expect(row.conn_secret!.toString('latin1')).not.toContain('robot-pass');

      const list = (await as(admin, http().get('/api/v1/robots/manage')).expect(200)).body;
      const me = list.find((x: { code: string }) => x.code === CODE);
      expect(me).toMatchObject({ hasSecret: true, online: true, caps: ['ptz', 'light'], enabled: true });
      expect(JSON.stringify(me)).not.toContain('robot-pass');

      const cfg = (await http().get(`/api/v1/adapter-config/${ADAPTER}`).set('X-Adapter-Key', ADAPTER_KEY).expect(200)).body;
      expect(cfg.robots).toEqual([expect.objectContaining({ code: CODE, floor: FLOOR, secret: 'robot-pass', conn: { host: '10.0.0.8', port: 9000 } })]);
    });

    it.skipIf(!process.env.EMQX_JWT_SECRET)('轉接器的 MQTT 憑證只能發布、訂閱自己機器人的主題（安全收尾 e）', async () => {
      const cfg = (await http().get(`/api/v1/adapter-config/${ADAPTER}`).set('X-Adapter-Key', ADAPTER_KEY).expect(200)).body;
      expect(cfg.mqtt).toMatchObject({ username: ADAPTER, password: expect.any(String) });
      const OTHER = `X${tag}-9`.toUpperCase();
      // 帳號必須和憑證相符；沒帶憑證連不上
      await expect(mqtt.connectAsync(process.env.MQTT_URL!, { clientId: `e2e-spoof-${tag}`, username: 'backend', password: cfg.mqtt.password, reconnectPeriod: 0 })).rejects.toThrow();
      await expect(mqtt.connectAsync(process.env.MQTT_URL!, { clientId: `e2e-anon-${tag}`, reconnectPeriod: 0 })).rejects.toThrow();

      const ad = await mqtt.connectAsync(process.env.MQTT_URL!, { clientId: `e2e-acl-${tag}`, username: cfg.mqtt.username, password: cfg.mqtt.password });
      try {
        await ad.subscribeAsync(`rms/robot/${CODE}/cmd`, { qos: 1 });
        await expect(ad.subscribeAsync(`rms/robot/${OTHER}/cmd`)).rejects.toThrow(/Subscribe error/);
        await expect(ad.subscribeAsync('rms/#')).rejects.toThrow(/Subscribe error/);
        // 只看這個測試送的內容（訂閱時可能收到別的轉接器留下的 retained 狀態）
        const mine = new Set(['own', 'spoof', 'fake-cmd', 'other-adapter']);
        const seen: string[] = [];
        pub.on('message', (t, m) => mine.has(m.toString()) && seen.push(`${t} ${m.toString()}`));
        await pub.subscribeAsync([`rms/robot/${CODE}/event`, `rms/robot/${OTHER}/#`, `rms/robot/${CODE}/cmd`, `rms/adapter/${ADAPTER}-x/status`]);
        await ad.publishAsync(`rms/robot/${CODE}/event`, 'own', { qos: 1 });
        await ad.publishAsync(`rms/robot/${OTHER}/telemetry`, 'spoof', { qos: 1 });
        await ad.publishAsync(`rms/robot/${CODE}/cmd`, 'fake-cmd', { qos: 1 });
        await ad.publishAsync(`rms/adapter/${ADAPTER}-x/status`, 'other-adapter', { qos: 1 });
        await until(() => seen.length > 0);
        await new Promise((r) => setTimeout(r, 300));
        expect(seen).toEqual([`rms/robot/${CODE}/event own`]);
      } finally {
        await ad.endAsync();
      }
    });

    it('來源網段不在 ADAPTER_ALLOWED_CIDRS → 403，大寫路徑也一樣；正式環境沒設定一律 403（PR #11 審查第 1 點）', async () => {
      const before = { cidrs: process.env.ADAPTER_ALLOWED_CIDRS, env: process.env.NODE_ENV };
      try {
        process.env.ADAPTER_ALLOWED_CIDRS = '10.99.0.0/16';
        for (const path of [`/api/v1/adapter-config/${ADAPTER}`, `/api/v1/Adapter-Config/${ADAPTER}`, `/api/v1/ADAPTER-CONFIG/${ADAPTER}`]) {
          const r = await http().get(path).set('X-Adapter-Key', ADAPTER_KEY).expect(403);
          expect(r.body.error.code).toBe('FORBIDDEN');
          expect(JSON.stringify(r.body)).not.toContain('robot-pass');
        }
        // 允許的網段：Express 路由不分大小寫，大寫路徑一樣打到這個端點——所以後端一定要自己擋
        process.env.ADAPTER_ALLOWED_CIDRS = '127.0.0.1/32,::1/128';
        await http().get(`/api/v1/Adapter-Config/${ADAPTER}`).set('X-Adapter-Key', ADAPTER_KEY).expect(200);
        delete process.env.ADAPTER_ALLOWED_CIDRS;
        process.env.NODE_ENV = 'production';
        await http().get(`/api/v1/adapter-config/${ADAPTER}`).set('X-Adapter-Key', ADAPTER_KEY).expect(403);
      } finally {
        if (before.cidrs === undefined) delete process.env.ADAPTER_ALLOWED_CIDRS;
        else process.env.ADAPTER_ALLOWED_CIDRS = before.cidrs;
        if (before.env === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = before.env;
      }
    });

    it('轉接器金鑰錯誤或沒設定 → 401', async () => {
      await http().get(`/api/v1/adapter-config/${ADAPTER}`).set('X-Adapter-Key', 'wrong-key-wrong-key').expect(401);
      await http().get(`/api/v1/adapter-config/${ADAPTER}`).expect(401);
      await http().get(`/api/v1/adapter-config/nokey-${tag}`).set('X-Adapter-Key', ADAPTER_KEY).expect(401);
    });

    it('驗證：代碼重複、格式、品牌、樓層', async () => {
      const base = { brand: 'anbot', model: 'ANBOT-Y', floorId: FLOOR, adapter: ADAPTER };
      const dup = await as(admin, http().post('/api/v1/robots')).send({ ...base, code: CODE }).expect(400);
      expect(dup.body.error.details.fields.code).toBe('代碼已存在');
      await as(admin, http().post('/api/v1/robots')).send({ ...base, code: 'lower-case' }).expect(400);
      await as(admin, http().post('/api/v1/robots')).send({ ...base, code: `Z${tag}`.toUpperCase(), brand: 'tesla' }).expect(400);
      await as(admin, http().post('/api/v1/robots')).send({ ...base, code: `Z${tag}`.toUpperCase(), floorId: 'nope' }).expect(400);
      await as(viewer, http().post('/api/v1/robots')).send({ ...base, code: `Z${tag}`.toUpperCase() }).expect(403);
    });

    it('修改、停用：停用後從即時狀態移除、轉接器設定不再包含；可重新啟用', async () => {
      const id = (await db.selectFrom('robots').select('id').where('code', '=', CODE).executeTakeFirstOrThrow()).id;
      await as(admin, http().patch(`/api/v1/robots/${id}`)).send({ model: 'ANBOT-Y2', secret: null }).expect(200);
      expect((await db.selectFrom('robots').select(['model', 'conn_secret']).where('id', '=', id).executeTakeFirstOrThrow())).toMatchObject({ model: 'ANBOT-Y2', conn_secret: null });

      await as(admin, http().delete(`/api/v1/robots/${id}`)).expect(200);
      await until(() => !app.get(FleetService).get(CODE));
      const cfg = (await http().get(`/api/v1/adapter-config/${ADAPTER}`).set('X-Adapter-Key', ADAPTER_KEY).expect(200)).body;
      expect(cfg.robots).toEqual([]);
      expect((await as(admin, http().get('/api/v1/robots/manage')).expect(200)).body.find((x: { code: string }) => x.code === CODE).enabled).toBe(false);

      await as(admin, http().patch(`/api/v1/robots/${id}`)).send({ enabled: true }).expect(200);
      expect((await http().get(`/api/v1/adapter-config/${ADAPTER}`).set('X-Adapter-Key', ADAPTER_KEY).expect(200)).body.robots).toHaveLength(1);
      const log = await db.selectFrom('op_logs').select('action').where('user_id', '=', users[0]).where('target', '=', `robot:${id}`).execute();
      expect(log.map((l) => l.action).sort()).toEqual(['robot.disable', 'robot.update', 'robot.update']);
    });
  });

  describe('地圖管理', () => {
    it('上傳平面圖：只收 PNG／JPEG／WebP，看內容不看副檔名；GET /floors 帶網址、登入可讀；換圖刪舊檔', async () => {
      await as(admin, http().post(`/api/v1/floors/${FLOOR}/plan`)).attach('file', Buffer.from('<svg onload="x()"/>'), 'plan.png').expect(400);
      await as(viewer, http().post(`/api/v1/floors/${FLOOR}/plan`)).attach('file', PNG, 'plan.png').expect(403);
      const up = (await as(admin, http().post(`/api/v1/floors/${FLOOR}/plan`)).attach('file', PNG, 'whatever.bin').expect(201)).body;
      expect(up).toMatchObject({ type: 'image/png', bytes: PNG.length });
      const floor = (await as(viewer, http().get('/api/v1/floors')).expect(200)).body.find((f: { id: string }) => f.id === FLOOR);
      expect(floor.planUrl).toBe(up.planUrl);
      const img = await as(viewer, http().get(up.planUrl.replace('/api/v1', '/api/v1'))).buffer(true).expect(200);
      expect(img.headers['content-type']).toBe('image/png');
      expect(Buffer.compare(img.body as Buffer, PNG)).toBe(0);
      await http().get(up.planUrl).expect(401);

      const firstKey = [...storage.objects.keys()].find((k) => k.startsWith(`plans/${FLOOR}-`))!;
      await new Promise((r) => setTimeout(r, 5));
      const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);
      await as(admin, http().post(`/api/v1/floors/${FLOOR}/plan`)).attach('file', jpg, 'b.jpg').expect(201);
      expect(storage.objects.has(firstKey)).toBe(false);
      await as(admin, http().delete(`/api/v1/floors/${FLOOR}/plan`)).expect(200);
      expect([...storage.objects.keys()].filter((k) => k.startsWith(`plans/${FLOOR}-`))).toEqual([]);
    });

    it('平面圖太大 → 413', async () => {
      const big = Buffer.concat([PNG, Buffer.alloc(16 * 1024 * 1024)]);
      const r = await as(admin, http().post(`/api/v1/floors/${FLOOR}/plan`)).attach('file', big, 'big.png');
      expect(r.status).toBe(413);
      expect(r.body.error.message).toBe('檔案太大');
    });

    it('充電樁：新增、座標必須在樓層內、使用中不可刪', async () => {
      await as(admin, http().post('/api/v1/chargers')).send({ code: `C${tag}-9`.toUpperCase(), floorId: FLOOR, x: 50, y: 1, brand: 'anbot' }).expect(400);
      const c = (await as(admin, http().post('/api/v1/chargers')).send({ code: `C${tag}-1`.toUpperCase(), floorId: FLOOR, x: 2, y: 2, brand: 'anbot', robotDock: { id: 'dock-1' } }).expect(201)).body;
      await as(admin, http().patch(`/api/v1/chargers/${c.id}`)).send({ x: 3 }).expect(200);
      const list = (await as(viewer, http().get(`/api/v1/chargers?floor=${FLOOR}`)).expect(200)).body;
      expect(list[0]).toMatchObject({ code: c.code, x: 3, brand: 'anbot', robotDock: { id: 'dock-1' } });

      const rid = (await db.selectFrom('robots').select('id').where('floor_id', '=', FLOOR).executeTakeFirstOrThrow()).id;
      await db.updateTable('chargers').set({ occupied_by: rid }).where('id', '=', c.id).execute();
      await as(admin, http().delete(`/api/v1/chargers/${c.id}`)).expect(409);
      await db.updateTable('chargers').set({ occupied_by: null }).where('id', '=', c.id).execute();
      await as(admin, http().delete(`/api/v1/chargers/${c.id}`)).expect(204);
    });

    it('攝影機：RTSP 帳密加密存放、清單不回傳；stream key 由代碼產生', async () => {
      const code = `CAM${tag}-1`.toUpperCase();
      await as(admin, http().post('/api/v1/cameras')).send({ code, name: '測試門口', floorId: FLOOR, x: 1, y: 1, rtspUrl: 'http://x' }).expect(400);
      const c = (await as(admin, http().post('/api/v1/cameras')).send({ code, name: '測試門口', floorId: FLOOR, x: 1, y: 1, rtspUrl: 'rtsp://admin:cam-secret@10.0.0.20/stream1' }).expect(201)).body;
      const row = await db
        .selectFrom('cameras')
        .select(['stream_key', 'rtsp_url'])
        .select(sql<string>`pgp_sym_decrypt(rtsp_url, ${dataEncKey()})`.as('plain'))
        .where('id', '=', c.id)
        .executeTakeFirstOrThrow();
      expect(row.rtsp_url.toString('latin1')).not.toContain('cam-secret');
      expect(row.plain).toBe('rtsp://admin:cam-secret@10.0.0.20/stream1');
      expect(row.stream_key).toBe(`cam/${code}`);
      const list = (await as(viewer, http().get(`/api/v1/cameras?floor=${FLOOR}`)).expect(200)).body;
      expect(list[0]).toMatchObject({ code, hasRtsp: true });
      expect(JSON.stringify(list)).not.toContain('cam-secret');

      // 改 RTSP、以及驗證失敗（400）的請求都會寫操作日誌：日誌裡不能有帳密（PR #10 審查第 1 點）
      await as(admin, http().patch(`/api/v1/cameras/${c.id}`)).send({ rtspUrl: 'rtsp://admin:new-secret@10.0.0.21/stream1', name: '改 rtsp://ops:in-name@x/y' }).expect(200);
      await as(admin, http().post('/api/v1/cameras')).send({ code: `${code}X`, name: 'x', floorId: FLOOR, x: 999, y: 1, rtspUrl: 'rtsp://admin:bad-secret@10.0.0.9/s' }).expect(400);
      const logs = await db.selectFrom('op_logs').select(['action', 'detail', 'target']).where('user_id', '=', users[0]).where('action', 'like', 'camera.%').execute();
      expect(logs.map((l) => l.action).sort()).toEqual(['camera.create', 'camera.create', 'camera.create', 'camera.update']);
      const dump = JSON.stringify(logs);
      expect(dump).not.toMatch(/cam-secret|new-secret|bad-secret|in-name|admin:|ops:/);
      expect(dump).toContain('rtsp://***:***@x/y');
      await as(admin, http().delete(`/api/v1/cameras/${c.id}`)).expect(204);
    });
  });
});
