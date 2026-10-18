/**
 * T-42 音視頻管理、日誌管理、版本管理（e2e）。轉接器以 MQTT 測試連線模擬：收到指令回 done（日誌上傳時把檔案寫進假物件儲存）。
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
import { loadEnv } from '../src/config';
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
const FLOOR = `t${tag}`;
const ADAPTER = `e2e-${tag}`;
const PW = 'Secret123';
const SCREEN = `S${tag}-SCR`.toUpperCase();
const SPEAKER = `S${tag}-SPK`.toUpperCase();
const OFF = `S${tag}-OFF`.toUpperCase();

/** 各格式的開頭位元組（素材上傳依內容判斷格式） */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(492, 2)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 3)]);
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(2997, 1)]);
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(200)]);

async function until<T>(fn: () => T | Promise<T>, ms = 6000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('等待逾時');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(!ready)('音視頻、日誌、版本管理（T-42，e2e）', () => {
  let app: NestExpressApplication;
  let db: Database;
  let adapter: MqttClient;
  let mgr: string;
  let pusher: string;
  let logs: string;
  let none: string;
  const roles: string[] = [];
  const users: string[] = [];
  const ids: Record<string, string> = {};
  const cmds: { code: string; type: string; args: Record<string, unknown> }[] = [];
  /** 下一個 upload_logs 回 failed（已傳了一部分）／上傳超過上限的檔案 */
  let failNextLog = false;
  let bigNextLog = false;
  let heartbeat: NodeJS.Timeout | undefined;
  const storage = new FakeStorage();
  const http = () => request(app.getHttpServer());
  const as = (t: string, r: request.Test) => r.set('Authorization', `Bearer ${t}`);

  async function makeUser(perms: string[]) {
    const r = await db.insertInto('roles').values({ name: `${tag}-${roles.length}-${perms.join('+')}`, perms }).returning('id').executeTakeFirstOrThrow();
    roles.push(r.id);
    const username = `${tag}-${roles.length}`;
    const u = await db.insertInto('users').values({ username, display_name: username, password_hash: await hashPassword(PW), role_id: r.id }).returning('id').executeTakeFirstOrThrow();
    users.push(u.id);
    return (await http().post('/api/v1/auth/login').send({ username, password: PW }).expect(200)).body.accessToken as string;
  }

  beforeAll(async () => {
    process.env.JWT_SECRET ||= 'e2e-secret-e2e-secret-e2e-secret-0';
    process.env.COOKIE_SECURE = 'false';
    db = createDatabase();
    await db.insertInto('floors').values({ id: FLOOR, name: `T42 ${FLOOR}`, sort: 99 }).execute();
    for (const [code, caps] of [
      [SCREEN, ['talk', 'screen']],
      [SPEAKER, ['talk']],
      [OFF, ['talk', 'screen']],
    ] as const) {
      ids[code] = (await db.insertInto('robots').values({ code, brand: 'anbot', model: 'ANBOT-Y', floor_id: FLOOR, adapter: ADAPTER, caps: [...caps] }).returning('id').executeTakeFirstOrThrow()).id;
    }
    const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(StorageService).useValue(storage).compile();
    app = mod.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.listen(0);
    await until(() => app.get(MqttService).connected);
    mgr = await makeUser(['media']);
    pusher = await makeUser(['media', 'op.remote']);
    logs = await makeUser(['logs', 'versions']);
    none = await makeUser(['monitor']);
    adapter = await mqtt.connectAsync(process.env.MQTT_URL!, { clientId: `e2e-t42-${tag}`, ...testMqttAuth() });
    await adapter.subscribeAsync([SCREEN, SPEAKER].map((c) => `rms/robot/${c}/cmd`), { qos: 1 });
    adapter.on('message', (topic, payload) => {
      const m = JSON.parse(payload.toString());
      const code = topic.split('/')[2];
      cmds.push({ code, type: m.type, args: m.args });
      let status = 'done';
      if (m.type === 'upload_logs') {
        // 轉接器把日誌 PUT 到預簽名網址：測試直接寫進假物件儲存
        const key = new URL(m.args.url).pathname.slice(1);
        void storage.put(key, `log of ${code}\n`, 'text/plain');
        if (failNextLog) {
          failNextLog = false;
          status = 'failed';
        } else if (bigNextLog) {
          bigNextLog = false;
          storage.fakeSizes.set(key, 250 * 1024 * 1024);
        }
      }
      void adapter
        .publishAsync(`rms/robot/${code}/ack`, JSON.stringify({ cmdId: m.cmdId, ts: Date.now(), status, ...(status === 'failed' && { error: { code: 'UPLOAD_FAILED', msg: '磁碟錯誤' } }) }), { qos: 1 })
        .catch(() => undefined);
    });
    const beat = () =>
      Promise.all(
        [SCREEN, SPEAKER].map((code) =>
          adapter.publishAsync(`rms/robot/${code}/telemetry`, JSON.stringify({ ts: Date.now(), pose: { x: 1, y: 1, yaw: 0, floor: FLOOR }, battery: { pct: 80, charging: false }, state: 'idle', faults: [] })),
        ),
      );
    await beat();
    // 測試期間保持在線（robot.offlineSec 預設 10 秒）
    heartbeat = setInterval(() => void beat().catch(() => undefined), 2000);
    for (const code of [SCREEN, SPEAKER]) await until(() => app.get(FleetService).get(code)?.online);
    await adapter.publishAsync(`rms/adapter/${ADAPTER}/status`, JSON.stringify({ ts: Date.now(), name: ADAPTER, alive: true, version: '9.8.7' }));
  });

  afterAll(async () => {
    clearInterval(heartbeat);
    await adapter?.endAsync();
    if (app) {
      await app.get<Redis>(REDIS).del(`adapter:${ADAPTER}`, ...Object.keys(ids).map((c) => `robot:${c}`));
      await app.close();
    }
    if (db) {
      const rids = Object.values(ids);
      await db.deleteFrom('broadcast_assets').where('name', 'like', `${tag}%`).execute();
      await db.deleteFrom('telemetry').where('robot_id', 'in', rids).execute();
      await db.deleteFrom('robot_state_log').where('robot_id', 'in', rids).execute();
      await db.deleteFrom('robots').where('id', 'in', rids).execute(); // robot_logs ON DELETE CASCADE
      await db.deleteFrom('floors').where('id', '=', FLOOR).execute();
      await db.deleteFrom('op_logs').where('user_id', 'in', users).execute();
      await db.deleteFrom('users').where('id', 'in', users).execute();
      await db.deleteFrom('roles').where('id', 'in', roles).execute();
      await clearOrphanPendingCommands(db);
      await db.destroy();
    }
  });

  describe('音視頻管理', () => {
    it('上傳音訊、警示圖，新增詞條；格式與大小檢查；列表附預覽網址', async () => {
      const audio = (
        await as(mgr, http().post('/api/v1/assets'))
          .field('kind', 'audio')
          .field('name', `${tag} 請勿進入`)
          .field('durationMs', '2400')
          .attach('file', MP3, { filename: 'warn.mp3', contentType: 'audio/mpeg' })
          .expect(201)
      ).body;
      expect(audio).toMatchObject({ kind: 'audio', name: `${tag} 請勿進入`, mime: 'audio/mpeg', sizeBytes: 3000, durationMs: 2400 });
      expect(audio.url).toMatch(/^http:\/\/fake-s3\/assets\/audio\/.+\.mp3/);
      const img = (await as(mgr, http().post('/api/v1/assets')).field('kind', 'image').attach('file', PNG, { filename: `${tag}禁止進入.png`, contentType: 'image/png' }).expect(201)).body;
      expect(img).toMatchObject({ kind: 'image', name: `${tag}禁止進入`, mime: 'image/png' });
      const text = (await as(mgr, http().post('/api/v1/assets/text')).send({ name: `${tag} 疏散`, text: '請往最近的出口疏散' }).expect(201)).body;
      expect(text).toMatchObject({ kind: 'text', text: '請往最近的出口疏散', url: null });

      await as(mgr, http().post('/api/v1/assets')).field('kind', 'image').attach('file', Buffer.alloc(10), { filename: 'x.exe', contentType: 'application/octet-stream' }).expect(400);
      await as(mgr, http().post('/api/v1/assets')).field('kind', 'image').attach('file', Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024)]), { filename: 'big.png', contentType: 'image/png' }).expect(400);
      // 依檔案內容判斷（PR #18 審查第 1 點）：宣告與內容不符、內容不是音訊或圖片 → 400
      const bad = await as(mgr, http().post('/api/v1/assets')).field('kind', 'image').attach('file', JPG, { filename: 'fake.png', contentType: 'image/png' }).expect(400);
      expect(bad.body.error.message).toBe('檔案內容是 jpg，與宣告的 png 不符');
      await as(mgr, http().post('/api/v1/assets')).field('kind', 'audio').attach('file', PNG, { filename: 'x.mp3', contentType: 'audio/mpeg' }).expect(400);
      await as(mgr, http().post('/api/v1/assets')).field('kind', 'image').attach('file', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), { filename: 'x.png', contentType: 'image/png' }).expect(400);
      const wav = (await as(mgr, http().post('/api/v1/assets')).field('kind', 'audio').field('name', `${tag} wav`).attach('file', WAV, { filename: 'a.wav', contentType: 'audio/x-wav' }).expect(201)).body;
      expect(wav).toMatchObject({ mime: 'audio/wav' });
      expect(wav.url).toMatch(/\.wav\?/);
      await as(mgr, http().delete(`/api/v1/assets/${wav.id}`)).expect(204);
      await as(mgr, http().patch(`/api/v1/assets/${audio.id}`)).send({ text: '音訊不能改內容' }).expect(400);
      expect((await as(mgr, http().patch(`/api/v1/assets/${text.id}`)).send({ text: '請立即疏散' }).expect(200)).body.text).toBe('請立即疏散');
      const list = (await as(mgr, http().get('/api/v1/assets?kind=image')).expect(200)).body;
      expect(list.map((a: { id: string }) => a.id)).toContain(img.id);
      await as(none, http().get('/api/v1/assets')).expect(403);
    });

    it('推送：音訊、詞條送 speak（網址給轉接器），警示圖送 show_image；沒有能力、離線的列出原因；要 op.remote', async () => {
      const all = (await as(mgr, http().get('/api/v1/assets')).expect(200)).body as { id: string; kind: string; name: string }[];
      const mine = (k: string) => all.find((a) => a.kind === k && a.name.startsWith(tag))!;
      const robots = [ids[SCREEN], ids[SPEAKER], ids[OFF]];
      await as(mgr, http().post(`/api/v1/assets/${mine('audio').id}/push`)).send({ robotIds: robots }).expect(403);

      const ra = (await as(pusher, http().post(`/api/v1/assets/${mine('audio').id}/push`)).send({ robotIds: robots }).expect(202)).body;
      expect(ra).toEqual([
        expect.objectContaining({ code: SCREEN, ok: true }),
        expect.objectContaining({ code: SPEAKER, ok: true }),
        expect.objectContaining({ code: OFF, ok: false, reason: '離線' }),
      ]);
      const ri = (await as(pusher, http().post(`/api/v1/assets/${mine('image').id}/push`)).send({ robotIds: robots.slice(0, 2), seconds: 30 }).expect(202)).body;
      expect(ri).toEqual([expect.objectContaining({ code: SCREEN, ok: true }), expect.objectContaining({ code: SPEAKER, ok: false, reason: '沒有螢幕（screen 能力）' })]);
      await as(pusher, http().post(`/api/v1/assets/${mine('text').id}/push`)).send({ robotIds: [ids[SPEAKER]] }).expect(202);

      await until(() => cmds.filter((c) => ['speak', 'show_image'].includes(c.type)).length >= 4);
      const speak = cmds.find((c) => c.type === 'speak' && c.code === SCREEN)!;
      expect(speak.args.audio).toMatchObject({ mime: 'audio/mpeg', bytes: 3000, durationMs: 2400 });
      expect(String((speak.args.audio as { url: string }).url)).toMatch(/^http:\/\/fake-s3-adapter\/assets\/audio\/.+ttl=300/);
      expect(cmds.find((c) => c.type === 'show_image')!.args).toMatchObject({ image: { mime: 'image/png', bytes: 500 }, seconds: 30 });
      expect(cmds.find((c) => c.type === 'speak' && c.args.text)!.args).toEqual({ text: '請立即疏散' });
    });

    it('刪除：連同檔案', async () => {
      const img = ((await as(mgr, http().get('/api/v1/assets?kind=image')).expect(200)).body as { id: string; name: string }[]).find((a) => a.name.startsWith(tag))!;
      const keys = [...storage.objects.keys()].filter((k) => k.startsWith('assets/image/'));
      await as(mgr, http().delete(`/api/v1/assets/${img.id}`)).expect(204);
      expect([...storage.objects.keys()].filter((k) => k.startsWith('assets/image/')).length).toBe(keys.length - 1);
      await as(mgr, http().delete(`/api/v1/assets/${img.id}`)).expect(404);
    });
  });

  describe('日誌管理', () => {
    it('要求上傳 → 轉接器 PUT 到預簽名網址 → 列表可下載；失敗記原因；離線不送', async () => {
      const r = (await as(logs, http().post('/api/v1/robot-logs')).send({ robotId: ids[SCREEN], subsystem: 'motion' }).expect(201)).body;
      expect(r).toMatchObject({ robotCode: SCREEN, subsystem: 'motion', status: 'requested' });
      const up = cmds.find((c) => c.type === 'upload_logs')!;
      expect(String(up.args.url)).toMatch(/^http:\/\/fake-s3-adapter\/robot-logs\/.+\.log\?put=1&ttl=900/);
      expect(up.args.maxBytes).toBe(200 * 1024 * 1024);
      await until(async () => (await as(logs, http().get(`/api/v1/robot-logs?robotId=${ids[SCREEN]}`))).body.items[0]?.status === 'uploaded');
      const item = (await as(logs, http().get(`/api/v1/robot-logs?robotId=${ids[SCREEN]}`)).expect(200)).body.items[0];
      expect(item).toMatchObject({ sizeBytes: `log of ${SCREEN}\n`.length, fileName: expect.stringMatching(new RegExp(`^${SCREEN}_motion_\\d{14}\\.log$`)) });
      const dl = (await as(logs, http().get(`/api/v1/robot-logs/${item.id}/url`)).expect(200)).body;
      expect(dl.url).toContain('dl=');

      failNextLog = true;
      const f = (await as(logs, http().post('/api/v1/robot-logs')).send({ robotId: ids[SPEAKER], subsystem: 'video' }).expect(201)).body;
      await until(async () => (await as(logs, http().get(`/api/v1/robot-logs?robotId=${ids[SPEAKER]}`))).body.items[0]?.status === 'failed');
      expect((await as(logs, http().get(`/api/v1/robot-logs?robotId=${ids[SPEAKER]}`))).body.items[0]).toMatchObject({ id: f.id, error: '磁碟錯誤' });
      await as(logs, http().get(`/api/v1/robot-logs/${f.id}/url`)).expect(409);
      // 失敗時已傳上來的部分也刪掉
      expect([...storage.objects.keys()].filter((k) => k.startsWith(`robot-logs/${SPEAKER}/`))).toEqual([]);

      // 超過上限（PR #18 審查第 2 點）：回報完成也當失敗，檔案刪除
      bigNextLog = true;
      const big = (await as(logs, http().post('/api/v1/robot-logs')).send({ robotId: ids[SPEAKER], subsystem: 'system' }).expect(201)).body;
      await until(async () => (await as(logs, http().get(`/api/v1/robot-logs?robotId=${ids[SPEAKER]}`))).body.items[0]?.status === 'failed');
      expect((await as(logs, http().get(`/api/v1/robot-logs?robotId=${ids[SPEAKER]}`))).body.items[0]).toMatchObject({ id: big.id, error: '檔案 250.0 MB 超過上限 200.0 MB，已刪除', sizeBytes: 250 * 1024 * 1024 });
      expect([...storage.objects.keys()].filter((k) => k.startsWith(`robot-logs/${SPEAKER}/`))).toEqual([]);

      await as(logs, http().post('/api/v1/robot-logs')).send({ robotId: ids[OFF], subsystem: 'system' }).expect(409);
      await as(logs, http().post('/api/v1/robot-logs')).send({ robotId: ids[SCREEN], subsystem: 'kernel' }).expect(400);
      await as(none, http().get('/api/v1/robot-logs')).expect(403);
    });
  });

  describe('版本管理', () => {
    it('後端版本、轉接器（心跳的版本、狀態、所屬機器人）、機器人清單', async () => {
      await until(async () => (await as(logs, http().get('/api/v1/versions'))).body.adapters?.some((a: { name: string; version: string }) => a.name === ADAPTER && a.version === '9.8.7'));
      // 遺囑（沒有版本）不蓋掉上一次回報的版本
      await adapter.publishAsync(`rms/adapter/${ADAPTER}/status`, JSON.stringify({ name: ADAPTER, alive: false }));
      await until(async () => (await as(logs, http().get('/api/v1/versions'))).body.adapters.find((a: { name: string }) => a.name === ADAPTER)?.alive === false);
      const v = (await as(logs, http().get('/api/v1/versions')).expect(200)).body;
      expect(v.backend).toMatchObject({ version: expect.any(String), node: process.version });
      expect(v.adapters.find((a: { name: string }) => a.name === ADAPTER)).toMatchObject({ version: '9.8.7', alive: false, robots: [SCREEN, OFF, SPEAKER].sort() });
      expect(v.robots.find((r: { code: string }) => r.code === SCREEN)).toMatchObject({ adapter: ADAPTER, model: 'ANBOT-Y' });
      await as(none, http().get('/api/v1/versions')).expect(403);
    });
  });
});
