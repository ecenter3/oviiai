import { METHOD_METADATA } from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { AppModule } from '../app.module';
import { AUTHENTICATED, PERMS } from './perm.decorator';
import { IS_PUBLIC } from './public.decorator';

/**
 * CLAUDE.md：所有 API 都要標權限。每個端點必須是 @Public、@Authenticated 或 @RequirePerm 之一，
 * 忘了標的端點在這裡就會失敗，而不是上線後才發現誰都能呼叫。
 */
describe('每個端點都有宣告權限', () => {
  it('沒有漏標的端點', async () => {
    process.env.DATABASE_URL ||= 'postgres://unused@localhost/unused'; // 只編譯模組，不連線
    process.env.JWT_SECRET ||= 'route-coverage-route-coverage-route-cov';
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();

    const routes: string[] = [];
    const missing: string[] = [];
    for (const m of mod.get(ModulesContainer).values()) {
      for (const w of m.controllers.values()) {
        const cls = w.metatype as (new (...a: unknown[]) => unknown) | null;
        if (!cls) continue;
        for (const name of Object.getOwnPropertyNames(cls.prototype)) {
          const fn = cls.prototype[name];
          if (typeof fn !== 'function' || Reflect.getMetadata(METHOD_METADATA, fn) === undefined) continue;
          const id = `${cls.name}.${name}`;
          routes.push(id);
          const declared = [IS_PUBLIC, AUTHENTICATED, PERMS].some(
            (k) => Reflect.getMetadata(k, fn) !== undefined || Reflect.getMetadata(k, cls) !== undefined,
          );
          if (!declared) missing.push(id);
        }
      }
    }
    await mod.close();
    expect(routes.length).toBeGreaterThan(10);
    expect(missing).toEqual([]);
  });
});
