/**
 * T-31 雙向對講端對端：真的 PostgreSQL、Redis、EMQX；MediaMTX 用替身（控制「有沒有推流者」），
 * 假轉接器收 cmd、回 ack。
 */
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import mqtt, { type MqttClient } from 'mqtt';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { hashPassword } from '../src/auth/password';
import { loadEnv } from '../src/config';
import { createDatabase, type Database } from '../src/db/database.module';
import { FleetService } from '../src/fleet/fleet.service';
import { mediaConfig } from '../src/media/media-config';
import { MediaMtxClient, type MtxPathConf } from '../src/media/mediamtx.client';
import { verifyStreamToken } from '../src/media/stream-token';
import { MqttService } from '../src/mqtt/mqtt.service';

loadEnv();
const ready = !!(process.env.DATABASE_URL && process.env.REDIS_URL && process.env.MQTT_URL);
const tag = Date.now().toString(36).slice(-6);
const FLOOR = `i${tag}`;
const PW = 'Secret123';
const LIVE = `I${tag}-LIVE`.toUpperCase();
const PTT = `I${tag}-PTT`.toUpperCase();
const NONE = `I${tag}-NONE`.toUpperCase();

async function until<T>(fn: () => T | Promise<T>, ms = 6000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error('等待逾時');
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** MediaMTX 替身：記下設定的路徑；publishing 決定 talk 路徑是否有推流者 */
class FakeMtx {
  readonly confs = new Map<string, MtxPathConf>();
  publishing = new Set<string>();
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
    return [...this.publishing].map((name) => ({ name, ready: true, readers: [], source: null }));
  }
  async ping() {
    return true;
  }
}

