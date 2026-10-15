import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuth } from '../../stores/auth';
import { type RobotLive, useRealtime } from '../../stores/realtime';
import { MonitorPage } from './MonitorPage';

const FLOORS = [
  { id: '1f', name: '1F 辦公室', sort: 1, planUrl: null, widthM: 40, heightM: 36 },
  { id: 'b1', name: 'B1 停車場', sort: 3, planUrl: null, widthM: 42, heightM: 28 },
];
const robot = (over: Partial<RobotLive>): RobotLive => ({
  robotId: '11111111-1111-4111-8111-111111111111',
  code: 'B2-001',
  floor: '1f',
  online: true,
  ts: Date.parse('2026-10-15T08:00:00Z'),
  x: 2,
  y: 2,
  yaw: 0,
  battery: 85,
  charging: false,
  state: 'idle',
  speed: 0,
  taskId: null,
  rssi: -60,
  faults: [],
  ...over,
});

function setup(perms: string[]) {
  const calls: { url: string; body?: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
      if (url.endsWith('/floors')) return json(FLOORS);
      if (url.includes('/cameras')) return json(url.includes('1f') ? [{ id: 'c1', code: 'CAM-1F-01', name: '1F 大門', floorId: '1f', x: 4, y: 32 }] : []);
      if (url.includes('/chargers')) return json([]);
      if (url.includes('/commands')) return json({ cmdId: 'c_1', status: 'sent' }, 202);
      return json({}, 404);
    }),
  );
  useAuth.setState({ status: 'authed', perms, user: { id: 'u', username: 'g', displayName: 'g', role: { id: 'r', name: '警衛' } } });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <MonitorPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return calls;
}

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* jsdom 沒有也沒關係 */
  }
  useRealtime.setState({ watch: [], robots: {}, cmdResults: [] });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('實時監控頁', () => {
  it('只訂閱目前樓層；換樓層改訂閱；離開頁面取消訂閱', async () => {
    setup(['monitor']);
    await waitFor(() => expect(useRealtime.getState().watch).toEqual(['1f']));
    fireEvent.click(await screen.findByRole('button', { name: 'B1 停車場' }));
    await waitFor(() => expect(useRealtime.getState().watch).toEqual(['b1']));
    cleanup();
    expect(useRealtime.getState().watch).toEqual([]);
  });

  it('即時狀態進來就畫在平面圖上，點機器人開詳情抽屜', async () => {
    setup(['monitor', 'op.estop']);
    await waitFor(() => expect(useRealtime.getState().watch).toEqual(['1f']));
    useRealtime.getState().upsert(robot({ state: 'patrolling', battery: 64 }));
    const marker = await screen.findByRole('button', { name: '機器人 B2-001' });
    expect(marker.textContent).toBe('64%');
    expect(screen.getByText('1 台機器人 · 1 台攝影機')).toBeTruthy();

    fireEvent.click(marker);
    const drawer = await screen.findByRole('dialog', { name: 'B2-001' });
    expect(drawer.textContent).toContain('巡邏中');
    expect(drawer.textContent).toContain('(2.00, 2.00) m');
  });

  it('急停：送出指令；有權限才看得到按鈕', async () => {
    const calls = setup(['monitor', 'op.estop']);
    await waitFor(() => expect(useRealtime.getState().watch).toEqual(['1f']));
    useRealtime.getState().upsert(robot({}));
    fireEvent.click(await screen.findByRole('button', { name: '機器人 B2-001' }));
    expect(screen.queryByRole('button', { name: '回充' })).toBeNull(); // 沒有 op.remote
    expect(screen.queryByRole('link', { name: '進入遙控' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '急停' }));
    await waitFor(() => expect(calls.find((c) => c.url.includes('/commands'))?.body).toEqual({ type: 'estop' }));
    expect(calls.find((c) => c.url.includes('/commands'))?.url).toBe('/api/v1/robots/11111111-1111-4111-8111-111111111111/commands');
  });

  it('解除急停要先確認', async () => {
    const calls = setup(['monitor', 'op.estop', 'op.remote', 'remote']);
    await waitFor(() => expect(useRealtime.getState().watch).toEqual(['1f']));
    useRealtime.getState().upsert(robot({ state: 'estop' }));
    fireEvent.click(await screen.findByRole('button', { name: '機器人 B2-001' }));
    expect((screen.getByRole('button', { name: '回充' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('link', { name: '進入遙控' }).getAttribute('href')).toBe('/remote/11111111-1111-4111-8111-111111111111');

    fireEvent.click(screen.getByRole('button', { name: '解除急停' }));
    const dialog = screen.getByRole('alertdialog');
    expect(calls.some((c) => c.url.includes('/commands'))).toBe(false);
    fireEvent.click(dialog.querySelector('.btn.danger')!);
    await waitFor(() => expect(calls.find((c) => c.url.includes('/commands'))?.body).toEqual({ type: 'estop_release' }));
  });
});
