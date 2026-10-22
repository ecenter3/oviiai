import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LineChart } from '../../components/LineChart';
import { useAuth } from '../../stores/auth';
import { EnergyPage, type EnergyResp } from './EnergyPage';
import { type Report, ReportsPage } from './ReportsPage';
import { RunlogPage, type RunlogResp } from './RunlogPage';
import { dayRange, duration, taipeiIso } from './time';

const ROBOTS = [{ id: 'r1', code: 'B2-001', floorId: '1f' }];
const FLOORS = [{ id: '1f', name: '1F 辦公室', planUrl: null, widthM: 40, heightM: 30 }];
const T = Date.parse('2026-10-18T02:00:00Z');

function setup(ui: ReactNode, routes: Record<string, unknown>) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(url);
      const hit = Object.entries(routes).find(([k]) => url.includes(k));
      return new Response(JSON.stringify(hit ? hit[1] : {}));
    }),
  );
  useAuth.setState({ status: 'authed', perms: ['energy', 'reports', 'runlog'], user: null });
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('時間換算（台北）', () => {
  it('日期與時段轉 UTC；結束含該分鐘', () => {
    expect(taipeiIso('2026-10-18', '08:00')).toBe('2026-10-18T00:00:00.000Z');
    expect(dayRange('2026-10-18')).toEqual({ from: '2026-10-17T16:00:00.000Z', to: '2026-10-18T16:00:00.000Z' });
    expect(duration(3_725_000)).toBe('1 小時 2 分');
  });
});

