import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Alarm, useAlarms } from '../../stores/alarms';
import { useAuth } from '../../stores/auth';
import { AlertLog } from './AlertLog';

const alarm = (over: Partial<Alarm>): Alarm => ({
  id: 'a1',
  code: 'A-20261016-0001',
  type: 'battery_low',
  name: '低電量',
  category: 'system',
  level: 2,
  floorId: '1f',
  robotId: 'r1',
  robotCode: 'B2-001',
  cameraId: null,
  x: 1,
  y: 2,
  message: 'B2-001 電量 24%，低於回充門檻 25%',
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

function Where() {
  const l = useLocation();
  return <div data-testid="where">{l.pathname + l.search}</div>;
}

beforeEach(() => {
  useAlarms.getState().clear();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [alarm({})], total: 1, unhandled: 1 }))));
  useAuth.setState({ status: 'authed', perms: ['monitor', 'sysalarm'], user: null });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <Routes>
          <Route path="*" element={<AlertLog />} />
        </Routes>
        <Where />
      </MemoryRouter>
    </QueryClientProvider>,
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('實時監控：告警日誌', () => {
  it('先載入最近 20 條；alarm.new 即時加在最上面；點告警跳到告警頁', async () => {
    await screen.findByText(/B2-001 電量 24%/);
    expect(screen.getByText('未處理 1 · 待人工複判 0 · 點選告警可處理')).toBeTruthy();
    act(() =>
      useAlarms.getState().add({
        alarm: alarm({ id: 'b', code: 'A-2', category: 'business', level: 1, status: 'review', message: '疑似人員闖入', confidence: 55, robotCode: null }),
        notify: { popup: true, sound: true },
      }),
    );
    const items = screen.getAllByRole('button');
    expect(items[0].textContent).toContain('疑似人員闖入');
    expect(items[0].textContent).toContain('AI 55%');
    expect(items[0].textContent).toContain('待人工複判');
    expect(screen.getByText('未處理 1 · 待人工複判 1 · 點選告警可處理')).toBeTruthy();

    fireEvent.click(items[1]);
    expect(screen.getByTestId('where').textContent).toBe('/alarms/system?id=a1');
  });
});
