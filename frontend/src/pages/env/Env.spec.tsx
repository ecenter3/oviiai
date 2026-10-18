import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EnvThresholds } from '../../components/EnvThresholds';
import { useAuth } from '../../stores/auth';
import { useToast } from '../../stores/toast';
import { EnvPage, type EnvMap, type EnvSummary } from './EnvPage';
import { type InspectionPoint, PointsPage } from './PointsPage';

type Call = { url: string; method: string; body?: unknown };
function setup(ui: ReactNode, routes: (url: string, method: string) => unknown, perms: string[]) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const r = routes(url, method);
      return r === 204 ? new Response(null, { status: 204 }) : new Response(JSON.stringify(r ?? {}));
    }),
  );
  useAuth.setState({ status: 'authed', perms, user: null });
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);
  return calls;
}
const toasts = () => useToast.getState().toasts.map((x) => x.text);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const FLOORS = [
  { id: '2f', name: '2F 工廠', planUrl: null, widthM: 50, heightM: 30 },
  { id: 'b1', name: 'B1 停車場', planUrl: null, widthM: 40, heightM: 30 },
];
const TH = [
  { kind: 'temp', name: '溫度', unit: '°C', min: null, max: 35, alarmType: 'temp_humidity', sort: 1 },
  { kind: 'humidity', name: '濕度', unit: '%', min: null, max: 75, alarmType: 'temp_humidity', sort: 2 },
  { kind: 'co', name: '一氧化碳', unit: 'ppm', min: null, max: 35, alarmType: 'gas', sort: 3 },
  { kind: 'o2', name: '氧氣', unit: '%', min: 19.5, max: 23.5, alarmType: 'gas', sort: 7 },
];
const RULES = {
  rules: [
    { type: 'gas', category: 'business', name: '氣體濃度異常' },
    { type: 'temp_humidity', category: 'business', name: '溫度或濕度異常' },
    { type: 'battery_low', category: 'system', name: '低電量' },
  ],
  users: [],
};
const now = Date.now();
const iso = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
const SUMMARY: EnvSummary = {
  floorId: '2f',
  bucketSec: 1080,
  thresholds: TH,
  series: [
    { kind: 'temp', points: [{ at: iso(60), avg: 27, min: 26, max: 28 }, { at: iso(40), avg: 29, min: 27, max: 42 }] },
    { kind: 'co', points: [{ at: iso(60), avg: 4, min: 3, max: 5 }] },
  ],
  latest: [{ robotId: 'r1', code: 'X30-001', at: iso(0.1), x: 10, y: 5, values: { temp: { value: 41.2, unit: '°C', over: 'high' }, co: { value: 4.3, unit: 'ppm', over: null } } }],
  alarms: { temp: 2 },
  alarmTotal: 2,
};
const MAP: EnvMap = {
  kind: 'temp',
  unit: '°C',
  cell: 4,
  cells: [
    { x: 2, y: 2, n: 12, avg: 27.4, min: 26, max: 28, lastAt: iso(5), over: null },
    { x: 10, y: 6, n: 3, avg: 33, min: 27, max: 42, lastAt: iso(40), over: 'high' },
  ],
};

describe('環境監測（T-41）', () => {
  it('趨勢圖（閾值線、超標點）、目前數值、平面圖量測位置；切換項目', async () => {
    const calls = setup(
      <EnvPage />,
      (url) => {
        if (url.endsWith('/floors')) return FLOORS;
        if (url.includes('/env/summary')) return SUMMARY;
        if (url.includes('/env/map')) return { ...MAP, kind: url.includes('kind=co') ? 'co' : 'temp' };
        if (url.endsWith('/env/thresholds')) return TH;
        return {};
      },
      ['env'],
    );
    const chart = await screen.findByRole('img', { name: '溫度 · 超標 2 次（°C）' });
    expect(chart.querySelector('.ch-limit text')!.textContent).toBe('告警門檻 35');
    expect(chart.querySelectorAll('.ch-alert')).toHaveLength(1);
    expect(screen.getByRole('img', { name: '一氧化碳（ppm）' })).toBeTruthy();
    expect(screen.getByText(/2F 工廠 · .+ · 超標告警 2 次/)).toBeTruthy();
    const row = screen.getByText('X30-001').closest('tr')!;
    expect(row.textContent).toContain('41.2 °C');
    expect(within(row).getByText('41.2 °C').className).toContain('over');
    expect(within(row).getByText('超標')).toBeTruthy();
    // 平面圖：超標格標紅、顯示最高值
    await screen.findByText('42');
    expect(screen.getByText('27.4')).toBeTruthy();
    expect(screen.getByText('閾值 ≤ 35 °C')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '一氧化碳' }));
    await waitFor(() => expect(calls.some((c) => c.url.includes('/env/map') && c.url.includes('kind=co'))).toBe(true));
    // 換樓層
    fireEvent.change(screen.getByLabelText('樓層'), { target: { value: 'b1' } });
    await waitFor(() => expect(calls.some((c) => c.url.includes('/env/summary?floorId=b1'))).toBe(true));
    // 沒有 alarmset 權限：門檻只能看
    expect(screen.getByText('有告警設置權限的人才能修改門檻。')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '套用門檻' })).toBeNull();
  });

  it('超過 31 天不查詢', async () => {
    const calls = setup(<EnvPage />, (url) => (url.endsWith('/floors') ? FLOORS : url.includes('/env/summary') ? SUMMARY : url.includes('/env/thresholds') ? TH : MAP), ['env']);
    await screen.findByText('X30-001');
    fireEvent.change(screen.getByLabelText('開始日期'), { target: { value: '2026-01-01' } });
    expect(await screen.findByText('最多查 31 天')).toBeTruthy();
    expect(calls.some((c) => c.url.includes('from=2025-12-31'))).toBe(false);
  });
});

