import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAuth } from '../../stores/auth';
import { MapsPage } from './MapsPage';
import { type ManagedRobot, RobotAdminPage } from './RobotAdminPage';

const robot = (over: Partial<ManagedRobot>): ManagedRobot => ({
  id: 'r1',
  code: 'B2-001',
  brand: 'unitree',
  model: 'B2',
  serialNo: 'SN-1',
  floorId: '1f',
  adapter: 'mock',
  conn: { host: '10.0.0.8', port: 9000 },
  hasSecret: true,
  caps: ['ptz'],
  enabled: true,
  online: true,
  createdAt: '2026-10-16T02:00:00Z',
  ...over,
});

type Call = { url: string; method: string; body?: unknown; form?: FormData };

function setup(ui: ReactNode, routes: (url: string, init?: RequestInit) => unknown) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const form = init?.body instanceof FormData ? init.body : undefined;
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body && !form ? JSON.parse(String(init.body)) : undefined, form });
      const r = routes(url, init);
      if (r instanceof Response) return r;
      return new Response(JSON.stringify(r ?? {}));
    }),
  );
  useAuth.setState({ status: 'authed', perms: ['robotmgr', 'maps'], user: null });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
  return calls;
}

const FLOORS = [
  { id: '1f', name: '1F 辦公室', planUrl: null, widthM: 40, heightM: 36, robotQuota: 10 },
  { id: 'b1', name: 'B1 停車場', planUrl: null, widthM: 42, heightM: 28, robotQuota: 8 },
];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('機器人管理（T-25）', () => {
  it('列出含停用的機器人；新增：代碼轉大寫、連線欄位組成 conn、密碼只在有填時送出', async () => {
    const calls = setup(<RobotAdminPage />, (url) => {
      if (url.endsWith('/floors')) return FLOORS;
      if (url.endsWith('/robots/manage')) return [robot({}), robot({ id: 'r2', code: 'B2-002', enabled: false, online: false, hasSecret: false })];
      return { id: 'new', code: 'B2-003' };
    });
    await screen.findByText('B2-002');
    const rows = screen.getAllByRole('row');
    expect(within(rows[1]).getByText('線上')).toBeTruthy();
    expect(within(rows[2]).getByText('已停用')).toBeTruthy();
    expect(within(rows[2]).getByRole('button', { name: '啟用' })).toBeTruthy();
    expect(screen.getByText('共 2 台（啟用 1 台）')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('機器人代碼'), { target: { value: 'b2-003' } });
    fireEvent.change(screen.getByLabelText('品牌'), { target: { value: 'unitree' } });
    expect((screen.getByLabelText('機型') as HTMLInputElement).value).toBe('B2');
    fireEvent.change(screen.getByLabelText('轉接器'), { target: { value: 'mock' } });
    fireEvent.change(screen.getByLabelText('主機或 IP'), { target: { value: '10.0.0.9' } });
    fireEvent.change(screen.getByLabelText('埠號'), { target: { value: '8080' } });
    fireEvent.click(screen.getByLabelText('雲台'));
    fireEvent.click(screen.getAllByRole('button', { name: '新增機器人' }).at(-1)!);
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({
      code: 'B2-003',
      brand: 'unitree',
      model: 'B2',
      serialNo: null,
      floorId: '1f',
      adapter: 'mock',
      conn: { host: '10.0.0.9', port: 8080 },
      caps: ['ptz'],
    });
  });

  it('編輯：已設定密碼留空不送；停用要先確認，送 DELETE', async () => {
    const calls = setup(<RobotAdminPage />, (url) => {
      if (url.endsWith('/floors')) return FLOORS;
      if (url.endsWith('/robots/manage')) return [robot({})];
      return { id: 'r1', code: 'B2-001' };
    });
    await screen.findByText('B2-001');
    fireEvent.click(within(screen.getAllByRole('row')[1]).getByRole('button', { name: '編輯' }));
    expect(screen.getByText('已設定。留空表示不變更')).toBeTruthy();
    expect(screen.queryByLabelText('機器人代碼')).toBeNull(); // 代碼、品牌不可改
    fireEvent.change(screen.getByLabelText('序列號'), { target: { value: 'SN-9' } });
    fireEvent.click(screen.getByRole('button', { name: '儲存' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.url).toContain('/robots/r1');
    expect(patch.body).toMatchObject({ serialNo: 'SN-9', conn: { host: '10.0.0.8', port: 9000 } });
    expect(patch.body).not.toHaveProperty('secret');

    fireEvent.click(screen.getByRole('button', { name: '停用' }));
    const dlg = screen.getByRole('alertdialog');
    expect(dlg.textContent).toContain('停用 B2-001？');
    fireEvent.click(within(dlg).getByRole('button', { name: '停用' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/robots/r1'))).toBe(true));
  });
});

describe('地圖管理（T-25）', () => {
  const routes = (url: string) => {
    if (url.endsWith('/floors')) return FLOORS;
    if (url.includes('/chargers?floor=1f')) return [{ id: 'c1', code: 'CHG-1F-1', floorId: '1f', x: 1, y: 1, brand: 'unitree', enabled: true, robotDock: { id: 'dock-1' }, occupiedBy: { robotId: 'r1', code: 'B2-001' } }];
    if (url.includes('/cameras?floor=1f')) return [{ id: 'k1', code: 'CAM-1F-01', name: '1F 大門', floorId: '1f', x: 4, y: 32, enabled: true, hasRtsp: true }];
    if (url.includes('?floor=b1')) return [];
    return { ok: true };
  };

  it('列出充電樁、攝影機；上傳平面圖送 multipart；換樓層重新查詢', async () => {
    const calls = setup(<MapsPage />, routes);
    expect(await screen.findByText('使用中（B2-001）')).toBeTruthy();
    expect(screen.getByText('1F 大門')).toBeTruthy();
    expect(screen.getByText('已設定')).toBeTruthy();

    const input = screen.getByLabelText('上傳平面圖') as HTMLInputElement;
    const f = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'plan.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [f] } });
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/floors/1f/plan'))).toBe(true));
    expect((calls.find((c) => c.url.endsWith('/floors/1f/plan'))!.form!.get('file') as File).name).toBe('plan.png');

    fireEvent.click(screen.getByRole('tab', { name: 'B1 停車場' }));
    await waitFor(() => expect(calls.some((c) => c.url.includes('/chargers?floor=b1'))).toBe(true));
  });

  it('新增攝影機：要先點位置、要有 RTSP；送出的座標來自表單', async () => {
    const calls = setup(<MapsPage />, routes);
    await screen.findByText('1F 大門');
    fireEvent.click(screen.getByRole('button', { name: '新增攝影機' }));
    fireEvent.change(screen.getByLabelText('代碼'), { target: { value: 'cam-1f-09' } });
    fireEvent.change(screen.getByLabelText('名稱'), { target: { value: '後門' } });
    fireEvent.click(screen.getAllByRole('button', { name: '新增攝影機' }).at(-1)!);
    expect(await screen.findByText('請先在平面圖上點選位置')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('x'), { target: { value: '12.5' } });
    fireEvent.change(screen.getByLabelText('y'), { target: { value: '3' } });
    fireEvent.click(screen.getAllByRole('button', { name: '新增攝影機' }).at(-1)!);
    expect(await screen.findByText('請填 RTSP 位址')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('RTSP 位址'), { target: { value: 'rtsp://u:p@10.0.0.30/s' } });
    fireEvent.click(screen.getAllByRole('button', { name: '新增攝影機' }).at(-1)!);
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/cameras'))).toBe(true));
    expect(calls.find((c) => c.method === 'POST' && c.url.endsWith('/cameras'))!.body).toEqual({
      code: 'CAM-1F-09',
      name: '後門',
      floorId: '1f',
      x: 12.5,
      y: 3,
      enabled: true,
      rtspUrl: 'rtsp://u:p@10.0.0.30/s',
    });
  });
});