describe.skipIf(!ready)('雙向對講（e2e，T-31）', () => {
  let app: NestExpressApplication;
  let db: Database;
  let adapter: MqttClient;
  let guard: string;
  let viewer: string;
  const roles: string[] = [];
  const users: string[] = [];
  const ids: Record<string, string> = {};
  const cmds: { code: string; type: string; args: Record<string, unknown> }[] = [];
  const mtx = new FakeMtx();
  const http = () => request(app.getHttpServer());
  const as = (t: string, r: request.Test) => r.set('Authorization', `Bearer ${t}`);

  async function makeUser(perms: string[]) {
    const r = await db.insertInto('roles').values({ name: `${tag}-${roles.length}-${perms.join('+')}`, perms }).returning('id').executeTakeFirstOrThrow();
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
  const online = async (code: string) => {
    await adapter.publishAsync(
      `rms/robot/${code}/telemetry`,
      JSON.stringify({ ts: Date.now(), pose: { x: 1, y: 1, yaw: 0, floor: FLOOR }, battery: { pct: 80, charging: false }, state: 'idle', faults: [] }),
    );
    await until(() => app.get(FleetService).get(code)?.online);
  };

  beforeAll(async () => {
    process.env.JWT_SECRET ||= 'e2e-secret-e2e-secret-e2e-secret-0';
    process.env.COOKIE_SECURE = 'false';
    db = createDatabase();
    await db.insertInto('floors').values({ id: FLOOR, name: `對講測試 ${FLOOR}`, sort: 99 }).execute();
    for (const [code, caps] of [
      [LIVE, ['talk_live', 'talk']],
      [PTT, ['talk']],
      [NONE, ['ptz']],
    ] as const) {
      const r = await db
        .insertInto('robots')
        .values({ code, brand: 'unitree', model: 'B2', floor_id: FLOOR, adapter: `e2e-${tag}`, caps: [...caps] })
        .returning('id')
        .executeTakeFirstOrThrow();
      ids[code] = r.id;
    }
    const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(MediaMtxClient).useValue(mtx).compile();
    app = mod.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.listen(0);
    await until(() => app.get(MqttService).connected);
    guard = await makeUser(['remote', 'op.remote']);
    viewer = await makeUser(['remote']);
    adapter = await mqtt.connectAsync(process.env.MQTT_URL!, { clientId: `e2e-talk-${tag}` });
    await adapter.subscribeAsync([LIVE, PTT, NONE].map((c) => `rms/robot/${c}/cmd`), { qos: 1 });
    adapter.on('message', (topic, payload) => {
      const m = JSON.parse(payload.toString());
      const code = topic.split('/')[2];
      cmds.push({ code, type: m.type, args: m.args });
      void adapter.publishAsync(`rms/robot/${code}/ack`, JSON.stringify({ cmdId: m.cmdId, ts: Date.now(), status: 'done' }), { qos: 1 }).catch(() => undefined);
    });
    for (const c of [LIVE, PTT, NONE]) await online(c);
  });

  afterAll(async () => {
    await adapter?.endAsync();
    await app?.close();
    if (db) {
      const rids = Object.values(ids);
      await db.deleteFrom('telemetry').where('robot_id', 'in', rids).execute();
      await db.deleteFrom('robot_state_log').where('robot_id', 'in', rids).execute();
      await db.deleteFrom('robots').where('id', 'in', rids).execute();
      await db.deleteFrom('floors').where('id', '=', FLOOR).execute();
      await db.deleteFrom('op_logs').where('user_id', 'in', users).execute();
      await db.deleteFrom('users').where('id', 'in', users).execute();
      await db.deleteFrom('roles').where('id', 'in', roles).execute();
      await db.destroy();
    }
  });

  it('能接收即時音訊的機器人才建對講路徑（只允許一個推流者）；對講路徑不出現在播放清單、不發播放憑證', async () => {
    await until(() => mtx.confs.has(`talk/${LIVE}`));
    expect(mtx.confs.get(`talk/${LIVE}`)).toEqual({ source: 'publisher', sourceOnDemand: false, overridePublisher: false });
    expect(mtx.confs.has(`talk/${PTT}`)).toBe(false);
    const list = (await as(guard, http().get(`/api/v1/streams?floor=${FLOOR}`)).expect(200)).body;
    expect(JSON.stringify(list)).not.toContain('talk/');
    await as(guard, http().get(`/api/v1/streams/${encodeURIComponent(`talk/${LIVE}`)}/token`)).expect(404);
  });

  it('方案 A：取推流憑證 → 推上來後通知 → 轉接器收到 talk_start（帶 read 憑證）；掛斷送 talk_stop', async () => {
    await as(viewer, http().post(`/api/v1/robots/${ids[LIVE]}/talk`)).expect(403);
    await as(guard, http().post(`/api/v1/robots/${ids[PTT]}/talk`)).expect(409); // 沒有 talk_live
    const r = (await as(guard, http().post(`/api/v1/robots/${ids[LIVE]}/talk`)).expect(200)).body;
    expect(r.whipUrl).toBe(`${mediaConfig().publicUrl}/talk/${LIVE}/whip`);
    expect(verifyStreamToken(r.token, `talk/${LIVE}`, Date.now(), 'publish')).toBeTruthy();
    expect(verifyStreamToken(r.token, `talk/${LIVE}`, Date.now(), 'read')).toBeNull();

    // MediaMTX 回呼：publish 憑證能推、不能讀
    const auth = (body: Record<string, unknown>) => http().post('/internal/media/auth').send(body);
    await auth({ action: 'publish', path: `talk/${LIVE}`, protocol: 'webrtc', query: `token=${r.token}` }).expect(200);
    await auth({ action: 'read', path: `talk/${LIVE}`, protocol: 'webrtc', query: `token=${r.token}` }).expect(401);

    mtx.publishing.add(`talk/${LIVE}`);
    await as(guard, http().post(`/api/v1/robots/${ids[LIVE]}/talk/started`)).expect(200);
    const start = await until(() => cmds.find((c) => c.code === LIVE && c.type === 'talk_start'));
    expect(start.args).toMatchObject({ url: `${mediaConfig().adapterRtsp}/talk/${LIVE}`, user: 'talk' });
    expect(String(start.args.token).length).toBeLessThan(40); // ffmpeg 的 RTSP 帳密上限 128 bytes
    // 轉接器用帳號 talk＋這個憑證拉流
    await auth({ action: 'read', path: `talk/${LIVE}`, protocol: 'rtsp', user: 'talk', password: start.args.token }).expect(200);
    await auth({ action: 'read', path: `talk/${LIVE}`, protocol: 'rtsp', user: 'other', password: start.args.token }).expect(401);

    // 有人在講：第二個人拿不到憑證
    const other = await makeUser(['remote', 'op.remote']);
    const busy = (await as(other, http().post(`/api/v1/robots/${ids[LIVE]}/talk`)).expect(409)).body;
    expect(busy.error.message).toMatch(/對講中/);

    await as(guard, http().delete(`/api/v1/robots/${ids[LIVE]}/talk`)).expect(204);
    await until(() => cmds.find((c) => c.code === LIVE && c.type === 'talk_stop'));
    mtx.publishing.delete(`talk/${LIVE}`);
    const log = await db.selectFrom('op_logs').select(['action', 'target']).where('user_id', 'in', users).where('action', 'like', 'robot.talk%').orderBy('at').execute();
    expect(log.map((l) => l.action)).toEqual(['robot.talk_start', 'robot.talk_start', 'robot.talk_start', 'robot.talk_stop']);
  });

  it('還沒推上來就通知：等 5 秒仍沒有推流者回 409，不送 talk_start', { timeout: 15_000 }, async () => {
    const before = cmds.filter((c) => c.type === 'talk_start').length;
    const r = (await as(guard, http().post(`/api/v1/robots/${ids[LIVE]}/talk/started`)).expect(409)).body;
    expect(r.error.message).toContain('還沒收到控制室的聲音');
    expect(cmds.filter((c) => c.type === 'talk_start')).toHaveLength(before);
  });

  it('方案 B：按鍵說話送 speak 帶音檔（base64）；檢查格式、長度、大小、能力', async () => {
    const audio = Buffer.from('OggS fake opus data '.repeat(50));
    const r = (
      await as(guard, http().post(`/api/v1/robots/${ids[PTT]}/speak-audio`))
        .attach('file', audio, { filename: 'speak.webm', contentType: 'audio/webm;codecs=opus' })
        .field('durationMs', '2500')
        .expect(202)
    ).body;
    expect(r.cmdId).toMatch(/^c_/);
    const sp = await until(() => cmds.find((c) => c.code === PTT && c.type === 'speak'));
    expect(sp.args).toEqual({ audio: { mime: 'audio/webm', data: audio.toString('base64'), durationMs: 2500 } });

    const post = (code: string, buf: Buffer, type: string, ms: string) =>
      as(guard, http().post(`/api/v1/robots/${ids[code]}/speak-audio`)).attach('file', buf, { filename: 'a', contentType: type }).field('durationMs', ms);
    await post(PTT, audio, 'image/png', '1000').expect(400);
    await post(PTT, audio, 'audio/webm', '40000').expect(400);
    await post(NONE, audio, 'audio/webm', '1000').expect(409); // 沒有 talk 能力
    await post(PTT, Buffer.alloc(1024 * 1024 + 1), 'audio/webm', '1000').expect(413);
    await as(viewer, http().post(`/api/v1/robots/${ids[PTT]}/speak-audio`)).attach('file', audio, { filename: 'a', contentType: 'audio/webm' }).field('durationMs', '1000').expect(403);
  });
});