describe('環境數值門檻', () => {
  it('有 alarmset 權限：改上下限與告警類型，只送有變的項目', async () => {
    const calls = setup(<EnvThresholds />, (url, method) => (url.endsWith('/alarm-rules') ? RULES : method === 'PUT' ? TH.map((x) => (x.kind === 'co' ? { ...x, max: 50 } : x)) : TH), ['alarmset']);
    const max = await screen.findByLabelText('一氧化碳 上限');
    const alarm = screen.getByLabelText('氧氣 超標時的告警') as HTMLSelectElement;
    await waitFor(() => expect(alarm.options.length).toBe(3)); // 不發告警＋2 個業務告警（系統告警不列）
    fireEvent.change(max, { target: { value: '50' } });
    fireEvent.change(screen.getByLabelText('溫度 下限'), { target: { value: '' } });
    expect(screen.getByText('有未儲存的變更')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '套用門檻' }));
    await waitFor(() => expect(toasts()).toContain('告警門檻已更新'));
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual([{ kind: 'co', min: null, max: 50, alarmType: 'gas' }]);
  });
});

const point = (over: Partial<InspectionPoint>): InspectionPoint => ({
  id: 'p1',
  poiId: 'o1',
  name: '配電室',
  floorId: '2f',
  x: 45,
  y: 25,
  freq: 'pass',
  radiusM: 2,
  enabled: true,
  createdAt: iso(600),
  lastAt: iso(3),
  lastRobot: 'X30-002',
  values: { temp: { value: 36.4, unit: '°C', at: iso(3), over: 'high' }, humidity: { value: 60, unit: '%', at: iso(3), over: null } },
  status: 'over',
  measuring: false,
  ...over,
});

describe('定點檢測（T-41）', () => {
  it('列表（最近數值、超標）、平面圖、新增、改頻率、立即檢測、紀錄、移除', async () => {
    const calls = setup(
      <PointsPage />,
      (url, method) => {
        if (url.endsWith('/floors')) return FLOORS;
        if (url.endsWith('/env/thresholds')) return TH;
        if (url.includes('/pois?floor=2f'))
          return [
            { id: 'o1', floorId: '2f', name: '配電室', kind: 'poi' },
            { id: 'o2', floorId: '2f', name: '倉儲區', kind: 'poi' },
          ];
        if (url.endsWith('/measure')) return { taskId: 't1', taskCode: 'T-20261018-0001', status: 'queued' };
        if (url.includes('/readings')) return { items: [{ at: iso(3), robotCode: 'X30-002', values: { temp: 36.4, humidity: 60 } }], total: 1 };
        if (method === 'DELETE') return 204;
        if (method !== 'GET') return point({});
        if (url.includes('/env/points?floorId=2f')) return [point({}), point({ id: 'p2', poiId: 'o3', name: '產線 A', status: 'none', lastAt: null, lastRobot: null, values: {}, freq: '1h' })];
        return [];
      },
      ['points', 'op.dispatch'],
    );
    const row = (await screen.findByText('配電室', { selector: 'td' })).closest('tr')!;
    expect(row.textContent).toContain('溫度 36.4 °C');
    expect(within(row).getByText('超標')).toBeTruthy();
    expect(row.querySelector('.pt-vals .over')!.textContent).toContain('溫度');
    const row2 = screen.getByText('產線 A', { selector: 'td' }).closest('tr')!;
    expect(within(row2).getAllByText('尚未量測').length).toBe(2);
    expect(screen.getByText('2F 工廠 · 2 個檢測點 · 超標 1 個')).toBeTruthy();

    // 新增：已是檢測點的興趣點不列
    const poi = (await screen.findByLabelText('位置（興趣點）')) as HTMLSelectElement;
    await waitFor(() => expect([...poi.options].map((o) => o.text)).toEqual(['倉儲區']));
    fireEvent.change(screen.getAllByLabelText('檢測頻率').at(-1)!, { target: { value: '4h' } });
    fireEvent.click(screen.getByRole('button', { name: '新增檢測點' }));
    await waitFor(() => expect(toasts()).toContain('檢測點已新增'));
    expect(calls.find((c) => c.method === 'POST' && c.url.endsWith('/env/points'))!.body).toEqual({ poiId: 'o2', freq: '4h', radiusM: 2 });

    fireEvent.change(within(row).getByLabelText('配電室 檢測頻率'), { target: { value: '1h' } });
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ freq: '1h' }));

    fireEvent.click(within(row).getByRole('button', { name: '立即檢測' }));
    await waitFor(() => expect(toasts()).toContain('已派工 T-20261018-0001 到 配電室，機器人到達時記錄'));

    fireEvent.click(within(row).getByRole('button', { name: '紀錄' }));
    const dlg = await screen.findByRole('dialog', { name: '配電室 — 量測紀錄' });
    await within(dlg).findByText('X30-002');
    expect(within(dlg).getByText('36.4').className).toContain('over');
    expect(within(dlg).getByText('60').className).not.toContain('over');
    fireEvent.click(within(dlg).getByRole('button', { name: '關閉' }));

    fireEvent.click(within(row).getByRole('button', { name: '移除' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '移除' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/env/points/p1'))).toBe(true));
  });

  it('沒有派工權限不顯示立即檢測', async () => {
    setup(<PointsPage />, (url) => (url.endsWith('/floors') ? FLOORS : url.endsWith('/env/thresholds') ? TH : url.includes('/env/points') ? [point({})] : []), ['points']);
    await screen.findByText('配電室', { selector: 'td' });
    expect(screen.queryByRole('button', { name: '立即檢測' })).toBeNull();
  });
});
