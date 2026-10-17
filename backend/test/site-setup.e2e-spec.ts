/**
 * 場域快速設定端對端（T-44、T-45、T-46）：真的 PostgreSQL、Redis、EMQX；物件儲存用替身。
 * 匯入會「刪除設定包裡沒有的東西」，所以這裡一律以目前系統的匯出為底，只加上測試專用（代碼含 tag）的物件，
 * 最後再匯入原本的設定包把它們拿掉，並在 afterAll 清乾淨。
 */
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import ExcelJS from 'exceljs';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { sql } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { hashPassword } from '../src/auth/password';
import { dataEncKey, loadEnv } from '../src/config';
import { createDatabase, type Database } from '../src/db/database.module';
import { SitePackage } from '../src/site-setup/site-package';
import { SiteTransferService } from '../src/site-setup/site-transfer.service';
import { StorageService } from '../src/storage/storage.service';
import { FakeStorage } from './fake-storage';

loadEnv();
const ready = !!(process.env.DATABASE_URL && process.env.REDIS_URL && process.env.MQTT_URL);
const tag = Date.now().toString(36).slice(-6);
const T = tag.toUpperCase();
const FLOOR = `s${tag}`;
const FLOOR2 = `t${tag}`;
const PW = 'Secret123';

const binaryParser = (res: NodeJS.ReadableStream, cb: (e: Error | null, b: Buffer) => void): void => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

