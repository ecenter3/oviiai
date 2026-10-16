import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuth } from '../../stores/auth';
import { useToast } from '../../stores/toast';
import { NavPage, pathLength, polygonArea, type NavPath, type Poi, type Schedule } from './NavPage';

const FLOORS = [{ id: 'b1', name: 'B1 停車場', planUrl: null, widthM: 42, heightM: 28 }];
const POIS: Poi[] = [
  { id: 'p1', floorId: 'b1', name: '車道入口', x: 38, y: 24, yaw: null, kind: 'poi' },
  { id: 'p2', floorId: 'b1', name: '電梯廳', x: 20, y: 4, yaw: null, kind: 'poi' },
  { id: 'k1', floorId: 'b1', name: '待命區', x: 30, y: 20, yaw: null, kind: 'parking' },
];
const PATHS: NavPath[] = [{ id: 'path1', floorId: 'b1', name: 'B1 夜巡', points: [{ x: 1, y: 1 }, { x: 4, y: 5 }], lengthM: 5, schedules: 1 }];
const SCHEDULES: Schedule[] = [
  {
    id: 's1',
    name: '夜巡',
    pathId: 'path1',
    pathName: 'B1 夜巡',
    floorId: 'b1',
    robotId: 'r1',
    robotCode: 'ANBOT-001',
    startTime: '23:30',
    repeat: 'daily',
    onceDate: null,
    loops: 2,
    priority: 'P3',
    enabled: true,
    lastRunAt: null,
    lastTask: { id: 't1', code: 'T-20261016-0001', status: 'done' },
    nextRunAt: '2026-10-16T15:30:00Z',
  },
];

type Call = { url: string; method: string; body?: unknown };
let calls: Call[];

function setup(perms = ['nav', 'op.dispatch']) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
      if (method === 'DELETE' && url.includes('/paths/')) return json({ error: { code: 'INVALID_STATE', message: '路徑使用中：巡邏排程「夜巡」' } }, 409);
      if (method !== 'GET') return json({ id: 'new' });
      if (url.endsWith('/floors')) return json(FLOORS);
      if (url.includes('/pois?')) return json(POIS);
      if (url.includes('/zones?')) return json([{ id: 'z1', floorId: 'b1', name: '車道', kind: 'forbidden', polygon: [[0, 0], [10, 0], [10, 2]] }]);
      if (url.includes('/paths?')) return json(PATHS);
      if (url.includes('/patrol-schedules/options')) return json({ robots: [{ id: 'r1', code: 'ANBOT-001' }] });
      if (url.includes('/patrol-schedules?')) return json(SCHEDULES);
      return json([]);
    }),
  );
  useAuth.setState({ status: 'authed', perms, user: null });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <NavPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** 點地圖上的興趣點（取座標模式會吸附到它的座標） */
function clickPoi(name: string) {
  const el = screen.getAllByRole('button', { name }).find((b) => b.classList.contains('fm-poi'))!;
  fireEvent.pointerDown(el, { button: 0, pointerId: 1, clientX: 1, clientY: 1 });
  fireEvent.pointerUp(el, { button: 0, pointerId: 1, clientX: 1, clientY: 1 });
}
const posts = (path: string) => calls.filter((c) => c.method !== 'GET' && c.url.includes(path));

