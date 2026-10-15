import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuth } from '../../stores/auth';
import { type Task, useTasks } from '../../stores/tasks';
import { TasksPanel } from './TasksPanel';

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
  status: 'queued',
  note: null,
  createdAt: '2026-10-15T08:00:00Z',
  startedAt: null,
  endedAt: null,
  failReason: null,
  progress: {},
  ...over,
});

function setup(perms: string[], tasks: Task[]) {
  const calls: { url: string; body?: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.startsWith('/api/v1/tasks?')) return new Response(JSON.stringify({ items: tasks, total: tasks.length, page: 1, size: 100 }));
      if (url.endsWith('/dispatch/mode')) return new Response(JSON.stringify({ approval: !perms.includes('auto'), approvalSetting: true, approvalUntil: '2027-01-31', p1Preempt: true }));
      return new Response(JSON.stringify({}), { status: 200 });
    }),
  );
  useAuth.setState({ status: 'authed', perms, user: null });
  const onFocusRobot = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TasksPanel floorName={(id) => id.toUpperCase()} focusedRobotId={null} onFocusRobot={onFocusRobot} />
    </QueryClientProvider>,
  );
  return { calls, onFocusRobot };
}

beforeEach(() => useTasks.setState({ active: {}, loaded: false }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('派工任務面板', () => {
  it('依狀態分組：待審核、待派工、進行中（含暫停）；P1 紅框', async () => {
    setup(['monitor'], [
      task({ id: 'a', code: 'T-A', status: 'pending_approval' }),
      task({ id: 'b', code: 'T-B', status: 'queued', priority: 'P1' }),
      task({ id: 'c', code: 'T-C', status: 'running', robotId: 'r1', robotCode: 'B2-001' }),
      task({ id: 'd', code: 'T-D', status: 'paused', robotId: 'r2', robotCode: 'B2-002', progress: { pausedBy: 'teleop' } }),
    ]);
    await screen.findByText('T-A');
    expect(screen.getByText(/待審核/).textContent).toContain('(1)');
    expect(screen.getByText(/待派工/).textContent).toContain('(1)');
    expect(screen.getByText(/進行中/).textContent).toContain('(2)');
    expect(screen.getByText('T-B').closest('.task')!.className).toContain('p1');
    expect(screen.getByText('B2-001 · 執行中')).toBeTruthy();
    expect(screen.getByText('已暫停（遙控接管）')).toBeTruthy();
    expect(screen.getAllByText('等待可用機器人')).toHaveLength(1);
  });

  it('WebSocket 更新：派出後從待派工移到進行中，完成後消失', async () => {
    setup(['monitor'], [task({ id: 'x', code: 'T-X' })]);
    await screen.findByText('T-X');
    act(() => useTasks.getState().update(task({ id: 'x', code: 'T-X', status: 'running', robotId: 'r1', robotCode: 'B2-001' })));
    expect(screen.getByText(/進行中/).textContent).toContain('(1)');
    expect(screen.getByText(/待派工/).textContent).toContain('(0)');
    act(() => useTasks.getState().update(task({ id: 'x', code: 'T-X', status: 'done' })));
    expect(screen.queryByText('T-X')).toBeNull();
  });

  it('核准：有 op.approve 才有按鈕；呼叫 approve API', async () => {
    const { calls } = setup(['monitor', 'op.approve'], [task({ id: 'p', code: 'T-P', status: 'pending_approval' })]);
    const card = (await screen.findByText('T-P')).closest('.task') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: '核准' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/v1/tasks/p/approve')).toBe(true));
  });

  it('駁回需填理由', async () => {
    const { calls } = setup(['monitor', 'op.approve'], [task({ id: 'p', code: 'T-P', status: 'pending_approval' })]);
    const card = (await screen.findByText('T-P')).closest('.task') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: '駁回' }));
    const dialog = screen.getByRole('dialog');
    const submit = within(dialog).getByRole('button', { name: '駁回' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: '重複派工' } });
    fireEvent.click(submit);
    await waitFor(() => expect(calls.find((c) => c.url === '/api/v1/tasks/p/reject')?.body).toEqual({ reason: '重複派工' }));
  });

  it('沒有 op.approve 看不到核准、駁回', async () => {
    setup(['monitor'], [task({ id: 'p', code: 'T-P', status: 'pending_approval' })]);
    await screen.findByText('T-P');
    expect(screen.queryByRole('button', { name: '核准' })).toBeNull();
  });

  it('點進行中的任務 → 在地圖上定位該機器人', async () => {
    const { onFocusRobot } = setup(['monitor'], [task({ id: 'c', code: 'T-C', status: 'running', robotId: 'r1', robotCode: 'B2-001' })]);
    fireEvent.click((await screen.findByText('T-C')).closest('.task')!);
    expect(onFocusRobot).toHaveBeenCalledWith(expect.objectContaining({ robotId: 'r1' }));
  });

  it('審批模式／自動派工標籤（原型）', async () => {
    setup(['monitor'], []);
    expect(await screen.findByText('審批模式')).toBeTruthy();
    cleanup();
    setup(['monitor', 'auto'], []);
    expect(await screen.findByText('自動派工')).toBeTruthy();
  });

  it('全部核准：待審核 2 筆以上才出現', async () => {
    const { calls } = setup(['monitor', 'op.approve'], [
      task({ id: 'a', code: 'T-A', status: 'pending_approval' }),
      task({ id: 'b', code: 'T-B', status: 'pending_approval' }),
    ]);
    fireEvent.click(await screen.findByRole('button', { name: '全部核准' }));
    await waitFor(() => expect(calls.filter((c) => c.url.endsWith('/approve')).map((c) => c.url).sort()).toEqual(['/api/v1/tasks/a/approve', '/api/v1/tasks/b/approve']));
  });

  it('P1 無可用機器人：紅字提示；被插隊中斷的任務：說明 P1 完成後續做', async () => {
    setup(['monitor'], [
      task({ id: 'p', code: 'T-P1', priority: 'P1', status: 'queued', progress: { noRobotAt: Date.now() } }),
      task({ id: 'v', code: 'T-V', status: 'paused', robotId: 'r1', robotCode: 'B2-001', progress: { pausedBy: 'preempt' } }),
    ]);
    const p1 = (await screen.findByText('無可用機器人，已通知控制室')) as HTMLElement;
    expect(p1.className).toContain('crit');
    expect(screen.getByText('被 P1 插隊中斷，P1 完成後續做')).toBeTruthy();
  });
});
