import { Reflector } from '@nestjs/core';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of, throwError } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { AppError } from '../common/errors';
import { OPLOG, type OpLogMeta } from './oplog.decorator';
import { OpLogInterceptor } from './oplog.interceptor';
import type { OpLogEntry, OpLogService } from './oplog.service';
import { summarize } from './summarize';

function setup(meta: OpLogMeta | undefined, req: Record<string, unknown>) {
  const logs: OpLogEntry[] = [];
  const service = { write: async (e: OpLogEntry) => void logs.push(e) } as unknown as OpLogService;
  const handler = () => undefined;
  if (meta) Reflect.defineMetadata(OPLOG, meta, handler);
  const ctx = {
    getHandler: () => handler,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
  return { logs, ctx, interceptor: new OpLogInterceptor(new Reflector(), service) };
}

const req = {
  user: { sub: 'u1', username: 'admin' },
  params: { id: 'r-1' },
  body: { name: '夜班', password: 'Secret123', nested: { token: 'abc', keep: 1 } },
  ip: '10.0.0.9',
};

describe('OpLogInterceptor', () => {
  it('成功：記錄人、動作、對象、參數摘要，密碼類欄位遮蔽', async () => {
    const { logs, ctx, interceptor } = setup({ action: 'role.update', target: (r) => `role:${r.params.id}` }, req);
    const next: CallHandler = { handle: () => of({ id: 'r-1' }) };
    expect(await lastValueFrom(interceptor.intercept(ctx, next))).toEqual({ id: 'r-1' });
    expect(logs).toEqual([
      {
        userId: 'u1',
        username: 'admin',
        action: 'role.update',
        target: 'role:r-1',
        ip: '10.0.0.9',
        detail: {
          ok: true,
          params: { id: 'r-1' },
          body: { name: '夜班', password: '***', nested: { token: '***', keep: 1 } },
        },
      },
    ]);
  });

  it('失敗也記錄，並保留原本的錯誤', async () => {
    const { logs, ctx, interceptor } = setup({ action: 'role.delete' }, req);
    const err = new AppError('INVALID_STATE', '系統角色不可刪除');
    const next: CallHandler = { handle: () => throwError(() => err) };
    await expect(lastValueFrom(interceptor.intercept(ctx, next))).rejects.toBe(err);
    expect(logs[0].detail).toMatchObject({ ok: false, error: 'INVALID_STATE' });
  });

  it('target 可用回傳值（新增時才知道 id）', async () => {
    const { logs, ctx, interceptor } = setup(
      { action: 'user.create', target: (_r, res) => `user:${(res as { id: string }).id}` },
      { ...req, params: {} },
    );
    await lastValueFrom(interceptor.intercept(ctx, { handle: () => of({ id: 'new-id' }) }));
    expect(logs[0].target).toBe('user:new-id');
    expect(logs[0].detail).not.toHaveProperty('params');
  });

  it('日誌寫入失敗不影響操作結果', async () => {
    const { ctx } = setup({ action: 'x' }, req);
    const broken = { write: async () => Promise.reject(new Error('db down')) } as unknown as OpLogService;
    const i = new OpLogInterceptor(new Reflector(), broken);
    expect(await lastValueFrom(i.intercept(ctx, { handle: () => of('ok') }))).toBe('ok');
  });

  it('沒有 @OpLog 的端點不記錄', async () => {
    const { logs, ctx, interceptor } = setup(undefined, req);
    await lastValueFrom(interceptor.intercept(ctx, { handle: () => of(1) }));
    expect(logs).toEqual([]);
  });
});

describe('summarize', () => {
  it('過長的內容只留前段', () => {
    const r = summarize({ text: 'x'.repeat(5000) }) as { truncated: boolean; preview: string };
    expect(r.truncated).toBe(true);
    expect(r.preview.length).toBe(2000);
  });
});
