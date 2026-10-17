import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuth } from '../../stores/auth';
import { useRealtime } from '../../stores/realtime';
import { useTeleopEvents } from '../../stores/teleop';
import { RemotePage } from './RemotePage';
import { toVelocity } from './useTeleop';

const sent = vi.hoisted(() => [] as { robotId: string; lockId: string; vx: number; vy: number; wz: number }[]);
vi.mock('../../realtime/socket', () => ({ sendTeleop: (m: (typeof sent)[number]) => sent.push(m) }));
// 影像另有測試；這裡不建 WebRTC
vi.mock('../../components/media/VideoPlayer', () => ({ VideoPlayer: ({ children }: { children?: React.ReactNode }) => <div className="vplayer">{children}</div> }));

beforeAll(() => {
  // jsdom 沒有 PointerEvent：用 MouseEvent 帶座標
  if (!('PointerEvent' in window)) (window as unknown as { PointerEvent: unknown }).PointerEvent = class extends MouseEvent {
    pointerId = 1;
  };
});

const live = (over: Record<string, unknown> = {}) => ({
  robotId: 'r1',
  code: 'B2-001',
  floor: '1f',
  online: true,
  ts: Date.now(),
  x: 5,
  y: 5,
  yaw: 0,
  battery: 80,
  charging: false,
  state: 'idle',
  speed: 0,
  taskId: null,
  rssi: null,
  faults: [],
  ...over,
});

