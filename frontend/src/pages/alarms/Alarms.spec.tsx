import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AlarmPopup } from '../../components/AlarmPopup';
import { type Alarm, useAlarms } from '../../stores/alarms';
import { useAuth } from '../../stores/auth';
import { AlarmSettingsPage, type AlarmRule } from './AlarmSettingsPage';
import { alarmQuery, AlarmsPage } from './AlarmsPage';

vi.mock('../../realtime/sound', () => ({ playAlarm: vi.fn(), audioReady: () => true, unlockAudio: vi.fn() }));

const alarm = (over: Partial<Alarm>): Alarm => ({
  id: 'a1',
  code: 'A-20261016-0001',
  type: 'offline',
  name: '機器人離線',
  category: 'system',
  level: 2,
  floorId: 'b1',
  robotId: 'r1',
  robotCode: 'ANBOT-001',
  cameraId: null,
  x: 10,
  y: 5,
  message: 'ANBOT-001 離線（遙測逾時）',
  confidence: null,
  status: 'open',
  handlerId: null,
  handlerName: null,
  repeatCount: 1,
  occurredAt: '2026-10-16T02:00:00Z',
  handledAt: null,
  closedAt: null,
  snapshotUrl: null,
  clipUrl: null,
  ...over,
});

const rule = (over: Partial<AlarmRule>): AlarmRule => ({
  type: 'offline',
  category: 'system',
  name: '機器人離線',
  level: 2,
  popup: false,
  sound: true,
  needHandle: true,
  smsUserIds: [],
  dedupSec: 60,
  ...over,
});

function Where() {
  const l = useLocation();
  return <div data-testid="where">{l.pathname + l.search}</div>;
}

function setup(perms: string[], ui: ReactNode, opts: { items?: Alarm[]; rules?: AlarmRule[]; path?: string } = {}) {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  const items = opts.items ?? [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const json = (b: unknown) => new Response(JSON.stringify(b));
      if (url.endsWith('/floors')) return json([{ id: 'b1', name: 'B1 停車場', planUrl: null, widthM: 40, heightM: 20 }]);
      if (url.endsWith('/alarms/options')) return json({ robots: [{ id: 'r1', code: 'ANBOT-001', floorId: 'b1' }], types: [{ type: 'offline', name: '機器人離線', category: 'system' }] });
      if (url.includes('/alarms?')) return json({ items, total: items.length, unhandled: items.filter((a) => ['open', 'review', 'handling'].includes(a.status)).length, page: 1, size: 20 });
      const m = /\/alarms\/([^/?]+)(\/(\w+))?$/.exec(url);
      if (m && !m[3]) return json({ ...items.find((a) => a.id === m[1]), events: [{ at: '2026-10-16T02:00:00Z', userName: '系統', from: null, to: 'open', note: '建立' }] });
      if (m && m[3] === 'transition') return json({ ...items.find((a) => a.id === m[1]), status: (JSON.parse(String(init!.body)) as { to: string }).to });
      if (url.endsWith('/alarm-rules') && init?.method === 'PUT') return json({ rules: opts.rules ?? [] });
      if (url.endsWith('/alarm-rules')) return json({ rules: opts.rules ?? [], users: [{ id: 'u1', username: 'admin', displayName: '系統管理員', hasPhone: true }] });
      return json({});
    }),
  );
  useAuth.setState({ status: 'authed', perms, user: null });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[opts.path ?? '/']}>
        <Routes>
          <Route path="*" element={ui} />
        </Routes>
        <Where />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return calls;
}

