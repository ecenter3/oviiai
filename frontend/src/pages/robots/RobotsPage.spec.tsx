import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuth } from '../../stores/auth';
import { type RobotLive, useRealtime } from '../../stores/realtime';
import type { RobotRow } from './RobotsPage';
import { RobotsPage } from './RobotsPage';

const FLOORS = [
  { id: '1f', name: '1F 辦公室' },
  { id: 'b1', name: 'B1 停車場' },
];
const live = (over: Partial<RobotLive>): RobotLive => ({
  robotId: 'r1',
  code: 'B2-001',
  floor: '1f',
  online: true,
  ts: Date.now(),
  x: 1,
  y: 1,
  yaw: 0,
  battery: 80,
  charging: false,
  state: 'idle',
  speed: 0,
  taskId: null,
  rssi: -58,
  faults: [],
  ...over,
});
const ROWS: RobotRow[] = [
  { id: 'r1', code: 'B2-001', brand: 'unitree', model: 'B2', floorId: '1f', caps: [], live: live({}), teleop: null, task: { id: 't', code: 'T-1', status: 'running', priority: 'P3' } },
  { id: 'r2', code: 'B2-002', brand: 'unitree', model: 'B2', floorId: '1f', caps: [], live: live({ robotId: 'r2', code: 'B2-002', state: 'estop' }), teleop: null, task: null },
  { id: 'r3', code: 'ANBOT-001', brand: 'anbot', model: 'ANBOT-Y', floorId: 'b1', caps: [], live: live({ robotId: 'r3', code: 'ANBOT-001', floor: 'b1', battery: 30, faults: [{ code: 'E12', level: 2, msg: '溫度' }] }), teleop: { userId: 'me', username: 'guard1' }, task: null },
];

function setup(perms: string[]) {
  const calls: { url: string; body?: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith('/floors')) return new Response(JSON.stringify(FLOORS));
      if (url.endsWith('/robots')) return new Response(JSON.stringify(ROWS));
      if (url.includes('/teleop/release')) return new Response(null, { status: 204 });
      return new Response(JSON.stringify({ cmdId: 'c', status: 'sent' }), { status: 202 });
    }),
  );
  useAuth.setState({ status: 'authed', perms, user: { id: 'me', username: 'guard1', displayName: 'g', role: { id: 'r', name: '警衛' } } });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <RobotsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return calls;
}
const card = (code: string) => screen.getByRole('article', { name: code });

beforeEach(() => useRealtime.setState({ watch: [], robots: {} }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('機器人狀態頁', () => {
  it('每台一張卡：編號、品牌、樓層、狀態、電量、任務、訊號、故障碼；訂閱全部樓層', async () => {
    setup(['robots']);
    await screen.findByRole('article', { name: 'B2-001' });
    expect(screen.getByText('🤖 機器人狀態監控（3 台）')).toBeTruthy();
    const c = card('B2-001').textContent!;
    for (const s of ['宇樹 B2', '1F 辦公室', '待命', '80%', 'T-1（執行中）', '-58 dBm']) expect(c).toContain(s);
    expect(card('ANBOT-001').textContent).toContain('E12');
    expect(card('ANBOT-001').textContent).toContain('遙控中：guard1');
    await waitFor(() => expect(useRealtime.getState().watch).toEqual(['1f', 'b1']));
  });

  it('WebSocket 即時狀態覆蓋卡片', async () => {
    setup(['robots']);
    await screen.findByRole('article', { name: 'B2-001' });
    act(() => useRealtime.getState().setWatch(['1f', 'b1']));
    act(() => useRealtime.getState().upsert(live({ state: 'patrolling', battery: 55 })));
    expect(card('B2-001').textContent).toContain('巡邏中');
    expect(card('B2-001').textContent).toContain('55%');
  });

  it('篩選：樓層、品牌、狀態', async () => {
    setup(['robots']);
    await screen.findByRole('article', { name: 'B2-001' });
    fireEvent.click(screen.getByRole('button', { name: 'B1 停車場（1）' }));
    expect(screen.getAllByRole('article').map((a) => a.getAttribute('aria-label'))).toEqual(['ANBOT-001']);
    fireEvent.click(screen.getByRole('button', { name: '全部（3）' }));
    fireEvent.change(screen.getByRole('combobox', { name: '品牌' }), { target: { value: 'unitree' } });
    expect(screen.getAllByRole('article')).toHaveLength(2);
    fireEvent.change(screen.getByRole('combobox', { name: '狀態' }), { target: { value: 'estop' } });
    expect(screen.getAllByRole('article').map((a) => a.getAttribute('aria-label'))).toEqual(['B2-002']);
  });

  it('急停、解除急停（先確認）、回充、接管遙控、歸還自動', async () => {
    const calls = setup(['robots', 'remote', 'op.remote', 'op.estop']);
    await screen.findByRole('article', { name: 'B2-001' });
    const posted = () => calls.filter((c) => c.body !== undefined || c.url.includes('teleop')).map((c) => [c.url, c.body]);

    fireEvent.click(within(card('B2-001')).getByRole('button', { name: '急停' }));
    await waitFor(() => expect(posted()).toContainEqual(['/api/v1/robots/r1/commands', { type: 'estop' }]));

    fireEvent.click(within(card('B2-002')).getByRole('button', { name: '解除急停' }));
    expect(posted()).not.toContainEqual(['/api/v1/robots/r2/commands', { type: 'estop_release' }]);
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '解除急停' }));
    await waitFor(() => expect(posted()).toContainEqual(['/api/v1/robots/r2/commands', { type: 'estop_release' }]));
    expect((within(card('B2-002')).getByRole('button', { name: '回充' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(within(card('B2-001')).getByRole('button', { name: '回充' }));
    await waitFor(() => expect(posted()).toContainEqual(['/api/v1/robots/r1/commands', { type: 'charge' }]));

    fireEvent.click(within(card('B2-001')).getByRole('button', { name: '接管遙控' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/v1/robots/r1/teleop/acquire')).toBe(true));

    // ANBOT-001 是自己遙控中：顯示歸還自動與前往遙控頁
    fireEvent.click(within(card('ANBOT-001')).getByRole('button', { name: '歸還自動' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/v1/robots/r3/teleop/release')).toBe(true));
    expect(within(card('ANBOT-001')).getByRole('link', { name: '前往遙控頁' }).getAttribute('href')).toBe('/remote/r3');
  });

  it('沒有操作權限只能看', async () => {
    setup(['robots']);
    await screen.findByRole('article', { name: 'B2-001' });
    expect(within(card('B2-001')).queryAllByRole('button')).toHaveLength(0);
  });
});
