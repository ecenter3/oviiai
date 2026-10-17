import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import { useAuth } from '../stores/auth';
import { RequireLogin } from './RequirePage';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useAuth.setState({ status: 'anon', user: null, perms: [], mustChangePassword: false });
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function renderApp() {
  render(
    <MemoryRouter>
      <RequireLogin>
        <div>主畫面</div>
      </RequireLogin>
    </MemoryRouter>,
  );
}

describe('管理員重設密碼後必須先改密碼（安全收尾 a）', () => {
  it('mustChangePassword 時只顯示改密碼（不能取消、不載入主畫面），改好後進入系統', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? 'GET'} ${url}`);
        return new Response(null, { status: 204 });
      }),
    );
    useAuth.setState({ status: 'authed', user: { displayName: '新人' } as never, perms: ['monitor'], mustChangePassword: true });
    renderApp();
    expect(screen.queryByText('主畫面')).toBeNull();
    expect(screen.getByText(/請先設定自己的新密碼/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '取消' })).toBeNull();
    expect(screen.getByRole('button', { name: '退出登入' })).toBeTruthy();
    // Esc 關不掉
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeTruthy();

    const [oldPw, newPw, confirm] = screen.getAllByDisplayValue('');
    fireEvent.change(oldPw, { target: { value: 'Temp1234abcd' } });
    fireEvent.change(newPw, { target: { value: 'Temp1234abcd' } });
    fireEvent.change(confirm, { target: { value: 'Temp1234abcd' } });
    fireEvent.click(screen.getByRole('button', { name: '儲存' }));
    expect(screen.getByRole('alert').textContent).toBe('新密碼不能與目前密碼相同');

    fireEvent.change(newPw, { target: { value: 'Mine12345' } });
    fireEvent.change(confirm, { target: { value: 'Mine12345' } });
    fireEvent.click(screen.getByRole('button', { name: '儲存' }));
    await waitFor(() => expect(screen.getByText('主畫面')).toBeTruthy());
    expect(calls).toEqual(['PUT /api/v1/auth/password']);
    expect(useAuth.getState().mustChangePassword).toBe(false);
  });

  it('使用中被管理員重設密碼：API 回 PASSWORD_CHANGE_REQUIRED 就切到改密碼', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { code: 'PASSWORD_CHANGE_REQUIRED', message: '請先修改密碼', details: {} } }, 403)));
    useAuth.setState({ status: 'authed', user: { displayName: '警衛' } as never, perms: ['monitor'], mustChangePassword: false });
    renderApp();
    expect(screen.getByText('主畫面')).toBeTruthy();
    await expect(api('/robots')).rejects.toMatchObject({ code: 'PASSWORD_CHANGE_REQUIRED' });
    await waitFor(() => expect(screen.getByText(/請先設定自己的新密碼/)).toBeTruthy());
  });
});