let calls: { url: string; method: string; body?: Record<string, unknown>; keepalive?: boolean }[];
let acquire: () => Response;
function setup(caps = ['ptz', 'light', 'follow']) {
  calls = [];
  sent.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined, keepalive: init?.keepalive });
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
      if (url.endsWith('/robots')) return json([{ id: 'r1', code: 'B2-001', brand: 'unitree', model: 'B2', floorId: '1f', caps, live: live(), teleop: null, task: null }]);
      if (url.endsWith('/floors')) return json([{ id: '1f', name: '1F 辦公室', planUrl: null, widthM: 40, heightM: 20 }]);
      if (url.includes('/chargers')) return json([]);
      if (url.endsWith('/teleop/acquire')) return acquire();
      if (url.endsWith('/teleop/release')) return new Response(null, { status: 204 });
      if (url.endsWith('/commands')) return json({ cmdId: `c_${calls.length}`, status: 'sent' }, 202);
      return json({ items: [] });
    }),
  );
  useAuth.setState({ status: 'authed', perms: ['remote', 'op.remote'], user: null });
  useRealtime.setState({ conn: 'connected', robots: { r1: live() as never }, cmdResults: [] });
  return render(
    <MemoryRouter initialEntries={['/remote/r1']}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <Routes>
          <Route path="/remote/:id" element={<RemotePage />} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

async function takeOver() {
  fireEvent.click(await screen.findByRole('button', { name: '遙控' }));
  fireEvent.click(screen.getByRole('button', { name: '接管遙控' }));
  await waitFor(() => expect(screen.getByRole('application', { name: '移動搖桿' }).getAttribute('aria-disabled')).toBe('false'));
}

beforeEach(() => {
  acquire = () => new Response(JSON.stringify({ lockId: 'L1', ttlSec: 30 }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('搖桿換算', () => {
  it('上推前進、右推右轉；小於 5% 視為 0', () => {
    expect(toVelocity(0, -1)).toEqual({ vx: 1, vy: 0, wz: 0 });
    expect(toVelocity(1, 0)).toEqual({ vx: 0, vy: 0, wz: -1 });
    expect(toVelocity(0.03, -0.02)).toEqual({ vx: 0, vy: 0, wz: 0 });
  });
});

describe('實時遙控（T-30）', () => {
  it('沒接管前搖桿停用；接管送 acquire，之後每 100 ms 送速度；放開立刻送零速度並停止送（放開即停）', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setup();
    fireEvent.click(await screen.findByRole('button', { name: '遙控' }));
    const joy = screen.getByRole('application', { name: '移動搖桿' });
    expect(joy.getAttribute('aria-disabled')).toBe('true');
    fireEvent.pointerDown(joy, { clientX: 0, clientY: -100 });
    expect(sent).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: '接管遙控' }));
    await waitFor(() => expect(joy.getAttribute('aria-disabled')).toBe('false'));
    expect(calls.find((c) => c.url.endsWith('/teleop/acquire'))!.method).toBe('POST');

    fireEvent.pointerDown(joy, { clientX: 0, clientY: -100 });
    act(() => vi.advanceTimersByTime(350));
    expect(sent.length).toBeGreaterThanOrEqual(3);
    expect(sent.length).toBeLessThanOrEqual(4);
    expect(sent.every((m) => m.robotId === 'r1' && m.lockId === 'L1' && m.vx === 1 && m.wz === 0)).toBe(true);

    fireEvent.pointerUp(joy);
    expect(sent.at(-1)).toMatchObject({ vx: 0, vy: 0, wz: 0 }); // 立刻，不等下一個 100 ms
    const n = sent.length;
    act(() => vi.advanceTimersByTime(1000));
    expect(sent.length).toBe(n); // 放開後不再送（轉接器 500 ms 沒收到也會停）
  });

  it('鍵盤 W／D：前進並右轉；放開按鍵即停；切換視窗即停', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setup();
    await takeOver();
    fireEvent.keyDown(window, { key: 'w' });
    fireEvent.keyDown(window, { key: 'd' });
    act(() => vi.advanceTimersByTime(150));
    const m = sent.at(-1)!;
    expect(m.vx).toBeCloseTo(Math.SQRT1_2);
    expect(m.wz).toBeCloseTo(-Math.SQRT1_2);
    fireEvent.keyUp(window, { key: 'w' });
    fireEvent.keyUp(window, { key: 'd' });
    expect(sent.at(-1)).toMatchObject({ vx: 0, wz: 0 });
    fireEvent.keyDown(window, { key: 'ArrowUp' });
    act(() => vi.advanceTimersByTime(150));
    fireEvent.blur(window);
    expect(sent.at(-1)).toMatchObject({ vx: 0, wz: 0 });
  });

  it('別人遙控中（409）：顯示是誰；系統管理員可強制接管', async () => {
    acquire = () =>
      new Response(JSON.stringify({ error: { code: 'TELEOP_LOCKED', message: 'B2-001 正由 王小明 遙控中', details: { holder: '王小明', canForce: true } } }), { status: 409 });
    setup();
    fireEvent.click(await screen.findByRole('button', { name: '遙控' }));
    fireEvent.click(screen.getByRole('button', { name: '接管遙控' }));
    expect(await screen.findByText('正由 王小明 遙控中')).toBeTruthy();
    acquire = () => new Response(JSON.stringify({ lockId: 'L2', ttlSec: 30 }));
    fireEvent.click(screen.getByRole('button', { name: '強制接管' }));
    await waitFor(() => expect(calls.filter((c) => c.url.endsWith('/teleop/acquire')).at(-1)!.body).toEqual({ force: true }));
  });

  it('被接管（teleop.revoked）或 WebSocket 斷線：搖桿停用、顯示斷線提示', async () => {
    setup();
    await takeOver();
    act(() => useTeleopEvents.getState().setRevoked({ robotId: 'r1', code: 'B2-001', by: 'admin', reason: 'takeover' }));
    expect(screen.getByRole('application', { name: '移動搖桿' }).getAttribute('aria-disabled')).toBe('true');
    act(() => useRealtime.setState({ conn: 'disconnected' }));
    expect(screen.getByText(/即時連線中斷/)).toBeTruthy();
  });

  it('離開頁面：送零速度並釋鎖', async () => {
    const view = setup();
    await takeOver();
    view.unmount();
    expect(sent.at(-1)).toMatchObject({ vx: 0, vy: 0, wz: 0 });
    expect(calls.some((c) => c.url.endsWith('/teleop/release'))).toBe(true);
  });

  it('雲台：方向鍵送絕對位置（依速度步進）、回正；補光燈、警示燈光送 light；沒有 ptz 能力時停用', async () => {
    setup();
    const ptzBtn = await screen.findByRole('button', { name: '雲台' });
    await waitFor(() => expect(ptzBtn.hasAttribute('disabled')).toBe(false));
    fireEvent.click(ptzBtn);
    fireEvent.click(screen.getByRole('button', { name: '向右' }));
    fireEvent.click(screen.getByRole('radio', { name: '快' }));
    fireEvent.click(screen.getByRole('button', { name: '向上' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '補光燈' }));
    await waitFor(() => expect(calls.filter((c) => c.url.endsWith('/commands'))).toHaveLength(3));
    const cmds = calls.filter((c) => c.url.endsWith('/commands')).map((c) => c.body);
    expect(cmds).toEqual([
      { type: 'ptz', args: { pan: 0.1, tilt: 0, zoom: 0 } },
      { type: 'ptz', args: { pan: 0.1, tilt: 0.2, zoom: 0 } },
      { type: 'light', args: { on: true, mode: 'fill' } },
    ]);
    fireEvent.click(screen.getByRole('checkbox', { name: '警示燈光' }));
    await waitFor(() => expect(calls.filter((c) => c.url.endsWith('/commands')).at(-1)!.body).toEqual({ type: 'light', args: { on: true, mode: 'alert' } }));

    cleanup();
    setup([]);
    await screen.findByRole('option', { name: 'B2-001' });
    expect(screen.getByRole('button', { name: '雲台' }).hasAttribute('disabled')).toBe(true);
    expect(screen.queryByRole('checkbox', { name: '警示燈光' })).toBeNull();
    expect(screen.queryByRole('button', { name: '跟隨' })).toBeNull();
  });

  it('跟隨：輸入人員編號送 follow，之後可停止', async () => {
    setup();
    fireEvent.change(await screen.findByRole('textbox', { name: '跟隨的人員編號' }), { target: { value: 'P-0001' } });
    fireEvent.click(screen.getByRole('button', { name: '跟隨' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '停止跟隨' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '停止跟隨' }));
    await waitFor(() => expect(calls.filter((c) => c.url.endsWith('/commands')).map((c) => c.body!.type)).toEqual(['follow', 'follow_stop']));
    expect(calls.find((c) => c.body?.type === 'follow')!.body!.args).toEqual({ personId: 'P-0001' });
  });

  it('閒置：3 分鐘沒操作提示倒數，按「繼續遙控」重新起算；再閒置 3 分 30 秒自動歸還（PR #13 審查第 1 點）', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setup();
    await takeOver();
    act(() => vi.advanceTimersByTime(179_000));
    expect(screen.queryByRole('alert')).toBeNull();
    act(() => vi.advanceTimersByTime(2_000));
    expect(screen.getByRole('alert').textContent).toMatch(/已閒置 3 分鐘，\d+ 秒後自動歸還遙控/);
    fireEvent.click(screen.getByRole('button', { name: '繼續遙控' }));
    expect(screen.queryByRole('alert')).toBeNull();
    act(() => vi.advanceTimersByTime(211_000));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/teleop/release'))).toBe(true));
    expect(screen.getByRole('application', { name: '移動搖桿' }).getAttribute('aria-disabled')).toBe('true');
  });

  it('閒置計時：搖桿有動就重新起算', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setup();
    await takeOver();
    const joy = screen.getByRole('application', { name: '移動搖桿' });
    act(() => vi.advanceTimersByTime(170_000));
    fireEvent.pointerDown(joy, { clientX: 0, clientY: -100 });
    fireEvent.pointerUp(joy);
    act(() => vi.advanceTimersByTime(170_000));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(calls.some((c) => c.url.endsWith('/teleop/release'))).toBe(false);
  });
});
