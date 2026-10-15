/**
 * 登入流程端對端測試：真的 PostgreSQL（需先 make up && make migrate）。
 * 沒有 DATABASE_URL 時略過。
 */
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { hashPassword } from '../src/auth/password';
import { loadEnv } from '../src/config';
import { createDatabase, type Database } from '../src/db/database.module';

loadEnv();
const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)('auth（e2e）', () => {
  let app: NestExpressApplication;
  let db: Database;
  const username = `e2e_${Date.now()}`;
  const password = 'Secret123';
  let userId: string;

  const http = () => request(app.getHttpServer());
  const refreshCookie = (res: request.Response) =>
    ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith('rms_rt='));

  beforeAll(async () => {
    process.env.JWT_SECRET ||= 'e2e-secret-e2e-secret-e2e-secret-0';
    process.env.COOKIE_SECURE = 'false';
    db = createDatabase();
    const role = await db.selectFrom('roles').select('id').where('name', '=', '警衛').executeTakeFirstOrThrow();
    const u = await db
      .insertInto('users')
      .values({ username, display_name: 'E2E', password_hash: await hashPassword(password), role_id: role.id })
      .returning('id')
      .executeTakeFirstOrThrow();
    userId = u.id;

    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    if (userId) {
      await db.deleteFrom('op_logs').where('user_id', '=', userId).execute();
      await db.deleteFrom('users').where('id', '=', userId).execute();
    }
    await db?.destroy();
  });

  it('健康檢查不需登入', async () => {
    await http().get('/api/v1/health').expect(200);
  });

  it('未帶 token 回 401 UNAUTHENTICATED，錯誤格式符合介面規格', async () => {
    const res = await http().post('/api/v1/auth/logout').expect(401);
    expect(res.body).toEqual({ error: { code: 'UNAUTHENTICATED', message: '未登入', details: {} } });
  });

  it('欄位不合法回 400 VALIDATION_FAILED', async () => {
    const res = await http().post('/api/v1/auth/login').send({ username: '' }).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(Object.keys(res.body.error.details.fields)).toEqual(expect.arrayContaining(['username', 'password']));
  });

  it('登入 → refresh → 登出', async () => {
    const login = await http().post('/api/v1/auth/login').send({ username, password }).expect(200);
    expect(login.body.perms).toContain('op.estop');
    expect(login.body.user.role.name).toBe('警衛');
    const cookie = refreshCookie(login)!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Path=\/api\/v1\/auth/);

    const refreshed = await http().post('/api/v1/auth/refresh').set('Cookie', cookie.split(';')[0]).expect(200);
    expect(refreshed.body.accessToken).toBeTruthy();
    const cookie2 = refreshCookie(refreshed)!;

    // 舊的 refresh token 已輪替，不能再用
    await http().post('/api/v1/auth/refresh').set('Cookie', cookie.split(';')[0]).expect(401);

    await http()
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${refreshed.body.accessToken}`)
      .set('Cookie', cookie2.split(';')[0])
      .expect(204);
    await http().post('/api/v1/auth/refresh').set('Cookie', cookie2.split(';')[0]).expect(401);

    const actions = await db.selectFrom('op_logs').select(['action', 'ip']).where('user_id', '=', userId).execute();
    expect(actions.map((a) => a.action)).toEqual(expect.arrayContaining(['auth.login', 'auth.logout']));
    expect(actions[0].ip).toBeTruthy();
  });

  it('access token 過期回 TOKEN_EXPIRED，前端據此呼叫 refresh', async () => {
    const jwt = app.get(JwtService);
    const expired = await jwt.signAsync({ sub: userId, username, rid: 'x', exp: Math.floor(Date.now() / 1000) - 10 });
    const res = await http().post('/api/v1/auth/logout').set('Authorization', `Bearer ${expired}`).expect(401);
    expect(res.body.error.code).toBe('TOKEN_EXPIRED');
  });

  it('連續 5 次失敗回 423 並鎖 15 分鐘', async () => {
    for (let i = 0; i < 4; i++) {
      await http().post('/api/v1/auth/login').send({ username, password: 'wrong' }).expect(401);
    }
    const res = await http().post('/api/v1/auth/login').send({ username, password: 'wrong' }).expect(423);
    expect(res.body.error.code).toBe('ACCOUNT_LOCKED');
    await http().post('/api/v1/auth/login').send({ username, password }).expect(423);

    const u = await db.selectFrom('users').select(['locked_until', 'failed_logins']).where('id', '=', userId).executeTakeFirstOrThrow();
    const mins = (new Date(u.locked_until!).getTime() - Date.now()) / 60_000;
    expect(mins).toBeGreaterThan(14.9);
    expect(mins).toBeLessThanOrEqual(15);
    expect(u.failed_logins).toBe(0);
  });
});
