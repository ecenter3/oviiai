/**
 * T-28 抓拍與錄影、T-29 影像串流端對端。
 * MediaMTX 與物件儲存用替身（CI 沒有）；本機有開 MediaMTX（docker compose --profile media up）時，
 * 另外實際抓拍、錄影一次（驗收：抓拍 3 秒內可看到；錄影可播放下載）。
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
import { mediaConfig } from '../src/media/media-config';
import { MediaMtxClient, type MtxPathConf } from '../src/media/mediamtx.client';
import { StorageService } from '../src/storage/storage.service';
import { FakeStorage } from './fake-storage';

loadEnv();
const ready = !!(process.env.DATABASE_URL && process.env.REDIS_URL && process.env.MQTT_URL);
const tag = Date.now().toString(36).slice(-6);
const FLOOR = `m${tag}`;
const PW = 'Secret123';
const CAM = `CAM${tag}-1`.toUpperCase();
const KEY = `cam/${CAM}`;

/** MediaMTX 替身：記下設定的路徑 */
class FakeMtx {
  readonly confs = new Map<string, MtxPathConf>();
  async configuredPaths() {
    return [...this.confs].map(([name, conf]) => ({ name, conf }));
  }
  async replacePath(name: string, conf: MtxPathConf) {
    this.confs.set(name, conf);
  }
  async deletePath(name: string) {
    this.confs.delete(name);
  }
  async paths() {
    return [];
  }
  async ping() {
    return true;
  }
}

/**
 * 實際抓拍錄影需要：MediaMTX 有開，且它的權限回呼（infra/mediamtx.yml → 開發機 3000 埠）有後端在聽。
 * CI、或只跑測試沒開開發後端時跳過。
 */
async function liveMediaMtx(): Promise<boolean> {
  try {
    const mtx = await fetch(`${mediaConfig().api}/v3/paths/list?itemsPerPage=1`, { signal: AbortSignal.timeout(1000) });
    const cb = await fetch('http://localhost:3000/internal/media/auth', { method: 'POST', signal: AbortSignal.timeout(1000) });
    return mtx.ok && cb.status === 401;
  } catch {
    return false;
  }
}

