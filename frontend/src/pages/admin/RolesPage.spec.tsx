import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAuth } from '../../stores/auth';
import { type Role, RolesPage } from './RolesPage';

const role = (over: Partial<Role>): Role => ({ id: 'r', name: 'x', description: null, perms: ['monitor'], isSystem: false, noIdleLogout: false, memberCount: 0, ...over });
const ROLES = [
  role({ id: 'sys', name: '系統管理員', perms: ['monitor', 'robots', 'roles', 'oplog'], isSystem: true, memberCount: 1 }),
  role({ id: 'mgr', name: '主管', perms: ['monitor', 'roles'], memberCount: 2 }),
  role({ id: 'high', name: '稽核', perms: ['monitor', 'oplog'] }),
  role({ id: 'wall', name: '監看大屏', perms: ['monitor'], noIdleLogout: true }),
];
const TREE = [
  { name: '監控', children: [{ code: 'monitor', name: '實時監控' }, { code: 'robots', name: '機器人狀態' }] },
  { name: '管理設置', children: [{ code: 'roles', name: '角色管理' }, { code: 'oplog', name: '操作日誌' }] },
];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function setup() {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });
      if (url.endsWith('/permissions')) return new Response(JSON.stringify(TREE));
      if (url.endsWith('/roles') && method === 'GET') return new Response(JSON.stringify(ROLES));
      return new Response(JSON.stringify({ ...ROLES.find((r) => url.endsWith(r.id)), ...body }));
    }),
  );
  // 主管：有 monitor、roles，沒有 robots、oplog
  useAuth.setState({ status: 'authed', perms: ['monitor', 'roles'], user: { id: 'u1', username: 'm', displayName: '主管', role: { id: 'mgr', name: '主管' } } });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RolesPage />
    </QueryClientProvider>,
  );
  return calls;
}

describe('角色管理：不自動登出（PR #16 審查第 1 點）', () => {
  it('列表顯示閒置登出設定；勾選「不自動登出」儲存', async () => {
    const calls = setup();
    const wall = await screen.findByText('監看大屏');
    expect(within(wall.closest('tr')!).getByText('不自動登出')).toBeTruthy();
    const mgrRow = screen.getByText('主管').closest('tr')!;
    expect(within(mgrRow).getByText('依規則頁')).toBeTruthy();

    fireEvent.click(within(mgrRow).getByRole('button', { name: '編輯' }));
    fireEvent.click(screen.getByLabelText('不自動登出'));
    fireEvent.click(screen.getByRole('button', { name: '儲存' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')).toBeTruthy());
    expect(calls.find((c) => c.method === 'PATCH')).toMatchObject({ url: '/api/v1/roles/mgr', body: { name: '主管', noIdleLogout: true, perms: ['monitor', 'roles'] } });
  });

  it('權限比自己高的角色、系統角色只能檢視；不能授予自己沒有的權限', async () => {
    setup();
    const high = (await screen.findByText('稽核')).closest('tr')!;
    expect(within(high).queryByRole('button', { name: '刪除' })).toBeNull();
    fireEvent.click(within(high).getByRole('button', { name: '檢視' }));
    expect(screen.getByText('這個角色有你沒有的權限，不能修改或刪除。')).toBeTruthy();
    expect((screen.getByRole('button', { name: '儲存' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(within(screen.getByText('系統管理員').closest('tr')!).getByRole('button', { name: '檢視' }));
    expect(screen.getByText('系統角色只有系統管理員能修改。')).toBeTruthy();

    // 新增：自己沒有的權限不能勾
    fireEvent.click(screen.getByRole('button', { name: '添加角色' }));
    expect((screen.getByLabelText('操作日誌') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('角色管理') as HTMLInputElement).disabled).toBe(false);
  });
});
