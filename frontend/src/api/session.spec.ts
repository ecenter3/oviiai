import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeLocks, fakeServer } from '../test/fake-server';

type Session = typeof import('./session');

/** 每呼叫一次就像開一個新分頁：模組狀態獨立，但共用 cookie（fakeServer）、鎖與 BroadcastChannel */
async function openTab(): Promise<Session> {
  vi.resetModules();
  return import('./session');
}

describe('同一時間只能有一個 refresh', () => {
  let server: ReturnType<typeof fakeServer>;
  const tabs: Session[] = [];

  beforeEach(() => {
    server = fakeServer();
    vi.stubGlobal('fetch', server.fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    tabs.length = 0;
  });

  it('同一分頁同時多個 refresh 只打一次', async () => {
    vi.stubGlobal('navigator', { locks: fakeLocks() });
    const tab = await openTab();
    const [a, b, c] = await Promise.all([tab.refresh(), tab.refresh(), tab.refresh()]);
    expect(server.state.refreshCalls).toBe(1);
    expect(a).toBeTruthy();
    expect(new Set([a, b, c]).size).toBe(1);
  });

  it('沒有跨分頁鎖時，兩個分頁同時 refresh 會有一個被登出（重現 PR #1 指出的問題）', async () => {
    vi.stubGlobal('navigator', {});
    const [a, b] = [await openTab(), await openTab()];
    const results = await Promise.all([a.refresh(), b.refresh()]);
    expect(results.filter((t) => t === null)).toHaveLength(1);
  });

  it('有跨分頁鎖：兩個分頁同時 refresh 依序執行，兩邊都拿到有效 token', async () => {
    vi.stubGlobal('navigator', { locks: fakeLocks() });
    const [a, b] = [await openTab(), await openTab()];
    const results = await Promise.all([a.refresh(), b.refresh()]);
    expect(results.every((t) => t !== null)).toBe(true);
    expect(server.state.maxInFlight).toBe(1);
  });

  it('等鎖期間另一個分頁已經 refresh 並廣播：直接用它的 token，不再輪替', async () => {
    vi.stubGlobal('navigator', { locks: fakeLocks() });
    const [a, b] = [await openTab(), await openTab()];
    await a.refresh();
    await new Promise((r) => setTimeout(r, 10)); // 讓 BroadcastChannel 送達
    expect(b.getToken()).toBe(a.getToken());
    expect(server.state.refreshCalls).toBe(1);
  });
});

describe('登出', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('登出前先 refresh，用新的 access token 呼叫 /auth/logout；其他分頁一起登出', async () => {
    const server = fakeServer();
    vi.stubGlobal('fetch', server.fetchMock);
    vi.stubGlobal('navigator', { locks: fakeLocks() });
    const a = await openTab();
    const b = await openTab();
    const seenByB: string[] = [];
    b.onSessionChange((_t, reason) => seenByB.push(reason));

    // 模擬重新整理後記憶體沒有 token 的情況
    expect(a.getToken()).toBeNull();
    await a.logout();

    const calls = server.fetchMock.mock.calls.map((c) => String(c[0]));
    expect(calls).toEqual(['/api/v1/auth/refresh', '/api/v1/auth/logout']);
    expect(server.state.logoutTokens[0]).toMatch(/^Bearer h\./);
    expect(a.getToken()).toBeNull();
    await vi.waitFor(() => expect(seenByB).toContain('logout'));
    expect(b.getToken()).toBeNull();
  });

  it('refresh 已失效（cookie 過期）仍在本機登出，不呼叫 /auth/logout', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })));
    vi.stubGlobal('navigator', { locks: fakeLocks() });
    const a = await openTab();
    await a.logout();
    expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]))).toEqual(['/api/v1/auth/refresh']);
    expect(a.getToken()).toBeNull();
  });
});