beforeEach(() => useAlarms.getState().clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('告警頁（T-22）', () => {
  it('查詢字串：日期以台北時間整天計、只帶有值的條件', () => {
    const qs = new URLSearchParams(
      alarmQuery('business', { from: '2026-10-10', to: '2026-10-16', floor: 'b1', robot: '', type: '', status: 'review', level: '', q: ' 煙霧 ' }, 2),
    );
    expect(Object.fromEntries(qs)).toEqual({
      category: 'business',
      page: '2',
      size: '20',
      from: '2026-10-10T00:00:00+08:00',
      to: '2026-10-17T00:00:00+08:00',
      floor: 'b1',
      status: 'review',
      q: '煙霧',
    });
  });

  it('表格欄位、未處理筆數；按「處理」開處理視窗，只顯示合法的處理按鈕', async () => {
    const calls = setup(['sysalarm', 'op.alarm'], <AlarmsPage category="system" />, {
      items: [alarm({}), alarm({ id: 'a2', code: 'A-20261016-0002', status: 'closed', handledAt: '2026-10-16T02:10:00Z' })],
    });
    await screen.findAllByText('機器人離線');
    expect(screen.getByText('未處理 1 條')).toBeTruthy();
    const rows = screen.getAllByRole('row').slice(1);
    expect(within(rows[0]).getByText('未處理')).toBeTruthy();
    expect(within(rows[0]).getByText('二級告警')).toBeTruthy();
    expect(within(rows[0]).getByText('暫未處理')).toBeTruthy();
    expect(within(rows[1]).getByRole('button', { name: '查看' })).toBeTruthy();

    fireEvent.click(within(rows[0]).getByRole('button', { name: '處理' }));
    const dlg = await screen.findByRole('dialog', { name: '告警處理 · 機器人離線' });
    expect(screen.getByTestId('where').textContent).toBe('/?id=a1');
    await within(dlg).findByText('ANBOT-001 離線（遙測逾時）');
    const names = within(dlg)
      .getAllByRole('button')
      .map((b) => b.textContent);
    // 沒有 op.dispatch：不顯示派機器人查看；未處理不能直接結案
    expect(names).toEqual(['關閉', '開始處理', '回報上位系統', '判定誤報']);
    expect(within(dlg).getByText(/系統 · 未處理 · 建立/)).toBeTruthy();

    fireEvent.change(within(dlg).getByLabelText('處理說明（選填）'), { target: { value: '已派人' } });
    fireEvent.click(within(dlg).getByRole('button', { name: '開始處理' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/alarms/a1/transition'))).toBe(true));
    expect(calls.find((c) => c.url.endsWith('/alarms/a1/transition'))!.body).toEqual({ to: 'handling', note: '已派人' });
  });

  it('沒有 op.alarm：處理視窗只能看、提示沒有權限', async () => {
    setup(['sysalarm'], <AlarmsPage category="system" />, { items: [alarm({ status: 'review', confidence: 55 })], path: '/?id=a1' });
    const dlg = await screen.findByRole('dialog', { name: '告警處理 · 機器人離線' });
    await within(dlg).findByText('目前身分沒有處理告警的權限。');
    expect(within(dlg).queryByRole('button', { name: '確認屬實' })).toBeNull();
    expect(within(dlg).getByText('55%')).toBeTruthy();
  });

  it('篩選：按「搜索」才套用', async () => {
    const calls = setup(['sysalarm'], <AlarmsPage category="system" />);
    await screen.findByText('全部樓層');
    fireEvent.change(screen.getByLabelText('處理狀態'), { target: { value: 'review' } });
    expect(calls.some((c) => c.url.includes('status=review'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '搜索' }));
    await waitFor(() => expect(calls.some((c) => c.url.includes('/alarms?') && c.url.includes('status=review') && c.url.includes('category=system'))).toBe(true));
  });
});

describe('告警彈窗與響鈴', () => {
  it('依設定彈窗；「處理」跳到告警頁開處理視窗；別人處理了自動收起', async () => {
    setup(['sysalarm', 'bizalarm', 'op.alarm'], <AlarmPopup />);
    const p1 = alarm({ id: 'p1', type: 'p1_no_robot', name: 'P1 無可用機器人', level: 1, message: 'P1 任務 T-1 沒有可用的機器人', robotCode: null });
    act(() => {
      useAlarms.getState().add({ alarm: alarm({ id: 'x' }), notify: { popup: false, sound: true } });
      useAlarms.getState().add({ alarm: p1, notify: { popup: true, sound: true } });
    });
    const dlg = await screen.findByRole('alertdialog', { name: '一級告警' });
    expect(within(dlg).getByText('P1 無可用機器人')).toBeTruthy();
    fireEvent.click(within(dlg).getByRole('button', { name: '處理' }));
    expect(screen.getByTestId('where').textContent).toBe('/alarms/system?id=p1');
    expect(screen.queryByRole('alertdialog')).toBeNull();

    act(() => useAlarms.getState().add({ alarm: { ...p1, id: 'p2' }, notify: { popup: true, sound: true } }));
    await screen.findByRole('alertdialog');
    act(() => useAlarms.getState().update({ id: 'p2', code: 'A', category: 'system', status: 'handling', handler: '王', repeatCount: 1, handledAt: null }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('稍後處理：收起，佇列中的下一則接著出現', async () => {
    setup(['sysalarm'], <AlarmPopup />);
    act(() => {
      useAlarms.getState().add({ alarm: alarm({ id: 'q1', name: '黑名單人員', level: 1 }), notify: { popup: true, sound: true } });
      useAlarms.getState().add({ alarm: alarm({ id: 'q2', name: '煙霧', level: 1 }), notify: { popup: true, sound: true } });
    });
    const d1 = await screen.findByRole('alertdialog');
    expect(within(d1).getByText('黑名單人員')).toBeTruthy();
    expect(within(d1).getByText(/另有 1 則待確認/)).toBeTruthy();
    fireEvent.click(within(d1).getByRole('button', { name: '稍後處理' }));
    expect(within(await screen.findByRole('alertdialog')).getByText('煙霧')).toBeTruthy();
  });

  it('收到 alarm.new 時依「音效提醒」響鈴', async () => {
    const { playAlarm } = await import('../../realtime/sound');
    const { onAlarmNew } = await import('../../realtime/socket');
    vi.mocked(playAlarm).mockClear();
    onAlarmNew({ alarm: alarm({ level: 3 }), notify: { popup: false, sound: false } });
    onAlarmNew({ alarm: alarm({ id: 'z', level: 1 }), notify: { popup: true, sound: true } });
    expect(vi.mocked(playAlarm).mock.calls).toEqual([[1]]);
    expect(useAlarms.getState().recent.map((a) => a.id)).toEqual(['z', 'a1']);
    expect(useAlarms.getState().popups.map((a) => a.id)).toEqual(['z']);
  });
});

describe('告警設置', () => {
  it('切換開關、改等級後儲存：只送有變更的項目', async () => {
    const rules = [rule({}), rule({ type: 'estop', name: '急停' }), rule({ type: 'smoke', name: '煙霧', category: 'business', level: 1, popup: true })];
    const calls = setup(['alarmset'], <AlarmSettingsPage />, { rules });
    await screen.findByText('急停');
    expect(screen.getByText('系統告警')).toBeTruthy();
    expect(screen.getByText('業務告警')).toBeTruthy();
    const save = screen.getByRole('button', { name: '儲存' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('急停 彈窗提醒'));
    fireEvent.change(screen.getByLabelText('急停 告警級別'), { target: { value: '1' } });
    expect(screen.getByText('有未儲存的變更')).toBeTruthy();
    fireEvent.click(save);
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({
      rules: [{ type: 'estop', level: 1, popup: true, sound: true, needHandle: true, smsUserIds: [], dedupSec: 60 }],
    });
  });

  it('簡訊接收人穿梭框', async () => {
    setup(['alarmset'], <AlarmSettingsPage />, { rules: [rule({})] });
    fireEvent.click(await screen.findByRole('button', { name: '接收人（0）' }));
    const dlg = screen.getByRole('dialog', { name: '機器人離線 — 簡訊接收人' });
    fireEvent.click(within(dlg).getByLabelText(/系統管理員/));
    fireEvent.click(within(dlg).getByRole('button', { name: '加入接收人' }));
    expect(within(dlg).getByText('接收人（1）')).toBeTruthy();
    fireEvent.click(within(dlg).getByRole('button', { name: '確定' }));
    expect(screen.getByRole('button', { name: '接收人（1）' })).toBeTruthy();
  });
});