describe.skipIf(!ready)('場域快速設定（e2e）', () => {
  let app: NestExpressApplication;
  let db: Database;
  let admin: string;
  let robotOnly: string;
  let viewer: string;
  let original: Buffer;
  const roles: string[] = [];
  const users: string[] = [];
  const storage = new FakeStorage();
  const http = () => request(app.getHttpServer());
  const as = (t: string, r: request.Test) => r.set('Authorization', `Bearer ${t}`);
  const upload = (t: string, url: string, body: Buffer, name: string) => as(t, http().post(url)).attach('file', body, name);
  const decrypt = async (code: string) =>
    (await db.selectFrom('cameras').select(sql<string>`pgp_sym_decrypt(rtsp_url, ${dataEncKey()})`.as('u')).where('code', '=', code).executeTakeFirstOrThrow()).u;

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
    await db.insertInto('floors').values({ id: FLOOR, name: `場域測試 ${FLOOR}`, sort: 98, width_m: '40', height_m: '20' }).execute();
    const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(StorageService).useValue(storage).compile();
    app = mod.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.listen(0);
    admin = await makeUser(['settings', 'op.config', 'maps', 'robotmgr']);
    robotOnly = await makeUser(['robotmgr']);
    viewer = await makeUser(['settings']);
  });

  afterAll(async () => {
    await app?.close();
    if (!db) return;
    const like = `%${T}%`;
    await db.deleteFrom('patrol_schedules').where('name', 'like', `%${tag}%`).execute();
    await db.deleteFrom('task_templates').where('name', 'like', `%${tag}%`).execute();
    for (const t of ['paths', 'pois', 'zones'] as const) await db.deleteFrom(t).where('floor_id', 'in', [FLOOR, FLOOR2]).execute();
    await db.deleteFrom('chargers').where('code', 'like', like).execute();
    await db.deleteFrom('cameras').where('code', 'like', like).execute();
    await db.deleteFrom('robots').where('code', 'like', like).execute();
    await db.deleteFrom('floors').where('id', 'in', [FLOOR, FLOOR2]).execute();
    await db.updateTable('settings').set({ updated_by: null }).where('updated_by', 'in', users).execute();
    await db.deleteFrom('op_logs').where('user_id', 'in', users).execute();
    await db.deleteFrom('users').where('id', 'in', users).execute();
    await db.deleteFrom('roles').where('id', 'in', roles).execute();
    await db.deleteFrom('roles').where('name', 'like', `%${tag}%`).execute();
    await db.destroy();
  });

  describe('批次匯入（T-45）', () => {
    it('範本：Excel 有資料與說明兩頁、CSV 有 BOM 標題列；攝影機範本要 maps', async () => {
      const x = await as(admin, http().get('/api/v1/import/templates/cameras?format=xlsx')).buffer(true).parse(binaryParser as never).expect(200);
      expect(x.headers['content-disposition']).toContain('cameras-template.xlsx');
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(x.body);
      expect(wb.worksheets.map((w) => w.name)).toEqual(['攝影機', '說明']);
      expect(wb.worksheets[0].getRow(1).values).toEqual([undefined, '代碼', '名稱', '樓層', 'X（公尺）', 'Y（公尺）', 'RTSP 位址', '啟用']);
      const c = await as(admin, http().get('/api/v1/import/templates/robots?format=csv')).buffer(true).parse(binaryParser as never).expect(200);
      expect(c.body.toString('utf8')).toMatch(/^﻿代碼,品牌,型號,序號,樓層,轉接器,主機,埠號,帳號,密碼,能力,啟用\r\n$/);
      await as(robotOnly, http().get('/api/v1/import/templates/cameras')).expect(403);
      await as(robotOnly, http().get('/api/v1/import/templates/robots')).expect(200);
      await as(admin, http().get('/api/v1/import/templates/users')).expect(404);
    });

    it('攝影機 CSV：逐列檢查（樓層、範圍、重複、新增必填 RTSP）；只匯入正確的列，RTSP 加密；已存在的更新、RTSP 留空不變', async () => {
      await db
        .insertInto('cameras')
        .values({ code: `CAM-${T}-9`, name: '舊名稱', floor_id: FLOOR, x: 1, y: 1, rtsp_url: sql`pgp_sym_encrypt('rtsp://u:p@10.0.0.9/s', ${dataEncKey()})`, stream_key: `cam/CAM-${T}-9` })
        .execute();
      const csv = [
        '代碼,名稱,樓層,X（公尺）,Y（公尺）,RTSP 位址,啟用',
        `cam-${T}-1,"大門, 東側",${FLOOR},10,5,rtsp://admin:pw@10.0.0.1/s1,是`,
        `CAM-${T}-2,走廊,nope,1,1,rtsp://10.0.0.2/s,`,
        `CAM-${T}-3,超出,${FLOOR},41,5,rtsp://10.0.0.3/s,`,
        `CAM-${T}-1,重複,${FLOOR},1,1,rtsp://10.0.0.4/s,`,
        `CAM-${T}-5,沒帳密,${FLOOR},1,1,,`,
        `CAM-${T}-6,停用,${FLOOR},2,2,http://x,否`,
        `CAM-${T}-9,新名稱,${FLOOR},3,3,,`,
      ].join('\r\n');
      const dry = (await upload(admin, '/api/v1/cameras/import?dryRun=true', Buffer.from(`﻿${csv}`), 'cams.csv').expect(200)).body;
      expect(dry).toMatchObject({ kind: 'cameras', total: 7, valid: 2, invalid: 5, imported: 0 });
      const byRow = Object.fromEntries(dry.rows.map((r: { rowNo: number }) => [r.rowNo, r]));
      expect(byRow[2]).toMatchObject({ code: `CAM-${T}-1`, action: 'create', errors: [] });
      expect(byRow[3].errors).toEqual([{ field: 'floorId', message: '樓層 nope 不存在' }]);
      expect(byRow[4].errors).toEqual([{ field: 'x', message: '超出樓層寬度 40 公尺' }]);
      expect(byRow[5].errors).toEqual([{ field: 'code', message: '代碼與第 2 列重複' }]);
      expect(byRow[6].errors).toEqual([{ field: 'rtspUrl', message: '新增的攝影機必須填 RTSP 位址' }]);
      expect(byRow[7].errors.map((e: { field: string }) => e.field)).toEqual(['rtspUrl']);
      expect(byRow[8]).toMatchObject({ action: 'update', errors: [] });
      expect(await db.selectFrom('cameras').select('code').where('code', '=', `CAM-${T}-1`).executeTakeFirst()).toBeUndefined();

      const done = (await upload(admin, '/api/v1/cameras/import', Buffer.from(csv), 'cams.csv').expect(200)).body;
      expect(done.imported).toBe(2);
      expect(await decrypt(`CAM-${T}-1`)).toBe('rtsp://admin:pw@10.0.0.1/s1');
      const c1 = await db.selectFrom('cameras').selectAll().where('code', '=', `CAM-${T}-1`).executeTakeFirstOrThrow();
      expect(c1).toMatchObject({ name: '大門, 東側', stream_key: `cam/CAM-${T}-1`, x: 10, enabled: true });
      expect((await db.selectFrom('cameras').select('name').where('code', '=', `CAM-${T}-9`).executeTakeFirstOrThrow()).name).toBe('新名稱');
      expect(await decrypt(`CAM-${T}-9`)).toBe('rtsp://u:p@10.0.0.9/s');
      const log = await db.selectFrom('op_logs').select(['action', 'target']).where('user_id', 'in', users).where('action', 'like', 'camera.import%').orderBy('at').execute();
      expect(log).toEqual([
        { action: 'camera.import.preview', target: 'cameras（2/7 列）' },
        { action: 'camera.import', target: 'cameras（2/7 列）' },
      ]);
      await upload(robotOnly, '/api/v1/cameras/import', Buffer.from(csv), 'cams.csv').expect(403);
    });

    it('機器人 Excel：品牌、能力、埠號檢查；已存在的不能改品牌；密碼加密；匯入後登記清單更新', async () => {
      await db.insertInto('robots').values({ code: `R-${T}-9`, brand: 'deep', model: 'X30', floor_id: FLOOR, adapter: 'mock' }).execute();
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('機器人');
      ws.addRow(['代碼', '品牌', '型號', '序號', '樓層', '轉接器', 'IP', '埠號', '帳號', '密碼', '能力', '啟用']);
      ws.addRow([`R-${T}-1`, 'unitree', 'B2', 'SN1', FLOOR, 'mock', '192.168.1.10', 8080, 'op', 's3cret', 'ptz, light', '是']);
      ws.addRow([`R-${T}-2`, 'tesla', 'B2', '', FLOOR, 'mock', '', '', '', '', '', '']);
      ws.addRow([`R-${T}-3`, 'unitree', 'B2', '', FLOOR, 'mock', '', 70000, '', '', 'laser', '']);
      ws.addRow([`R-${T}-9`, 'unitree', 'B2', '', FLOOR, 'mock', '', '', '', '', '', '否']);
      const buf = Buffer.from(await wb.xlsx.writeBuffer());
      const dry = (await upload(admin, '/api/v1/robots/import?dryRun=1', buf, 'robots.xlsx').expect(200)).body;
      const rows = Object.fromEntries(dry.rows.map((r: { code: string }) => [r.code, r]));
      expect(rows[`R-${T}-1`]).toMatchObject({ action: 'create', errors: [] });
      expect(rows[`R-${T}-2`].errors).toEqual([{ field: 'brand', message: '品牌只能是 anbot、unitree、deep' }]);
      expect(rows[`R-${T}-3`].errors.map((e: { field: string }) => e.field).sort()).toEqual(['caps', 'port']);
      expect(rows[`R-${T}-9`].errors).toEqual([{ field: 'brand', message: `已存在的 R-${T}-9 是 deep，不能改品牌` }]);

      expect((await upload(admin, '/api/v1/robots/import', buf, 'robots.xlsx').expect(200)).body.imported).toBe(1);
      const r = await db
        .selectFrom('robots')
        .select(['caps', 'conn', 'serial_no'])
        .select(sql<string>`pgp_sym_decrypt(conn_secret, ${dataEncKey()})`.as('secret'))
        .where('code', '=', `R-${T}-1`)
        .executeTakeFirstOrThrow();
      expect(r).toMatchObject({ caps: ['ptz', 'light'], conn: { host: '192.168.1.10', port: 8080, username: 'op' }, serial_no: 'SN1', secret: 's3cret' });
      const list = (await as(admin, http().get('/api/v1/robots/manage')).expect(200)).body;
      expect(list.map((x: { code: string }) => x.code)).toContain(`R-${T}-1`);
    });

    it('檔案錯誤：缺必填標題、不是 UTF-8 的 CSV、空檔案', async () => {
      const e1 = (await upload(admin, '/api/v1/cameras/import?dryRun=true', Buffer.from('代碼,名稱\r\nA,B'), 'x.csv').expect(400)).body;
      expect(e1.error.message).toContain('標題列缺少欄位：樓層、X（公尺）、Y（公尺）');
      const big5 = Buffer.from([0xa5, 0x4e, 0xbd, 0x58, 0x2c, 0x41]); // Big5「代碼」
      expect((await upload(admin, '/api/v1/cameras/import?dryRun=true', big5, 'x.csv').expect(400)).body.error.message).toContain('不是 UTF-8');
      await upload(admin, '/api/v1/cameras/import?dryRun=true', Buffer.from('\r\n'), 'x.csv').expect(400);
      await as(admin, http().post('/api/v1/cameras/import')).expect(400);
    });
  });

  describe('場域設定匯出／匯入（T-44）', () => {
    const readZip = (b: Buffer) => {
      const files = unzipSync(b);
      return { files, pkg: JSON.parse(strFromU8(files['site.json'])) as SitePackage };
    };

    it('匯出 zip：site.json 通過格式驗證、不含任何秘密；要 settings 權限', async () => {
      await as(robotOnly, http().get('/api/v1/site/export')).expect(403);
      const res = await as(admin, http().get('/api/v1/site/export')).buffer(true).parse(binaryParser as never).expect(200);
      expect(res.headers['content-disposition']).toMatch(/oviiai-site-\d{8}\.zip/);
      original = res.body;
      const { files, pkg } = readZip(original);
      expect(SitePackage.safeParse(pkg).success).toBe(true);
      expect(Object.keys(files)).toContain('說明.txt');
      const json = strFromU8(files['site.json']);
      expect(json).not.toContain('admin:pw');
      expect(json).not.toContain('s3cret');
      expect(json).not.toMatch(/"(password|secret|conn_secret|password_hash)"/);
      expect(pkg.cameras.find((c) => c.code === `CAM-${T}-1`)!.rtspUrl).toBe('rtsp://10.0.0.1/s1');
      expect(pkg.robots.find((r) => r.code === `R-${T}-1`)!.conn).toEqual({ host: '192.168.1.10', port: 8080, username: 'op' });
      expect(Object.keys(pkg.settings).some((k) => k.startsWith('auth.'))).toBe(false);
      expect(pkg).not.toHaveProperty('users');
    });

    function modified(): Buffer {
      const { files, pkg } = readZip(original);
      pkg.floors.push({ id: FLOOR2, name: `新樓層 ${tag}`, sort: 99, widthM: 30, heightM: 15, robotQuota: 2, plan: `plans/${FLOOR2}.png` });
      files[`plans/${FLOOR2}.png`] = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
      pkg.robots.push({ code: `R-${T}-NEW`, brand: 'anbot', model: 'ANBOT-Y', serialNo: null, floorId: FLOOR2, adapter: 'mock', conn: {}, caps: ['ptz'], modules: {}, params: { walk: { speed: 0.5 } }, enabled: true });
      pkg.chargers.push({ code: `CHG-${T}-NEW`, floorId: FLOOR2, x: 1, y: 1, brand: 'anbot', robotDock: {}, enabled: true });
      pkg.cameras.push({ code: `CAM-${T}-NEW`, name: '新攝影機', floorId: FLOOR2, x: 2, y: 2, rtspUrl: 'rtsp://10.9.9.9/s', enabled: true });
      pkg.cameras.find((c) => c.code === `CAM-${T}-1`)!.name = '改名';
      pkg.pois.push({ floorId: FLOOR2, name: `待命 ${tag}`, x: 3, y: 3, yaw: null, kind: 'parking' });
      pkg.zones.push({ floorId: FLOOR2, name: `禁行 ${tag}`, kind: 'forbidden', polygon: [[0, 0], [1, 0], [1, 1]] });
      pkg.paths.push({ floorId: FLOOR2, name: `巡邏線 ${tag}`, points: [{ x: 1, y: 1 }, { x: 5, y: 1 }], lengthM: 4 });
      pkg.patrolSchedules.push({ name: `夜巡 ${tag}`, path: { floorId: FLOOR2, name: `巡邏線 ${tag}` }, robotCode: `R-${T}-NEW`, startTime: '22:00', repeat: 'daily', onceDate: null, loops: 2, priority: 'P3', enabled: false });
      pkg.taskTemplates.push({ name: `範本 ${tag}`, kind: 'inspect', priority: 'P3', floorId: FLOOR2, target: { x: 1, y: 1 } });
      pkg.roles.push({ name: `夜班 ${tag}`, description: null, perms: ['monitor', 'op.estop', 'op.nonexistent'] });
      pkg.settings['cmd.timeoutSec'] = 20;
      pkg.settings['auth.maxFailedLogins'] = 99; // 登入政策不屬於場域設定，略過
      files['site.json'] = strToU8(JSON.stringify(pkg));
      return Buffer.from(zipSync(files));
    }

    it('匯入預覽：列出新增、修改，不寫入；沒有 op.config 不能匯入', async () => {
      const zip = modified();
      await upload(viewer, '/api/v1/site/import?dryRun=true', zip, 'site.zip').expect(403);
      const p = (await upload(admin, '/api/v1/site/import?dryRun=true', zip, 'site.zip').expect(200)).body;
      expect(p.applied).toBe(false);
      const sec = (e: string) => p.sections.find((s: { entity: string }) => s.entity === e).changes;
      expect(sec('floors')).toEqual([{ key: FLOOR2, action: 'add' }]);
      expect(sec('robots')).toEqual([{ key: `R-${T}-NEW`, action: 'add' }]);
      expect(sec('cameras')).toEqual(expect.arrayContaining([{ key: `CAM-${T}-NEW`, action: 'add' }, { key: `CAM-${T}-1`, action: 'update', fields: ['name'] }]));
      expect(sec('patrolSchedules')).toEqual([{ key: `夜巡 ${tag}`, action: 'add' }]);
      expect(sec('settings')).toEqual([{ key: 'cmd.timeoutSec', action: 'update', fields: ['value'] }]);
      expect(sec('roles')).toEqual([{ key: `夜班 ${tag}`, action: 'add' }]);
      expect(p.summary).toMatchObject({ add: 10, update: 2, delete: 0, disable: 0 });
      expect(p.warnings.join('\n')).toMatch(/新增的 1 支攝影機沒有 RTSP 帳密/);
      expect(p.warnings.join('\n')).toMatch(/auth\.maxFailedLogins/);
      expect(p.warnings.join('\n')).toMatch(/op\.nonexistent/);
      expect(await db.selectFrom('floors').select('id').where('id', '=', FLOOR2).executeTakeFirst()).toBeUndefined();
    });

    it('套用中途失敗：整個交易還原，新上傳的平面圖刪掉', async () => {
      const svc = app.get(SiteTransferService);
      const spy = vi.spyOn(svc as unknown as { applyTemplates: () => Promise<void> }, 'applyTemplates').mockRejectedValueOnce(new Error('boom'));
      const before = storage.objects.size;
      await upload(admin, '/api/v1/site/import', modified(), 'site.zip').expect(500);
      spy.mockRestore();
      expect(await db.selectFrom('floors').select('id').where('id', '=', FLOOR2).executeTakeFirst()).toBeUndefined();
      expect(await db.selectFrom('robots').select('id').where('code', '=', `R-${T}-NEW`).executeTakeFirst()).toBeUndefined();
      expect(storage.objects.size).toBe(before);
    });

    it('正式匯入：全部寫入；排程對到路徑與機器人；攝影機 RTSP 沒帳密；再匯入原設定包 → 測試物件刪除或停用', async () => {
      const r = (await upload(admin, '/api/v1/site/import', modified(), 'site.zip').expect(200)).body;
      expect(r.applied).toBe(true);
      const f = await db.selectFrom('floors').selectAll().where('id', '=', FLOOR2).executeTakeFirstOrThrow();
      expect(f.plan_key).toMatch(new RegExp(`^plans/${FLOOR2}-\\d+\\.png$`));
      expect(storage.objects.has(f.plan_key!)).toBe(true);
      const robot = await db.selectFrom('robots').selectAll().where('code', '=', `R-${T}-NEW`).executeTakeFirstOrThrow();
      expect(robot.params).toEqual({ walk: { speed: 0.5 } });
      const path = await db.selectFrom('paths').selectAll().where('floor_id', '=', FLOOR2).executeTakeFirstOrThrow();
      const sched = await db.selectFrom('patrol_schedules').selectAll().where('name', '=', `夜巡 ${tag}`).executeTakeFirstOrThrow();
      expect(sched).toMatchObject({ path_id: path.id, robot_id: robot.id, loops: 2, enabled: false });
      expect(await decrypt(`CAM-${T}-NEW`)).toBe('rtsp://10.9.9.9/s');
      expect(await decrypt(`CAM-${T}-1`)).toBe('rtsp://admin:pw@10.0.0.1/s1'); // 已存在的不動帳密
      expect((await db.selectFrom('cameras').select('name').where('code', '=', `CAM-${T}-1`).executeTakeFirstOrThrow()).name).toBe('改名');
      expect((await db.selectFrom('settings').select('value').where('key', '=', 'cmd.timeoutSec').executeTakeFirstOrThrow()).value).toBe(20);
      // 只有改到的規則記為這次匯入的人
      const touched = await db.selectFrom('settings').select('key').where('updated_by', 'in', users).execute();
      expect(touched.map((x) => x.key)).toEqual(['cmd.timeoutSec']);
      expect((await db.selectFrom('roles').select('perms').where('name', '=', `夜班 ${tag}`).executeTakeFirstOrThrow()).perms).toEqual(['monitor', 'op.estop']);
      // 再匯入同一包：沒有差異
      const again = (await upload(admin, '/api/v1/site/import?dryRun=true', modified(), 'site.zip').expect(200)).body;
      expect(again.summary).toMatchObject({ add: 0, update: 0, delete: 0, disable: 0 });

      // 匯入原本的設定包：測試加的東西拿掉
      const back = (await upload(admin, '/api/v1/site/import?dryRun=true', original, 'site.zip').expect(200)).body;
      const sec = (e: string) => back.sections.find((s: { entity: string }) => s.entity === e).changes;
      expect(sec('robots')).toEqual([{ key: `R-${T}-NEW`, action: 'disable', note: '有歷史紀錄，改為停用' }]);
      expect(sec('chargers')).toEqual([{ key: `CHG-${T}-NEW`, action: 'delete' }]);
      expect(sec('floors')).toEqual([{ key: FLOOR2, action: 'keep', note: '樓層不自動刪除' }]);
      await upload(admin, '/api/v1/site/import', original, 'site.zip').expect(200);
      expect((await db.selectFrom('robots').select('enabled').where('code', '=', `R-${T}-NEW`).executeTakeFirstOrThrow()).enabled).toBe(false);
      expect(await db.selectFrom('chargers').select('id').where('code', '=', `CHG-${T}-NEW`).executeTakeFirst()).toBeUndefined();
      expect(await db.selectFrom('cameras').select('id').where('code', '=', `CAM-${T}-NEW`).executeTakeFirst()).toBeUndefined();
      expect(await db.selectFrom('patrol_schedules').select('id').where('name', '=', `夜巡 ${tag}`).executeTakeFirst()).toBeUndefined();
      expect(await db.selectFrom('paths').select('id').where('floor_id', '=', FLOOR2).executeTakeFirst()).toBeUndefined();
      expect((await db.selectFrom('cameras').select('name').where('code', '=', `CAM-${T}-1`).executeTakeFirstOrThrow()).name).toBe('大門, 東側');
    });

    it('版本與格式：較新的版本拒絕並說明；壞 zip、缺平面圖、樓層參照錯誤', async () => {
      const { files, pkg } = readZip(original);
      const bad = (mut: (p: Record<string, unknown>) => void, drop?: string) => {
        const p = JSON.parse(JSON.stringify(pkg));
        mut(p);
        const f: Record<string, Uint8Array> = { ...files, 'site.json': strToU8(JSON.stringify(p)) };
        if (drop) delete f[drop];
        return Buffer.from(zipSync(f));
      };
      const msg = async (b: Buffer) => (await upload(admin, '/api/v1/site/import?dryRun=true', b, 'site.zip').expect(400)).body.error.message as string;
      expect(await msg(bad((p) => (p.version = 2)))).toBe('設定包是第 2 版，比這套系統支援的第 1 版新，請先更新系統');
      expect(await msg(bad((p) => delete p.version))).toContain('缺少版本');
      expect(await msg(Buffer.from('PK\x03\x04garbage'))).toContain('無法解開設定包');
      expect(await msg(bad((p) => (p.floors as { plan: string | null }[]).push({ id: 'zz', name: 'x', sort: 1, widthM: null, heightM: null, robotQuota: 0, plan: 'plans/zz.png' } as never)))).toContain('缺少 plans/zz.png');
      expect(await msg(bad((p) => (p.robots as unknown[]).push({ ...pkg.robots[0], code: `R-${T}-X`, floorId: 'nofloor' })))).toContain('樓層 nofloor 不在設定包中');
      expect(await msg(bad((p) => ((p.cameras as { rtspUrl: string }[])[0] = { ...pkg.cameras[0], rtspUrl: 'rtsp://u:p@h/s' })))).toContain('RTSP 位址不可含帳密');
      // 單獨的 site.json（不是 zip）也可以
      const plain = { ...pkg, floors: pkg.floors.map((f) => ({ ...f, plan: null })) };
      expect((await upload(admin, '/api/v1/site/import?dryRun=true', Buffer.from(JSON.stringify(plain)), 'site.json').expect(200)).body.applied).toBe(false);
    });
  });

  describe('設定精靈（T-46）', () => {
    it('七個步驟、缺什麼；要 settings 權限', async () => {
      await as(robotOnly, http().get('/api/v1/site/setup-status')).expect(403);
      const s = (await as(viewer, http().get('/api/v1/site/setup-status')).expect(200)).body;
      expect(s.steps.map((x: { key: string }) => x.key)).toEqual(['floors', 'plans', 'robots', 'chargers', 'cameras', 'calibration', 'rules']);
      expect(s.total).toBe(7);
      const plans = s.steps.find((x: { key: string }) => x.key === 'plans');
      expect(plans.done).toBe(false);
      expect(plans.missing).toContain(`場域測試 ${FLOOR}：沒有平面圖`);
      const cal = s.steps.find((x: { key: string }) => x.key === 'calibration');
      expect(cal.missing.join()).toContain(`R-${T}-1：還沒做座標校正`);
      expect(s.blank).toBe(false);
    });
  });
});
