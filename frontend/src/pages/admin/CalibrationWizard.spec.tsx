import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type CalibRow, CalibrationWizard } from './CalibrationWizard';

const robot = (over: Partial<CalibRow>): CalibRow => ({ robotId: 'r1', code: 'ANBOT-001', brand: 'anbot', model: 'ANBOT-Y', online: true, calib: null, ...over });
const FLOOR = { id: 'b1', name: 'B1 停車場', planUrl: null, widthM: 42, heightM: 28 };

type Call = { url: string; method: string; body?: { points?: unknown[]; applyTo?: string[]; mapId?: string } };

function setup(fit: (n: number) => Record<string, unknown>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method: init?.method ?? 'GET', body });
      const json = (b: unknown) => new Response(JSON.stringify(b));
      if (url.endsWith('/calibration/fit')) return json({ maxRmseM: 0.5, ...fit(body.points.length) });
      if (url.endsWith('/robots/r1/calibration') && (init?.method ?? 'GET') === 'GET') return json({ calib: null, live: { online: true, x: 3, y: 4, u: 1.5, v: -2 }, maxRmseM: 0.5 });
      return json({ rmseM: 0.12, applied: ['r1', 'r2'] });
    }),
  );
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <CalibrationWizard robot={robot({})} group={[robot({}), robot({ robotId: 'r2', code: 'ANBOT-002' }), robot({ robotId: 'r3', code: 'B2-001', brand: 'unitree' })]} floor={FLOOR} onClose={onClose} />
    </QueryClientProvider>,
  );
  return { calls, onClose };
}

/** 在精靈的平面圖上點一下（位置不重要，測的是流程） */
function pickOnMap() {
  const map = document.querySelector('.cw-map .floormap')!;
  fireEvent.pointerDown(map, { button: 0, pointerId: 1, clientX: 200, clientY: 150 });
  fireEvent.pointerUp(map, { button: 0, pointerId: 1, clientX: 200, clientY: 150 });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('座標校正精靈（T-26）', () => {
  it('3 點填完才試算；RMSE 可接受才能儲存；同品牌才列在套用清單；儲存送出點與套用對象', async () => {
    const { calls, onClose } = setup(() => ({ ok: true, rmseM: 0.12, residuals: [0.1, 0.1, 0.15], rotationDeg: 90, scale: 1 }));
    await screen.findByDisplayValue('b1-map');
    expect(screen.getByRole('status').textContent).toContain('至少需要 3 組');
    expect(screen.queryByLabelText('B2-001')).toBeNull(); // 不同品牌不列
    for (let i = 1; i <= 3; i++) {
      fireEvent.click(screen.getAllByRole('button', { name: '點選位置' })[0]);
      pickOnMap();
      fireEvent.change(screen.getByLabelText(`第 ${i} 點 u`), { target: { value: String(i * 10) } });
      fireEvent.change(screen.getByLabelText(`第 ${i} 點 v`), { target: { value: String(i === 2 ? 5 : 0) } });
    }
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('RMSE 0.12 m（可儲存）'));
    expect(screen.getByText(/只有 3 點時誤差一定是 0/)).toBeTruthy();
    expect(calls.filter((c) => c.url.endsWith('/fit')).at(-1)!.body!.points).toHaveLength(3);
    fireEvent.click(screen.getByLabelText('ANBOT-002'));
    fireEvent.click(screen.getByRole('button', { name: '儲存' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.body).toMatchObject({ mapId: 'b1-map', applyTo: ['r2'] });
    expect(put.body!.points).toHaveLength(3);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('誤差超過 0.5 m：顯示原因、不能儲存', async () => {
    setup(() => ({ ok: false, rmseM: 1.8, residuals: [0.2, 2.9, 0.4], rotationDeg: 3, scale: 1 }));
    await screen.findByDisplayValue('b1-map');
    for (let i = 1; i <= 3; i++) {
      fireEvent.click(screen.getAllByRole('button', { name: '點選位置' })[0]);
      pickOnMap();
      fireEvent.change(screen.getByLabelText(`第 ${i} 點 u`), { target: { value: String(i) } });
      fireEvent.change(screen.getByLabelText(`第 ${i} 點 v`), { target: { value: String(i * i) } });
    }
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('超過 0.5 m，不能儲存'));
    expect((screen.getByRole('button', { name: '儲存' }) as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector('[data-point="2"] td.bad')?.textContent).toBe('2.9 m');
  });

  it('帶入目前位置：讀取機器人地圖座標', async () => {
    setup(() => ({ ok: false, reason: '至少要 3 組對應點' }));
    await screen.findByDisplayValue('b1-map');
    fireEvent.click(screen.getAllByRole('button', { name: '帶入目前位置' })[0]);
    await waitFor(() => expect((screen.getByLabelText('第 1 點 u') as HTMLInputElement).value).toBe('1.5'));
    expect((screen.getByLabelText('第 1 點 v') as HTMLInputElement).value).toBe('-2');
  });
});
