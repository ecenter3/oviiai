import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuth } from '../../stores/auth';
import type { DispatchMode, Task } from '../../stores/tasks';
import { useTasks } from '../../stores/tasks';
import { DispatchPage, daysLeft } from './DispatchPage';

const task = (over: Partial<Task>): Task => ({
  id: 'id1',
  code: 'T-20261015-0001',
  kind: 'inspect',
  priority: 'P3',
  source: 'manual',
  floorId: '1f',
  target: { x: 12, y: 5 },
  robotId: null,
  robotCode: null,
  pinnedRobot: false,
  status: 'pending_approval',
  note: '確認出口',
  createdByName: '王主管',
  createdAt: '2026-10-15T08:00:00Z',
  startedAt: null,
  endedAt: null,
  failReason: null,
  progress: {},
  ...over,
});

function setup(perms: string[], opts: { mode?: Partial<DispatchMode>; pending?: Task[]; recent?: Task[] } = {}) {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  const mode: DispatchMode = { approval: true, approvalSetting: true, approvalUntil: '2027-01-31', p1Preempt: true, ...opts.mode };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const json = (b: unknown) => new Response(JSON.stringify(b));
      if (url.endsWith('/floors')) return json([{ id: '1f', name: '1F 辦公室' }]);
      if (url.endsWith('/dispatch/mode')) return json(mode);
      if (url.includes('status=pending_approval')) return json({ items: opts.pending ?? [] });
      if (url.includes('/tasks?size=30')) return json({ items: opts.recent ?? [] });
      if (/\/tasks\/[^/]+$/.test(url)) {
        const t = (opts.recent ?? []).find((x) => url.endsWith(x.id))!;
        return json({ ...t, events: [{ at: '2026-10-15T08:00:00Z', type: 'created', data: { by: 'f84f2f51-5bee-4c65-a7e1-93ad6516940a' } }, { at: '2026-10-15T08:00:02Z', type: 'paused', data: { reason: 'preempt', robot: 'B2-001' } }] });
      }
      return json({});
    }),
  );
  useAuth.setState({ status: 'authed', perms, user: null });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <DispatchPage />
    </QueryClientProvider>,
  );
  return calls;
}

beforeEach(() => useTasks.setState({ active: {}, loaded: false }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('審批頁（T-18）', () => {
  it('daysLeft 以台北日期計算', () => {
    expect(daysLeft('2027-01-31', new Date('2027-01-30T16:30:00Z'))).toBe(0); // 台北 1/31 00:30
    expect(daysLeft('2027-01-31', new Date('2027-01-29T03:00:00Z'))).toBe(2);
    expect(daysLeft('2027-01-31', new Date('2027-01-31T16:00:00Z'))).toBe(-1);
  });

  it('審批模式開啟：顯示期限、剩餘天數、到期自動關閉說明', async () => {
    setup(['dispatch'], { mode: { approvalUntil: '2099-12-31' } });
    const s = await screen.findByRole('status');
    expect(s.textContent).toContain('審批模式開啟中');
    expect(s.textContent).toContain('審批期限：2099-12-31');
    expect(s.textContent).toMatch(/還有 \d+ 天/);
    expect(s.textContent).toContain('期限過後自動關閉');
  });

  it('審批已關閉：顯示自動派工', async () => {
    setup(['dispatch'], { mode: { approval: false, approvalSetting: false } });
    expect((await screen.findByRole('status')).textContent).toContain('自動派工');
  });

  it('待審批清單：核准、駁回（需理由）、全部核准；沒有 op.approve 看不到按鈕', async () => {
    const pending = [task({ id: 'a', code: 'T-A', priority: 'P2' }), task({ id: 'b', code: 'T-B' })];
    const calls = setup(['dispatch', 'op.approve'], { pending });
    const rowA = (await screen.findByText('T-A')).closest('tr')!;
    expect(rowA.textContent).toContain('王主管');
    expect(rowA.textContent).toContain('確認出口');
    expect(screen.getByText(/待審批清單（2）/)).toBeTruthy();

    fireEvent.click(within(rowA as HTMLElement).getByRole('button', { name: '核准' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/v1/tasks/a/approve' && c.method === 'POST')).toBe(true));

    fireEvent.click(within(screen.getByText('T-B').closest('tr') as HTMLElement).getByRole('button', { name: '駁回' }));
    const dlg = screen.getByRole('dialog');
    fireEvent.change(within(dlg).getByRole('textbox'), { target: { value: '人力不足' } });
    fireEvent.click(within(dlg).getByRole('button', { name: '駁回' }));
    await waitFor(() => expect(calls.find((c) => c.url === '/api/v1/tasks/b/reject')?.body).toEqual({ reason: '人力不足' }));

    fireEvent.click(screen.getByRole('button', { name: '全部核准' }));
    await waitFor(() => expect(calls.filter((c) => c.url.endsWith('/approve')).length).toBeGreaterThanOrEqual(3));
  });

  it('沒有 op.approve：只能看清單', async () => {
    setup(['dispatch'], { pending: [task({ id: 'a', code: 'T-A' })] });
    await screen.findByText('T-A');
    expect(screen.queryByRole('button', { name: '核准' })).toBeNull();
  });

  it('最近任務 → 點開看歷程（含暫停原因）；進行中可取消（先確認）', async () => {
    const recent = [task({ id: 'r', code: 'T-R', status: 'paused', robotCode: 'B2-001', progress: { pausedBy: 'preempt' } })];
    const calls = setup(['dispatch', 'op.dispatch'], { recent });
    fireEvent.click(await screen.findByText('T-R'));
    const drawer = await screen.findByRole('dialog', { name: '任務 T-R' });
    await waitFor(() => expect(drawer.textContent).toContain('暫停（B2-001 · P1 插隊）'));
    expect(drawer.textContent).not.toContain('f84f2f51');
    fireEvent.click(within(drawer).getByRole('button', { name: '取消任務' }));
    expect(calls.some((c) => c.url.endsWith('/cancel'))).toBe(false);
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '取消任務' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/v1/tasks/r/cancel')).toBe(true));
  });
});
