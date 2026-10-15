import { vi } from 'vitest';

/**
 * 模擬後端的 refresh 輪替：瀏覽器 cookie 由所有分頁共用；
 * 帶舊的 refresh token 來換會失敗（後端已撤銷），和真實後端相同。
 */
export function fakeServer(opts: { latencyMs?: number } = {}) {
  const state = { cookie: 'rt-0', issued: 0, inFlight: 0, maxInFlight: 0, refreshCalls: 0, logoutTokens: [] as string[] };
  const latency = opts.latencyMs ?? 20;
  const jwt = (n: number) => {
    const payload = btoa(JSON.stringify({ sub: 'u1', exp: Math.floor(Date.now() / 1000) + 900, n }));
    return `h.${payload}.s`;
  };
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url);
    if (path.endsWith('/auth/refresh')) {
      state.refreshCalls++;
      state.inFlight++;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      const sent = state.cookie; // 送出當下的 cookie
      await new Promise((r) => setTimeout(r, latency));
      state.inFlight--;
      if (sent !== state.cookie) return new Response(JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: '請重新登入' } }), { status: 401 });
      state.cookie = `rt-${++state.issued}`;
      return new Response(JSON.stringify({ accessToken: jwt(state.issued) }), { status: 200 });
    }
    if (path.endsWith('/auth/logout')) {
      state.logoutTokens.push(new Headers(init?.headers).get('Authorization') ?? '');
      state.cookie = 'revoked';
      return new Response(null, { status: 204 });
    }
    return new Response('{}', { status: 404 });
  });
  return { state, fetchMock };
}

/** navigator.locks 的最小實作：同名的鎖依序執行（瀏覽器跨分頁的行為） */
export function fakeLocks() {
  const tails = new Map<string, Promise<unknown>>();
  return {
    request(name: string, cb: () => Promise<unknown>) {
      const prev = tails.get(name) ?? Promise.resolve();
      const run = prev.then(cb, cb);
      tails.set(name, run.catch(() => {}));
      return run;
    },
  };
}
