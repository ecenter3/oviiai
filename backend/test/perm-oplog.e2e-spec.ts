/**
 * T-05 權限 Guard、/me、使用者與角色；T-06 操作日誌。真的 PostgreSQL（需先 make migrate）。
 */
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { hashPassword } from '../src/auth/password';
import { ALL_PERMS } from '@oviiai/contracts';
import { loadEnv } from '../src/config';
import { createDatabase, type Database } from '../src/db/database.module';

loadEnv();
const hasDb = !!process.env.DATABASE_URL;
const tag = `pe${Date.now().toString(36)}`;
const PW = 'Secret123';

describe.skipIf(!hasDb)('權限與操作日誌（e2e）', () => {
  let app: NestExpressApplication;
  let db: Database;
  let adminRoleId: string;
  let testRoleId: string;
  const createdUsers: string[] = [];
  const createdRoles: string[] = [];
  let admin: { id: string; token: string };
  let guard: { id: string; token: string };

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({
    get: (url: string) => http().get(url).set('Authorization', `Bearer ${token}`),
    post: (url: string) => http().post(url).set('Authorization', `Bearer ${token}`),
    patch: (url: string) => http().patch(url).set('Authorization', `Bearer ${token}`),
    put: (url: string) => http().put(url).set('Authorization', `Bearer ${token}`),
    delete: (url: string) => http().delete(url).set('Authorization', `Bearer ${token}`),
  });

  async function insertUser(username: string, roleId: string) {
    const u = await db
      .insertInto('users')
      .values({ username, display_name: username, password_hash: await hashPassword(PW), role_id: roleId })
      .returning('id')
      .executeTakeFirstOrThrow();
    createdUsers.push(u.id);
    return u.id;
  }
  async function login(username: string, password = PW) {
    const r = await http().post('/api/v1/auth/login').send({ username, password }).expect(200);
    return r.body.accessToken as string;
  }

  beforeAll(async () => {
    process.env.JWT_SECRET ||= 'e2e-secret-e2e-secret-e2e-secret-0';
    process.env.COOKIE_SECURE = 'false';
    db = createDatabase();
    adminRoleId = (await db.selectFrom('roles').select('id').where('name', '=', '系統管理員').executeTakeFirstOrThrow()).id;
    // 測試專用角色：一開始只有監控權限
    testRoleId = (
      await db
        .insertInto('roles')
        .values({ name: `${tag}-值班`, perms: ['monitor', 'robots'] })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    createdRoles.push(testRoleId);

    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();

    const adminId = await insertUser(`${tag}-admin`, adminRoleId);
    admin = { id: adminId, token: await login(`${tag}-admin`) };
    const guardId = await insertUser(`${tag}-guard`, testRoleId);
    guard = { id: guardId, token: await login(`${tag}-guard`) };
  });

  afterAll(async () => {
    await app?.close();
    if (db) {
      await db.deleteFrom('op_logs').where('username', 'like', `${tag}-%`).execute();
      if (createdUsers.length) await db.deleteFrom('users').where('id', 'in', createdUsers).execute();
      await db.deleteFrom('roles').where('name', 'like', `${tag}-%`).execute();
      await db.destroy();
    }
  });

  it('種子角色的權限碼都在權限清單裡；系統管理員擁有全部', async () => {
    const roles = await db.selectFrom('roles').select(['name', 'perms', 'is_system']).execute();
    for (const r of roles) expect(r.perms.filter((p) => !ALL_PERMS.includes(p as never))).toEqual([]);
    const sys = roles.find((r) => r.name === '系統管理員')!;
    expect([...sys.perms].sort()).toEqual([...ALL_PERMS].sort());
  });

  it('GET /me 回傳目前使用者與權限碼', async () => {
    const r = await as(guard.token).get('/api/v1/me').expect(200);
    expect(r.body.user).toMatchObject({ id: guard.id, username: `${tag}-guard`, role: { id: testRoleId } });
    expect(r.body.perms).toEqual(['monitor', 'robots']);
  });

  it('無權限回 403 FORBIDDEN，details 列出所需權限', async () => {
    const r = await as(guard.token).get('/api/v1/oplogs').expect(403);
    expect(r.body.error).toMatchObject({ code: 'FORBIDDEN', details: { required: ['oplog'] } });
    await as(guard.token).get('/api/v1/users').expect(403);
    await as(guard.token).get('/api/v1/roles').expect(403);
    await as(guard.token).get('/api/v1/permissions').expect(403);
  });

  it('角色改權限即時生效：同一個 token，下一個請求就能用／不能用', async () => {
    await as(admin.token).patch(`/api/v1/roles/${testRoleId}`).send({ perms: ['monitor', 'robots', 'oplog'] }).expect(200);
    await as(guard.token).get('/api/v1/oplogs').expect(200);
    expect((await as(guard.token).get('/api/v1/me')).body.perms).toContain('oplog');

    await as(admin.token).patch(`/api/v1/roles/${testRoleId}`).send({ perms: ['monitor', 'robots'] }).expect(200);
    await as(guard.token).get('/api/v1/oplogs').expect(403);
  });

  it('停用帳號後，尚未過期的 access token 立刻失效', async () => {
    const id = await insertUser(`${tag}-temp`, testRoleId);
    const token = await login(`${tag}-temp`);
    await as(token).get('/api/v1/me').expect(200);
    await as(admin.token).patch(`/api/v1/users/${id}`).send({ enabled: false }).expect(200);
    const r = await as(token).get('/api/v1/me').expect(401);
    expect(r.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('GET /permissions 回傳樹狀權限碼', async () => {
    const r = await as(admin.token).get('/api/v1/permissions').expect(200);
    expect(r.body.flatMap((g: { children: { code: string }[] }) => g.children.map((c) => c.code))).toEqual(ALL_PERMS);
  });

  describe('使用者管理', () => {
    let userId: string;

    it('新增、查詢、修改、重設密碼、刪除', async () => {
      const created = await as(admin.token)
        .post('/api/v1/users')
        .send({ username: `${tag}-new`, displayName: '新同仁', password: 'Abcd1234', roleId: testRoleId })
        .expect(201);
      userId = created.body.id;
      createdUsers.push(userId);
      expect(created.body).toMatchObject({ username: `${tag}-new`, role: { id: testRoleId }, enabled: true });
      expect(created.body).not.toHaveProperty('passwordHash');

      const list = await as(admin.token).get(`/api/v1/users?q=${tag}-new`).expect(200);
      expect(list.body).toMatchObject({ total: 1, page: 1, size: 20 });

      await as(admin.token).patch(`/api/v1/users/${userId}`).send({ displayName: '改名' }).expect(200);

      const reset = await as(admin.token).post(`/api/v1/users/${userId}/reset-password`).expect(200);
      expect(reset.body.tempPassword).toMatch(/^[A-Za-z0-9]{12}$/);
      await login(`${tag}-new`, reset.body.tempPassword);

      await as(admin.token).delete(`/api/v1/users/${userId}`).expect(204);
      await as(admin.token).get(`/api/v1/users/${userId}`).expect(404);
    });

    it('帳號重複、密碼不符規則、角色不存在回 400，details 標出欄位', async () => {
      const dup = await as(admin.token)
        .post('/api/v1/users')
        .send({ username: `${tag}-guard`, displayName: 'x', password: 'Abcd1234', roleId: testRoleId })
        .expect(400);
      expect(dup.body.error.details.fields).toHaveProperty('username');

      const weak = await as(admin.token)
        .post('/api/v1/users')
        .send({ username: `${tag}-weak`, displayName: 'x', password: 'abcdefgh', roleId: testRoleId })
        .expect(400);
      expect(weak.body.error.details.fields).toHaveProperty('password');

      const noRole = await as(admin.token)
        .post('/api/v1/users')
        .send({ username: `${tag}-norole`, displayName: 'x', password: 'Abcd1234', roleId: '00000000-0000-4000-8000-000000000000' })
        .expect(400);
      expect(noRole.body.error.details.fields).toHaveProperty('roleId');
    });

    it('不能停用、刪除自己或改自己的角色', async () => {
      await as(admin.token).patch(`/api/v1/users/${admin.id}`).send({ enabled: false }).expect(409);
      await as(admin.token).patch(`/api/v1/users/${admin.id}`).send({ roleId: testRoleId }).expect(409);
      await as(admin.token).delete(`/api/v1/users/${admin.id}`).expect(409);
    });

    it('管理員建立帳號或重設密碼後，使用者必須先改密碼才能用其他功能', async () => {
      const created = await as(admin.token)
        .post('/api/v1/users')
        .send({ username: `${tag}-fresh`, displayName: '新人', password: 'Abcd1234', roleId: testRoleId })
        .expect(201);
      createdUsers.push(created.body.id);

      const first = await http().post('/api/v1/auth/login').send({ username: `${tag}-fresh`, password: 'Abcd1234' }).expect(200);
      expect(first.body.mustChangePassword).toBe(true);
      const tok = first.body.accessToken as string;
      const blocked = await as(tok).get('/api/v1/robots').expect(403);
      expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
      expect((await as(tok).get('/api/v1/me').expect(200)).body.mustChangePassword).toBe(true);
      await as(tok).put('/api/v1/auth/password').send({ oldPassword: 'Abcd1234', newPassword: 'Mine1234' }).expect(204);
      expect((await as(tok).get('/api/v1/me').expect(200)).body.mustChangePassword).toBe(false);
      await as(tok).get('/api/v1/robots').expect(200);

      // 重設密碼後又要改
      const reset = await as(admin.token).post(`/api/v1/users/${created.body.id}/reset-password`).expect(200);
      const again = await http().post('/api/v1/auth/login').send({ username: `${tag}-fresh`, password: reset.body.tempPassword }).expect(200);
      expect(again.body.mustChangePassword).toBe(true);
      await as(again.body.accessToken).get('/api/v1/robots').expect(403);
      // 登出仍可用
      await as(again.body.accessToken).post('/api/v1/auth/logout').expect(204);
    });

    it('刪除帳號後操作日誌仍可依帳號查到', async () => {
      const id = await insertUser(`${tag}-gone`, testRoleId);
      await login(`${tag}-gone`);
      await as(admin.token).delete(`/api/v1/users/${id}`).expect(204);
      const r = await as(admin.token).get(`/api/v1/oplogs?user=${tag}-gone`).expect(200);
      expect(r.body.items[0]).toMatchObject({ username: `${tag}-gone`, userId: null, action: 'auth.login' });
    });
  });

  describe('角色管理', () => {
    it('新增、改名、刪除；未知權限碼回 400', async () => {
      const bad = await as(admin.token).post('/api/v1/roles').send({ name: `${tag}-x`, perms: ['nope'] }).expect(400);
      expect(bad.body.error.code).toBe('VALIDATION_FAILED');

      const r = await as(admin.token)
        .post('/api/v1/roles')
        .send({ name: `${tag}-巡檢`, perms: ['robots', 'monitor', 'monitor'] })
        .expect(201);
      expect(r.body).toMatchObject({ perms: ['monitor', 'robots'], isSystem: false, memberCount: 0 });

      await as(admin.token).patch(`/api/v1/roles/${r.body.id}`).send({ name: `${tag}-巡檢2` }).expect(200);
      await as(admin.token).delete(`/api/v1/roles/${r.body.id}`).expect(204);
    });

    it('系統角色不可刪、不可改權限；有成員的角色不可刪', async () => {
      await as(admin.token).delete(`/api/v1/roles/${adminRoleId}`).expect(409);
      await as(admin.token).patch(`/api/v1/roles/${adminRoleId}`).send({ perms: ['monitor'] }).expect(409);
      const r = await as(admin.token).delete(`/api/v1/roles/${testRoleId}`).expect(409);
      expect(r.body.error.details.memberCount).toBeGreaterThan(0);
    });
  });

  describe('操作日誌', () => {
    it('@OpLog 記錄人、動作、對象、IP、成功與否，密碼不入日誌', async () => {
      const created = await as(admin.token)
        .post('/api/v1/users')
        .send({ username: `${tag}-log`, displayName: 'log', password: 'Abcd1234', roleId: testRoleId })
        .expect(201);
      createdUsers.push(created.body.id);
      await as(admin.token).delete(`/api/v1/roles/${adminRoleId}`).expect(409);

      const r = await as(admin.token).get(`/api/v1/oplogs?user=${tag}-admin&size=50`).expect(200);
      const create = r.body.items.find((i: { action: string }) => i.action === 'user.create');
      expect(create).toMatchObject({ target: `user:${created.body.id}`, detail: { ok: true } });
      expect(create.ip).toBeTruthy();
      expect(create.detail.body.password).toBe('***');
      expect(JSON.stringify(r.body.items)).not.toContain('Abcd1234');

      const failed = r.body.items.find((i: { action: string }) => i.action === 'role.delete');
      expect(failed).toMatchObject({ target: `role:${adminRoleId}`, detail: { ok: false, error: 'INVALID_STATE' } });
    });

    it('403 寫進操作日誌 auth.forbidden；同一人同一路由 1 分鐘內只記一筆', async () => {
      const u = await insertUser(`${tag}-snoop`, testRoleId);
      const tok = await login(`${tag}-snoop`);
      await as(tok).get('/api/v1/oplogs').expect(403);
      await as(tok).get('/api/v1/oplogs?page=2').expect(403);
      await as(tok).get(`/api/v1/users/${admin.id}`).expect(403);
      await as(tok).get(`/api/v1/users/${guard.id}`).expect(403); // 同一路由樣板，不同 id
      await new Promise((r) => setTimeout(r, 200)); // 寫日誌不擋回應
      const rows = await db
        .selectFrom('op_logs')
        .select(['action', 'target', 'detail', 'ip'])
        .where('user_id', '=', u)
        .where('action', '=', 'auth.forbidden')
        .orderBy('at')
        .execute();
      expect(rows.map((r) => r.target)).toEqual(['GET /api/v1/oplogs', 'GET /api/v1/users/:id']);
      expect(rows[0].detail).toMatchObject({ ok: false, error: 'FORBIDDEN', path: '/api/v1/oplogs', required: ['oplog'] });
      expect(rows[0].ip).toBeTruthy();
    });

    it('@OpLog 端點在服務層回 403：只記原本那一筆，不重複', async () => {
      const mgrRole = (
        await db
          .insertInto('roles')
          .values({ name: `${tag}-帳管`, perms: ['monitor', 'users'] })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      const u = await insertUser(`${tag}-umgr`, mgrRole);
      const tok = await login(`${tag}-umgr`);
      await as(tok).post(`/api/v1/users/${admin.id}/reset-password`).expect(403);
      await new Promise((r) => setTimeout(r, 200));
      const rows = await db.selectFrom('op_logs').select(['action', 'detail']).where('user_id', '=', u).where('action', '<>', 'auth.login').execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ action: 'user.reset_password', detail: { ok: false, error: 'FORBIDDEN' } });
    });

    it('依動作前綴、時間篩選與分頁', async () => {
      const r = await as(admin.token).get(`/api/v1/oplogs?user=${tag}-admin&action=user.*&size=1`).expect(200);
      expect(r.body.size).toBe(1);
      expect(r.body.items).toHaveLength(1);
      expect(r.body.total).toBeGreaterThan(1);
      expect(r.body.items[0].action).toMatch(/^user\./);

      const future = new Date(Date.now() + 3600_000).toISOString();
      const none = await as(admin.token).get(`/api/v1/oplogs?user=${tag}-admin&from=${future}`).expect(200);
      expect(none.body.total).toBe(0);

      await as(admin.token).get('/api/v1/oplogs?from=yesterday').expect(400);
    });

    it('?format=csv 匯出：BOM、中文欄名、台北時間', async () => {
      const r = await as(admin.token)
        .get(`/api/v1/oplogs?user=${tag}-admin&format=csv`)
        .buffer(true)
        .parse((res, cb) => {
          let s = '';
          res.setEncoding('utf8');
          res.on('data', (c: string) => (s += c));
          res.on('end', () => cb(null, s));
        })
        .expect(200);
      expect(r.headers['content-type']).toMatch(/text\/csv/);
      expect(r.headers['content-disposition']).toMatch(/attachment; filename="oplogs-\d{8}\.csv"/);
      const text = r.body as string;
      expect(text.charCodeAt(0)).toBe(0xfeff);
      const lines = text.slice(1).trim().split('\r\n');
      expect(lines[0]).toBe('時間,帳號,動作,對象,結果,IP,內容');
      expect(lines.length).toBeGreaterThan(2);
      expect(lines[1]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\+08:00,/);
    });
  });

  describe('權限提升防護（PR #2 審查第 1 點）', () => {
    let mgr: string;
    let mgrRoleId: string;

    beforeAll(async () => {
      // 主管類角色：可管帳號與角色，但沒有 oplog、op.* 等權限
      mgrRoleId = (
        await db
          .insertInto('roles')
          .values({ name: `${tag}-主管`, perms: ['monitor', 'robots', 'users', 'roles'] })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      await insertUser(`${tag}-mgr`, mgrRoleId);
      mgr = await login(`${tag}-mgr`);
    });

    it('只能授予自己擁有的權限：新角色、角色加權限', async () => {
      const r = await as(mgr).post('/api/v1/roles').send({ name: `${tag}-越權`, perms: ['monitor', 'oplog'] }).expect(403);
      expect(r.body.error).toMatchObject({ code: 'FORBIDDEN', details: { missing: ['oplog'] } });

      const ok = await as(mgr).post('/api/v1/roles').send({ name: `${tag}-巡查`, perms: ['monitor'] }).expect(201);
      await as(mgr).patch(`/api/v1/roles/${ok.body.id}`).send({ perms: ['monitor', 'op.estop'] }).expect(403);
      await as(mgr).patch(`/api/v1/roles/${ok.body.id}`).send({ perms: ['monitor', 'robots'] }).expect(200);
    });

    it('不可改名、修改、刪除權限高於自己的角色（安全收尾 c）', async () => {
      const r = await as(admin.token).post('/api/v1/roles').send({ name: `${tag}-含急停`, perms: ['monitor', 'op.estop'] }).expect(201);
      const rename = await as(mgr).patch(`/api/v1/roles/${r.body.id}`).send({ name: `${tag}-改名` }).expect(403);
      expect(rename.body.error.details.missing).toEqual(['op.estop']);
      await as(mgr).patch(`/api/v1/roles/${r.body.id}`).send({ perms: ['monitor'] }).expect(403);
      await as(mgr).delete(`/api/v1/roles/${r.body.id}`).expect(403);
      // 系統角色：只有系統管理員能動
      await as(mgr).patch(`/api/v1/roles/${adminRoleId}`).send({ name: `${tag}-篡改` }).expect(403);
      const after = await as(admin.token).get(`/api/v1/roles/${r.body.id}`).expect(200);
      expect(after.body).toMatchObject({ name: `${tag}-含急停`, perms: ['monitor', 'op.estop'] });
      // 權限不超過自己的角色照常可改
      const low = await as(mgr).post('/api/v1/roles').send({ name: `${tag}-低`, perms: ['monitor'] }).expect(201);
      await as(mgr).patch(`/api/v1/roles/${low.body.id}`).send({ name: `${tag}-低2` }).expect(200);
      await as(mgr).delete(`/api/v1/roles/${low.body.id}`).expect(204);
    });

    it('只有系統角色成員可以指派系統角色', async () => {
      await as(mgr)
        .post('/api/v1/users')
        .send({ username: `${tag}-wannabe`, displayName: 'x', password: 'Abcd1234', roleId: adminRoleId })
        .expect(403);
      await as(mgr).patch(`/api/v1/users/${guard.id}`).send({ roleId: adminRoleId }).expect(403);

      const ok = await as(admin.token)
        .post('/api/v1/users')
        .send({ username: `${tag}-promoted`, displayName: 'x', password: 'Abcd1234', roleId: adminRoleId })
        .expect(201);
      createdUsers.push(ok.body.id);
    });

    it('不能重設、停用、刪除權限比自己高的帳號（避免冒用管理員）', async () => {
      await as(mgr).post(`/api/v1/users/${admin.id}/reset-password`).expect(403);
      await as(mgr).patch(`/api/v1/users/${admin.id}`).send({ enabled: false }).expect(403);
      await as(mgr).delete(`/api/v1/users/${admin.id}`).expect(403);
      // 權限範圍內的帳號照常可管
      await as(mgr).post(`/api/v1/users/${guard.id}/reset-password`).expect(200);
    });
  });
});