describe('折線圖', () => {
  it('缺資料或間隔太久就斷線；滑過顯示數值與時間', () => {
    const pts = [0, 1, 2, 10, 11].map((m) => ({ t: T + m * 60_000, v: 50 + m }));
    const { container } = render(<LineChart title="電量" unit="%" color="#22d3ee" points={pts} domain={[T, T + 11 * 60_000]} gapMs={3 * 60_000} />);
    // 兩段，每段一條線＋一塊面積
    expect(container.querySelectorAll('path[stroke]')).toHaveLength(2);
    const svg = container.querySelector('svg')!;
    svg.getBoundingClientRect = () => ({ left: 0, width: 600, top: 0, height: 230, right: 600, bottom: 230, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerMove(svg, { clientX: 590 });
    expect(screen.getByRole('status').textContent).toContain('61 %');
  });
});

describe('能耗管理（T-39）', () => {
  const energy: EnergyResp = {
    code: 'B2-001',
    bucketSec: 240,
    points: [
      { at: new Date(T).toISOString(), battery: 80, voltage: 50.8, current: -1.6, consumption: 6, charging: false },
      { at: new Date(T + 240_000).toISOString(), battery: 79.6, voltage: 50.7, current: -1.6, consumption: 6, charging: false },
    ],
    charges: [{ id: 'c1', startedAt: new Date(T).toISOString(), endedAt: new Date(T + 1800_000).toISOString(), startPct: 30, endPct: 90, mode: 'auto', chargerCode: 'CH-1F-01', minutes: 30 }],
    summary: { chargeCount: 1, chargeMinutes: 30, avgChargeMinutes: 30, chargedPct: 60, chargeRatePctH: 120, usedPct: 0.4 },
  };

  it('實時：四張曲線、最近 1 分鐘；歷史：日期與時段、充電統計', async () => {
    const calls = setup(<EnergyPage />, { '/robots': ROBOTS, '/energy/r1': energy });
    await screen.findByText('B2-001 · 即時');
    for (const name of ['電壓（V）', '電量（%）', '耗電量（%/h）', '電流（A）']) expect(screen.getByRole('img', { name })).toBeTruthy();
    // 機器人代碼先顯示，能耗查詢在下一輪 effect 才送出（CI 較慢時 find 會落空 → NaN；PR #19 審查第 2 點）
    const rt = await waitFor(() => calls.find((c) => c.includes('/energy/r1')) ?? Promise.reject(new Error('還沒送出能耗查詢')));
    const q = new URL(rt, 'http://x').searchParams;
    expect(Date.parse(q.get('to')!) - Date.parse(q.get('from')!)).toBe(60_000);

    fireEvent.click(screen.getByRole('tab', { name: '歷史數據曲線' }));
    fireEvent.change(screen.getByLabelText('日期'), { target: { value: '2026-10-17' } });
    fireEvent.change(screen.getByLabelText('開始時間'), { target: { value: '08:00' } });
    await screen.findByText('充電統計');
    await waitFor(() => expect(calls.some((c) => c.includes(`from=${encodeURIComponent('2026-10-17T00:00:00.000Z')}`))).toBe(true));
    expect(screen.getByText('CH-1F-01')).toBeTruthy();
    expect(within(screen.getByText('平均充電速率').parentElement!).getByText('120')).toBeTruthy();
  });
});

describe('運行日誌（T-39）', () => {
  it('時間軸：狀態、時長、原因、地圖；各狀態總時長', async () => {
    const runlog: RunlogResp = {
      code: 'B2-001',
      floorId: '1f',
      truncated: false,
      totals: { charging: 1800_000, offline: 120_000 },
      entries: [
        { at: new Date(T + 1800_000).toISOString(), end: null, state: 'charging', reason: null, durationMs: 1800_000, carried: false },
        { at: new Date(T).toISOString(), end: new Date(T + 120_000).toISOString(), state: 'offline', reason: 'telemetry_timeout', durationMs: 120_000, carried: true },
      ],
    };
    setup(<RunlogPage />, { '/robots': ROBOTS, '/floors': FLOORS, '/runlog/r1': runlog });
    await screen.findByText('B2-001 · ' + new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(new Date()) + ' · 2 筆');
    const items = document.querySelectorAll('.tl-item');
    expect(items[0].textContent).toContain('充電時間：30 分 0 秒');
    expect(items[0].textContent).toContain('進行中');
    expect(items[1].textContent).toContain('離線時間：2 分 0 秒');
    expect(items[1].textContent).toContain('原因：遙測逾時');
    expect(items[1].textContent).toContain('（之前開始）');
    expect(items[1].textContent).toContain('地圖名稱：1F 辦公室');
    expect(screen.getByLabelText('各狀態總時長').textContent).toContain('充電中 30 分 0 秒');
  });
});

describe('任務報告（T-39）', () => {
  const row = {
    id: 't1',
    code: 'T-20261018-0001',
    kind: 'inspect',
    source: 'schedule',
    priority: 'P3',
    status: 'done',
    floorId: '1f',
    robotId: 'r1',
    robotCode: 'B2-001',
    createdByName: null,
    note: null,
    targetName: '大廳巡邏',
    targetType: 'path' as const,
    startedAt: new Date(T).toISOString(),
    endedAt: new Date(T + 1800_000).toISOString(),
    failReason: null,
  };
  const report: Report = { ...row, durationMs: 1800_000, distanceM: 152.4, track: [{ x: 1, y: 1 }, { x: 20, y: 1 }], waypoints: [{ x: 1, y: 1 }, { x: 20, y: 1 }], target: { pathId: 'p1' } as never, alarms: 2, snapshots: 3, clips: 1 };

  it('列表（名稱、性質、路徑、操作人）、篩選送出、報告明細與列印', async () => {
    const calls = setup(<ReportsPage />, { '/reports/tasks/t1': report, '/reports/tasks?': { items: [row], total: 1 }, '/robots': ROBOTS, '/floors': FLOORS });
    const tr = (await screen.findByText('日常巡檢 · 大廳巡邏')).closest('tr')!;
    expect(within(tr).getByRole('button', { name: '大廳巡邏' })).toBeTruthy();
    expect(within(tr).getByText('排程')).toBeTruthy();
    expect(within(tr).getByText('已完成')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('任務名稱'), { target: { value: '大廳' } });
    fireEvent.click(screen.getByRole('button', { name: '搜索' }));
    await waitFor(() => expect(calls.some((c) => c.includes('q=%E5%A4%A7%E5%BB%B3'))).toBe(true));

    const print = vi.fn();
    vi.stubGlobal('print', print);
    fireEvent.click(within(tr).getByRole('button', { name: '查看報告' }));
    const dlg = await screen.findByRole('dialog', { name: '任務報告 · 日常巡檢 · 大廳巡邏' });
    await within(dlg).findByText('152.4 m');
    expect(within(dlg).getByText('30 分 0 秒')).toBeTruthy();
    expect(within(dlg).getByText('照片 3 張、錄影 1 段')).toBeTruthy();
    expect(within(dlg).getByText('2 次')).toBeTruthy();
    fireEvent.click(within(dlg).getByRole('button', { name: '列印' }));
    expect(print).toHaveBeenCalled();
  });
});
