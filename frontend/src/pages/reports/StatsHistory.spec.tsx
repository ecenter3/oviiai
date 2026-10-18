import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAuth } from '../../stores/auth';
import { HistoryPage, type HistoryResp } from './HistoryPage';
import { isoWeek, periods, StatsPage, type StatsResp } from './StatsPage';
import { taipeiDate } from './time';

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
  useAuth.setState({ status: 'authed', perms: ['stats', 'history'], user: null });
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);
  return calls;
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('數據統計（T-40）', () => {
  it('期間選項：週（週一到週日）、月、季、年，不超過今天', () => {
    const w = periods('week', '2026-10-18'); // 週日
    expect(w[0]).toMatchObject({ label: '2026 第 42 週（10-12 ～ 10-18）', from: '2026-10-12', to: '2026-10-18' });
    expect(isoWeek('2026-12-28')).toEqual({ y: 2026, w: 53 });
    expect(isoWeek('2027-01-04')).toEqual({ y: 2027, w: 1 });
    expect(w[1]).toMatchObject({ from: '2026-10-05', to: '2026-10-11' });
    expect(periods('month', '2026-10-18')[1]).toMatchObject({ label: '2026 年 9 月', from: '2026-09-01', to: '2026-09-30' });
    expect(periods('quarter', '2026-10-18')[0]).toMatchObject({ label: '2026 年第 4 季', from: '2026-10-01', to: '2026-10-18' });
    expect(periods('quarter', '2026-02-01')[1]).toMatchObject({ label: '2025 年第 4 季', from: '2025-10-01', to: '2025-12-31' });
    expect(periods('year', '2026-10-18')[1]).toMatchObject({ from: '2025-01-01', to: '2025-12-31' });
  });

  const day = (date: string, n: number) => ({ date, tasksDone: n, tasksFailed: 1, tasksCancelled: 0, alarmsBusiness: 2, alarmsSystem: 1, talks: 0, distanceM: 120.4, busyH: 2, chargingH: 1, idleH: 21, faultH: 0, offlineH: 0, utilization: 8.3 });
  const stats: StatsResp = {
    from: '2026-10-17',
    to: '2026-10-18',
    generatedAt: '2026-10-18T02:00:00Z',
    robotCount: 6,
    totals: { tasksDone: 9, tasksFailed: 2, tasksCancelled: 0, alarmsBusiness: 4, alarmsSystem: 2, talks: 3, distanceM: 240.8, busyH: 4, chargingH: 2, idleH: 42, faultH: 0, offlineH: 0, utilization: 8.3, availability: 100, alarmStatus: { closed: 4, open: 2 } },
    days: [day('2026-10-17', 4), day('2026-10-18', 5)],
    robots: [{ id: 'r1', code: 'B2-001', floorId: '1f', tasksDone: 9, distanceM: 240.8, busyH: 4, utilization: 8.3, availability: 100 }],
    schedules: [{ id: 's1', name: '夜間巡邏', startTime: '22:00', repeat: 'daily', enabled: true, floorId: '1f', pathName: '大廳巡邏', robotCode: null }],
  };

  it('報表紙面：總覽、圖表、詳情；篩選樓層、匯出 Excel', async () => {
    const calls = setup(<StatsPage />, { '/stats/summary': stats, '/robots': [{ id: 'r1', code: 'B2-001', floorId: '1f' }], '/floors': [{ id: '1f', name: '1F 辦公室' }], '/stats/export': {} });
    await screen.findByText('工作數據總覽');
    expect(screen.getByText('稼動率', { selector: 'td' }).nextElementSibling!.textContent).toBe('8.3%');
    expect(screen.getByRole('img', { name: '每日任務量（筆）' })).toBeTruthy();
    expect(screen.getByRole('img', { name: '每日告警量（筆）' })).toBeTruthy();
    expect(screen.getByText('夜間巡邏').closest('tr')!.textContent).toContain('22:00（每天）');
    expect(screen.getByText('已結案 4')).toBeTruthy();
    const wk = periods('week', taipeiDate())[0];
    expect(calls.some((c) => c.includes(`from=${wk.from}&to=${wk.to}`))).toBe(true);

    fireEvent.change(screen.getByLabelText('樓層'), { target: { value: '1f' } });
    await waitFor(() => expect(calls.some((c) => c.includes('floorId=1f'))).toBe(true));
    const url = vi.fn(() => 'blob:x');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: url, revokeObjectURL: vi.fn() }));
    fireEvent.click(screen.getByRole('button', { name: '匯出 Excel' }));
    await waitFor(() => expect(calls.some((c) => c.includes('/stats/export?') && c.includes('floorId=1f'))).toBe(true));
  });
});

describe('歷史視頻（T-40）', () => {
  it('時間軸畫出錄影片段、抓拍、告警；點清單播放錄影或顯示抓拍', async () => {
    const today = taipeiDate();
    const at = (h: number) => new Date(`${today}T${String(h).padStart(2, '0')}:00:00+08:00`).toISOString();
    const hist: HistoryResp = {
      clips: [{ id: 'c1', kind: 'clip', source: 'manual', createdAt: at(8), durationS: 60, url: 'http://s3/c1.mp4', alarmId: null }],
      snapshots: [{ id: 's1', kind: 'snapshot', source: 'alarm', createdAt: at(9), durationS: null, url: 'http://s3/s1.jpg', alarmId: 'a1' }],
      alarms: [{ id: 'a1', code: 'A-1', type: 'intrusion', category: 'business', level: 1, message: '入侵', status: 'open', at: at(9) }],
    };
    const calls = setup(<HistoryPage />, { '/media/options': { robots: [{ id: 'r1', code: 'B2-001', floorId: '1f' }], cameras: [] }, '/media/history': hist });
    await screen.findByText('錄影 1 段、抓拍 1 張、告警 1 次');
    expect(calls.some((c) => c.includes('/media/history?robot=r1&from='))).toBe(true);
    const line = screen.getByRole('slider', { name: '時間軸' });
    expect(line.querySelectorAll('.seg')).toHaveLength(1);
    expect(line.querySelectorAll('.ev.alarm')).toHaveLength(1);
    expect(line.querySelectorAll('.ev.snap')).toHaveLength(1);

    fireEvent.click(screen.getByText('錄影 · 60 秒').closest('button')!);
    expect(document.querySelector('video')!.getAttribute('src')).toBe('http://s3/c1.mp4');
    fireEvent.click(screen.getByText('抓拍', { selector: '.hv-ev span' }).closest('button')!);
    expect(screen.getByRole('img', { name: /^抓拍/ }).getAttribute('src')).toBe('http://s3/s1.jpg');
    expect(screen.getByText(/入侵（未處理）/)).toBeTruthy();
  });
});
