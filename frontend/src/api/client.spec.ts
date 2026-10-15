import { afterEach, describe, expect, it, vi } from 'vitest';

async function load() {
  vi.resetModules();
  const session = await import('./session');
  const client = await import('./client');
  return { session, client };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe('api()', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('401 TOKEN_EXPIRED → refresh 一次後以新 token 重送', async () => {
    const tokens: (string | null)[] = [];
    vi.stubGlobal('navigator', {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/auth/refresh')) return json(200, { accessToken: 'new-token' });
        const auth = new Headers(init?.headers).get('Authorization');
        tokens.push(auth);
        return auth === 'Bearer new-token' ? json(200, { ok: true }) : json(401, { error: { code: 'TOKEN_EXPIRED', message: '' } });
      }),
    );
    const { client } = await load();
    expect(await client.api('/me')).toEqual({ ok: true });
    expect(tokens).toEqual([null, 'Bearer new-token']);
  });

  it('refresh 也失敗 → 登入過期，丟出 ApiError', async () => {
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('fetch', vi.fn(async () => json(401, { error: { code: 'UNAUTHENTICATED', message: '請重新登入' } })));
    const { client, session } = await load();
    const reasons: string[] = [];
    session.onSessionChange((_t, r) => reasons.push(r));
    await expect(client.api('/me')).rejects.toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
    expect(reasons).toEqual(['expired']);
  });

  it('其他錯誤轉成 ApiError（code、details）', async () => {
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('fetch', vi.fn(async () => json(409, { error: { code: 'TELEOP_LOCKED', message: '遙控中', details: { holder: 'a' } } })));
    const { client } = await load();
    await expect(client.api('/robots/x/teleop/acquire', { method: 'POST' })).rejects.toMatchObject({
      status: 409,
      code: 'TELEOP_LOCKED',
      details: { holder: 'a' },
    });
  });
});
