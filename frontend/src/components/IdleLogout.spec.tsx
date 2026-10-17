import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lastActive, markActive } from '../api/activity';
import { LoginPage } from '../pages/LoginPage';
import { useAuth } from '../stores/auth';
import { IDLE_CHECK_MS, useIdleLogout } from './useIdleLogout';
import { MemoryRouter } from 'react-router-dom';

function Probe() {
  useIdleLogout();
  return null;
}

const authed = (idleMinutes: number) =>
  useAuth.setState({ status: 'authed', user: { displayName: 'x' } as never, perms: [], idleMinutes, idleOut: null, expired: false });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearInterval', 'Date'] });
  localStorage.clear();
  // 登出時打 /auth/refresh、/auth/logout：一律成功
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  useAuth.setState({ status: 'anon', user: null, perms: [], idleMinutes: 0, idleOut: null });
});

describe('閒置自動登出（安全收尾 d）', () => {
  it('超過設定分鐘數沒有操作就登出，登入頁顯示原因；有操作就重新計時', async () => {
    authed(30);
    render(<Probe />);
    await act(async () => void vi.advanceTimersByTime(29 * 60_000));
    fireEvent.pointerDown(window);
    await act(async () => void vi.advanceTimersByTime(29 * 60_000));
    expect(useAuth.getState().status).toBe('authed');
    await act(async () => void vi.advanceTimersByTime(60_000 + IDLE_CHECK_MS));
    await act(async () => void (await vi.runOnlyPendingTimersAsync()));
    expect(useAuth.getState()).toMatchObject({ status: 'anon', idleOut: 30 });
    cleanup();
    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    );
    expect(screen.getByText('閒置超過 30 分鐘，已自動登出')).toBeTruthy();
  });

  it('其他分頁有操作（共用的最後操作時間）也算', async () => {
    authed(10);
    render(<Probe />);
    await act(async () => void vi.advanceTimersByTime(9 * 60_000));
    markActive(); // 另一個分頁
    await act(async () => void vi.advanceTimersByTime(9 * 60_000));
    expect(useAuth.getState().status).toBe('authed');
  });

  it('0＝不自動登出', async () => {
    authed(0);
    render(<Probe />);
    await act(async () => void vi.advanceTimersByTime(24 * 3600_000));
    expect(useAuth.getState().status).toBe('authed');
  });

  it('重新開啟頁面時，上次操作已超過時間：直接登出', async () => {
    markActive(Date.now() - 31 * 60_000);
    authed(30);
    render(<Probe />);
    await act(async () => void (await vi.runOnlyPendingTimersAsync()));
    expect(useAuth.getState()).toMatchObject({ status: 'anon', idleOut: 30 });
  });

  it('登入時更新最後操作時間（不會被前一次的閒置紀錄踢出）', async () => {
    markActive(1);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ accessToken: 'h.e30.s', user: { displayName: 'x', role: {} }, perms: [], idleMinutes: 30 }), { status: 200 })),
    );
    await useAuth.getState().login('a', 'b');
    expect(lastActive()).toBeGreaterThan(Date.now() - 1000);
    expect(useAuth.getState().idleMinutes).toBe(30);
  });
});