beforeEach(() => setup());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('導航管理（T-24）', () => {
  it('計算：路徑長度、多邊形面積', () => {
    expect(pathLength([{ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 3, y: 10 }])).toBe(11);
    expect(polygonArea([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }])).toBe(6);
  });

  it('選單：已做的可進入，原廠介面待確認的顯示「規劃中」且不能點', async () => {
    await screen.findByText('B1 停車場', { selector: 'button' });
    const tele = screen.getByRole('button', { name: /設置傳送點/ });
    expect((tele as HTMLButtonElement).disabled).toBe(true);
    expect(tele.textContent).toContain('規劃中');
    expect((screen.getByRole('button', { name: '設置待命點' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('畫路徑：點興趣點吸附、復原、完成送出航點', async () => {
    await screen.findByText('B1 停車場', { selector: 'button' });
    fireEvent.click(screen.getByRole('button', { name: '路徑規劃' }));
    fireEvent.click(screen.getByRole('button', { name: '新建路徑' }));
    expect(screen.getByRole('status').textContent).toContain('已 0 點');
    clickPoi('車道入口');
    clickPoi('電梯廳');
    clickPoi('待命區');
    expect(screen.getByRole('status').textContent).toContain('已 3 點');
    fireEvent.click(screen.getAllByRole('button', { name: '復原上一點' })[0]);
    fireEvent.change(screen.getByLabelText('路徑名稱'), { target: { value: 'B1 車道巡邏' } });
    expect(screen.getByText(`已加入 2 點 · 總長 ${pathLength([{ x: 38, y: 24 }, { x: 20, y: 4 }])} m`)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '完成儲存' }));
    await waitFor(() => expect(posts('/paths').length).toBe(1));
    expect(posts('/paths')[0]).toMatchObject({ method: 'POST', body: { floorId: 'b1', name: 'B1 車道巡邏', points: [{ x: 38, y: 24 }, { x: 20, y: 4 }] } });
  });

  it('刪除被排程使用的路徑：先確認，再顯示 409 原因', async () => {
    await screen.findByText('B1 停車場', { selector: 'button' });
    fireEvent.click(screen.getByRole('button', { name: '路徑規劃' }));
    fireEvent.click(await screen.findByRole('button', { name: '刪除 B1 夜巡' }));
    expect(posts('/paths')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: '確認刪除' }));
    await waitFor(() => expect(posts('/paths/path1')).toHaveLength(1));
    await waitFor(() => expect(useToast.getState().toasts.map((x) => x.text)).toContain('路徑使用中：巡邏排程「夜巡」'));
  });

  it('新增待命點：點地圖位置、填名稱、kind=parking', async () => {
    await screen.findByText('B1 停車場', { selector: 'button' });
    fireEvent.click(screen.getByRole('button', { name: '設置待命點' }));
    expect(screen.getByText('待命區', { selector: 'strong' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '新增待命點' }));
    expect(screen.getByRole('status').textContent).toBe('請在地圖上點選待命點的位置取消');
    clickPoi('電梯廳');
    fireEvent.change(screen.getByLabelText('名稱'), { target: { value: '電梯旁待命' } });
    fireEvent.click(screen.getByRole('button', { name: '儲存' }));
    await waitFor(() => expect(posts('/pois').length).toBe(1));
    expect(posts('/pois')[0].body).toEqual({ name: '電梯旁待命', x: 20, y: 4, kind: 'parking', floorId: 'b1' });
  });

  it('畫區域：至少 3 點才能完成；送出 polygon', async () => {
    await screen.findByText('B1 停車場', { selector: 'button' });
    fireEvent.click(screen.getByRole('button', { name: '設置特殊區域' }));
    fireEvent.click(screen.getByRole('button', { name: '減速區' }));
    fireEvent.click(screen.getByRole('button', { name: '在地圖上繪製減速區' }));
    fireEvent.change(screen.getByLabelText('區域名稱'), { target: { value: '坡道' } });
    clickPoi('車道入口');
    clickPoi('電梯廳');
    expect((screen.getByRole('button', { name: '完成儲存' }) as HTMLButtonElement).disabled).toBe(true);
    clickPoi('待命區');
    fireEvent.click(screen.getByRole('button', { name: '完成儲存' }));
    await waitFor(() => expect(posts('/zones').length).toBe(1));
    expect(posts('/zones')[0].body).toEqual({ name: '坡道', kind: 'slow', polygon: [[38, 24], [20, 4], [30, 20]], floorId: 'b1' });
  });

  it('巡邏任務：清單顯示下次與上次；新增送出表單；開關、立即執行', async () => {
    await screen.findByText('B1 停車場', { selector: 'button' });
    fireEvent.click(screen.getByRole('button', { name: '巡邏任務' }));
    const item = (await screen.findByText('夜巡', { selector: 'strong' })).closest('.litem') as HTMLElement;
    expect(item.textContent).toContain('ANBOT-001 · 23:30 每日 ×2');
    expect(item.textContent).toContain('上次 T-20261016-0001');

    fireEvent.click(within(item).getByRole('button', { name: '立即執行 夜巡' }));
    await waitFor(() => expect(posts('/patrol-schedules/s1/run')).toHaveLength(1));
    fireEvent.click(within(item).getByLabelText('啟用 夜巡'));
    await waitFor(() => expect(posts('/patrol-schedules/s1').some((c) => c.method === 'PATCH')).toBe(true));
    expect(posts('/patrol-schedules/s1').find((c) => c.method === 'PATCH')!.body).toEqual({ enabled: false });

    fireEvent.click(screen.getByRole('button', { name: '新建巡邏任務' }));
    fireEvent.change(screen.getByLabelText('任務名稱'), { target: { value: '早巡' } });
    fireEvent.change(screen.getByLabelText('執行機器人'), { target: { value: 'r1' } });
    fireEvent.change(screen.getByLabelText('開始時間'), { target: { value: '07:15' } });
    fireEvent.change(screen.getByLabelText('重複'), { target: { value: 'weekdays' } });
    fireEvent.change(screen.getByLabelText('圈數'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: '儲存' }));
    await waitFor(() => expect(posts('/patrol-schedules').some((c) => c.method === 'POST' && !c.url.includes('/run'))).toBe(true));
    expect(posts('/patrol-schedules').find((c) => c.method === 'POST' && !c.url.includes('/run'))!.body).toEqual({
      name: '早巡',
      pathId: 'path1',
      robotId: 'r1',
      startTime: '07:15',
      repeat: 'weekdays',
      onceDate: null,
      loops: 3,
      priority: 'P3',
    });
  });

  it('沒有 op.dispatch 不顯示立即執行', async () => {
    cleanup();
    setup(['nav']);
    await screen.findByText('B1 停車場', { selector: 'button' });
    fireEvent.click(screen.getByRole('button', { name: '巡邏任務' }));
    await screen.findByText('夜巡', { selector: 'strong' });
    expect(screen.queryByRole('button', { name: '立即執行 夜巡' })).toBeNull();
  });
});