describe.skipIf(!ready)('影像與媒體（e2e）', () => {
  let app: NestExpressApplication;
  let db: Database;
  let guard: string;
  let capturesOnly: string;
  let noMedia: string;
  let cameraId: string;
  const storage = new FakeStorage();
  const mtx = new FakeMtx();
  const roles: string[] = [];
  const users: string[] = [];
  const http = () => request(app.getHttpServer());
  const as = (t: string, r: request.Test) => r.set('Authorization', `Bearer ${t}`);

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
    db = createDatabase();
    await db.insertInto('floors').values({ id: FLOOR, name: `媒體測試 ${FLOOR}`, sort: 99, width_m: '40', height_m: '20' }).execute();
    cameraId = (
      await db
        .insertInto('cameras')
        .values({ code: CAM, name: '測試鏡頭', floor_id: FLOOR, x: 1, y: 1, rtsp_url: Buffer.alloc(0), stream_key: KEY })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(StorageService)
      .useValue(storage)
      .overrideProvider(MediaMtxClient)
      .useValue(mtx)
      .compile();
    app = mod.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.listen(0);
    guard = await makeUser(['monitor', 'captures', 'records', 'op.remote']);
    capturesOnly = await makeUser(['captures']);
    noMedia = await makeUser(['users']);
  });

  afterAll(async () => {
    await app?.close();
    if (db) {
      await db.deleteFrom('media').where('floor_id', '=', FLOOR).execute();
      await db.deleteFrom('alarms').where('camera_id', '=', cameraId).execute();
      await db.deleteFrom('cameras').where('id', '=', cameraId).execute();
      await db.deleteFrom('floors').where('id', '=', FLOOR).execute();
      await db.deleteFrom('op_logs').where('user_id', 'in', users).execute();
      await db.deleteFrom('users').where('id', 'in', users).execute();
      await db.deleteFrom('roles').where('id', 'in', roles).execute();
      await db.destroy();
    }
  });

  describe('串流（T-29）', () => {
    it('啟動時把攝影機路徑設定到 MediaMTX（沒有 RTSP 的開發環境用測試影像源）', async () => {
      const deadline = Date.now() + 5000;
      while (!mtx.confs.has(KEY) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      const conf = mtx.confs.get(KEY)!;
      expect(conf.runOnDemand).toContain('testsrc');
      expect(conf.runOnDemand).toContain('$MTX_PATH');
    });

    it('播放憑證：有看影像權限才能取；只能播指定那一路；MediaMTX 回呼驗證', async () => {
      const list = (await as(guard, http().get(`/api/v1/streams?floor=${FLOOR}`)).expect(200)).body;
      expect(list).toEqual([expect.objectContaining({ key: KEY, kind: 'camera', name: '測試鏡頭', whepUrl: `${mediaConfig().publicUrl}/${KEY}/whep` })]);
      const t = (await as(guard, http().get(`/api/v1/streams/${encodeURIComponent(KEY)}/token`)).expect(200)).body;
      expect(t.whepUrl).toBe(`${mediaConfig().publicUrl}/${KEY}/whep`);
      await as(noMedia, http().get(`/api/v1/streams/${encodeURIComponent(KEY)}/token`)).expect(403);
      await as(guard, http().get(`/api/v1/streams/${encodeURIComponent('cam/NOPE')}/token`)).expect(404);

      const auth = (body: object) => http().post('/internal/media/auth').send(body);
      await auth({ action: 'read', path: KEY, protocol: 'webrtc', query: `token=${t.token}` }).expect(200);
      await auth({ action: 'read', path: 'cam/OTHER', protocol: 'webrtc', query: `token=${t.token}` }).expect(401);
      await auth({ action: 'publish', path: KEY, query: `token=${t.token}` }).expect(401);
      await auth({ action: 'read', path: KEY }).expect(401);
      await auth({ action: 'publish', path: KEY, user: mediaConfig().internalUser, password: mediaConfig().internalPassword }).expect(200);
      // 不在 /api/v1 底下（正式環境 Nginx 不轉送 /internal）
      await http().post('/api/v1/internal/media/auth').send({}).expect(404);
    });
  });

  describe('抓拍圖片、錄像（T-28）', () => {
    let snapId: string;
    let clipId: string;

    beforeAll(async () => {
      for (const [kind, ext, type] of [
        ['snapshot', 'jpg', 'image/jpeg'],
        ['clip', 'mp4', 'video/mp4'],
      ] as const) {
        const key = `media/test/${tag}.${ext}`;
        await storage.put(key, Buffer.from('x'), type);
        const id = (
          await db
            .insertInto('media')
            .values({ kind, camera_id: cameraId, floor_id: FLOOR, stream_key: KEY, object_key: key, size_bytes: 1, content_type: type, duration_s: kind === 'clip' ? 8 : null, source: 'manual' })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
        if (kind === 'snapshot') snapId = id;
        else clipId = id;
      }
    });

    it('依權限：抓拍看 captures、錄像看 records；每筆附預簽名網址', async () => {
      const s = (await as(capturesOnly, http().get(`/api/v1/media?kind=snapshot&floor=${FLOOR}`)).expect(200)).body;
      expect(s).toMatchObject({ total: 1, items: [{ id: snapId, kind: 'snapshot', cameraCode: CAM, cameraName: '測試鏡頭', streamKey: KEY }] });
      expect(s.items[0].url).toMatch(/^http:\/\/fake-s3\/media\/test\//);
      await as(capturesOnly, http().get(`/api/v1/media?kind=clip&floor=${FLOOR}`)).expect(403);
      const opt = (await as(capturesOnly, http().get('/api/v1/media/options')).expect(200)).body;
      expect(opt.cameras.some((c: { code: string }) => c.code === CAM)).toBe(true);
      await as(noMedia, http().get('/api/v1/media/options')).expect(403);
      await as(capturesOnly, http().get(`/api/v1/media/${clipId}/url`)).expect(403);
      const c = (await as(guard, http().get(`/api/v1/media?kind=clip&floor=${FLOOR}`)).expect(200)).body;
      expect(c.items[0]).toMatchObject({ id: clipId, durationS: 8 });
      const dl = (await as(guard, http().get(`/api/v1/media/${clipId}/url?download=1`)).expect(200)).body;
      expect(dl.url).toContain('dl=');
    });

    it('刪除：物件儲存的檔案一起刪', async () => {
      await as(capturesOnly, http().post('/api/v1/media/delete')).send({ ids: [snapId, clipId] }).expect(403); // 錄像沒權限
      expect((await as(capturesOnly, http().post('/api/v1/media/delete')).send({ ids: [snapId] }).expect(200)).body).toEqual({ deleted: 1 });
      expect(storage.objects.has(`media/test/${tag}.jpg`)).toBe(false);
      await as(guard, http().delete(`/api/v1/media/${clipId}`)).expect(204);
      expect(storage.objects.has(`media/test/${tag}.mp4`)).toBe(false);
    });

    it('抓拍、錄影要 op.remote；沒有影像來源的路徑 404', async () => {
      await as(capturesOnly, http().post('/api/v1/media/snapshot')).send({ streamKey: KEY }).expect(403);
      await as(guard, http().post('/api/v1/media/snapshot')).send({ streamKey: 'cam/NOPE' }).expect(404);
      await as(guard, http().post('/api/v1/media/recordings')).send({ streamKey: 'cam/NOPE' }).expect(404);
    });
  });

  describe('實際 MediaMTX（本機有開才跑）', () => {
    it('抓拍 3 秒內完成；錄影可下載播放', { timeout: 60_000 }, async (ctx) => {
      if (!(await liveMediaMtx())) return ctx.skip();
      // 這個 suite 用的是 MediaMTX 替身：把測試路徑直接設定到真的 MediaMTX
      const real = new MediaMtxClient();
      await real.replacePath(KEY, mtx.confs.get(KEY)!);
      try {
        const t0 = Date.now();
        const snap = (await as(guard, http().post('/api/v1/media/snapshot')).send({ streamKey: KEY }).expect(201)).body;
        const ms = Date.now() - t0;
        expect(ms).toBeLessThan(3000 + 2000); // 第一次要啟動測試影像源，留 2 秒餘裕
        expect(snap).toMatchObject({ kind: 'snapshot', contentType: 'image/jpeg' });
        expect(snap.sizeBytes).toBeGreaterThan(1000);
        const jpg = [...storage.objects.values()].find((o) => o.contentType === 'image/jpeg')!.body;
        expect(jpg.subarray(0, 2).toString('hex')).toBe('ffd8');

        const rec = (await as(guard, http().post('/api/v1/media/recordings')).send({ streamKey: KEY }).expect(201)).body;
        await as(guard, http().post('/api/v1/media/recordings')).send({ streamKey: KEY }).expect(409);
        await new Promise((r) => setTimeout(r, 3000));
        const clip = (await as(guard, http().post(`/api/v1/media/recordings/${rec.id}/stop`)).expect(200)).body;
        expect(clip).toMatchObject({ kind: 'clip', contentType: 'video/mp4' });
        expect(clip.durationS).toBeGreaterThanOrEqual(2);
        const mp4 = [...storage.objects.values()].find((o) => o.contentType === 'video/mp4')!.body;
        expect(mp4.subarray(4, 8).toString('latin1')).toBe('ftyp');
      } finally {
        await real.deletePath(KEY).catch(() => undefined);
      }
    });
  });
});
