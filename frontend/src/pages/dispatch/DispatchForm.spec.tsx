import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAuth } from '../../stores/auth';
import { DispatchForm, type Floor, type Template } from './DispatchForm';

const FLOORS: Floor[] = [
  { id: '1f', name: '1F 辦公室', widthM: 40, heightM: 36, planUrl: null },
  { id: 'b1', name: 'B1 停車場', widthM: 42, heightM: 28, planUrl: null },
];
const POIS = [
  { id: 'p-lobby', floorId: '1f', name: '大廳', x: 20, y: 32 },
  { id: 'p-gate', floorId: 'b1', name: '車道入口', x: 38, y: 24 },
];
const TEMPLATES: Template[] = [{ id: 't1', name: '安全巡查', kind: 'security', priority: 'P2', floorId: 'b1', target: { poiId: 'p-gate' } }];

function setup(perms = ['dispatch', 'op.dispatch']) {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
      if (url.endsWith('/pois')) return json(POIS);
      if (url.endsWith('/task-templates') && !init?.method) return json(TEMPLATES);
      if (url.endsWith('/robots')) return json([{ id: 'r-a1', code: 'ANBOT-001', floorId: 'b1' }, { id: 'r-b1', code: 'B2-001', floorId: '1f' }]);
      if (url.endsWith('/tasks')) return json({ id: 'x', code: 'T-20261015-0009', status: 'pending_approval' }, 201);
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      return json({ id: 'new' }, 201);
    }),
  );
  useAuth.setState({ status: 'authed', perms, user: null });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <DispatchForm floors={FLOORS} mode={{ approval: true, approvalSetting: true, approvalUntil: '2027-01-31', p1Preempt: true, pending: 0 }} />
    </QueryClientProvider>,
  );
  return calls;
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('手動派工與任務範本（T-20）', () => {
  it('點範本帶入表單（不直接建單）', async () => {
    const calls = setup();
    fireEvent.click(await screen.findByRole('button', { name: /^安全巡查/ }));
    expect((screen.getByLabelText('目標位置') as HTMLSelectElement).value).toBe('poi:p-gate');
    expect((screen.getByLabelText('優先級') as HTMLSelectElement).value).toBe('P2');
    expect((screen.getByLabelText('任務類型') as HTMLSelectElement).value).toBe('security');
    expect((screen.getByLabelText('任務備註') as HTMLTextAreaElement).value).toBe('安全巡查');
    expect(calls.some((c) => c.url.endsWith('/tasks'))).toBe(false);
  });

  it('送出：樓層與目標來自興趣點；可指定該樓層的機器人', async () => {
    const calls = setup();
    await screen.findByRole('option', { name: 'B1 停車場 - 車道入口' });
    fireEvent.change(screen.getByLabelText('目標位置'), { target: { value: 'poi:p-gate' } });
    await screen.findByRole('option', { name: 'ANBOT-001' });
    expect(screen.queryByRole('option', { name: 'B2-001' })).toBeNull(); // 只列該樓層
    fireEvent.change(screen.getByLabelText('指定機器人'), { target: { value: 'r-a1' } });
    fireEvent.change(screen.getByLabelText('優先級'), { target: { value: 'P1' } });
    fireEvent.change(screen.getByLabelText('任務備註'), { target: { value: '確認積水' } });
    fireEvent.click(screen.getByRole('button', { name: '✓ 派工' }));
    await waitFor(() =>
      expect(calls.find((c) => c.url === '/api/v1/tasks')?.body).toEqual({
        kind: 'inspect',
        priority: 'P1',
        floorId: 'b1',
        target: { poiId: 'p-gate' },
        robotId: 'r-a1',
        note: '確認積水',
      }),
    );
  });

  it('沒選目標不送出；沒有 op.dispatch 看不到派工按鈕', async () => {
    const calls = setup();
    await screen.findByRole('option', { name: 'B1 停車場 - 車道入口' });
    fireEvent.submit(screen.getByRole('form', { name: '🎯 手動派工' }));
    expect(calls.some((c) => c.url === '/api/v1/tasks')).toBe(false);
    cleanup();
    setup(['dispatch']);
    await screen.findByRole('option', { name: 'B1 停車場 - 車道入口' });
    expect(screen.queryByRole('button', { name: '✓ 派工' })).toBeNull();
  });

  it('存成範本、刪除範本（先確認）', async () => {
    const calls = setup();
    await screen.findByRole('option', { name: '1F 辦公室 - 大廳' });
    fireEvent.change(screen.getByLabelText('目標位置'), { target: { value: 'poi:p-lobby' } });
    fireEvent.change(screen.getByLabelText('任務備註'), { target: { value: '大廳巡檢' } });
    fireEvent.click(screen.getByRole('button', { name: '存成範本' }));
    await waitFor(() =>
      expect(calls.find((c) => c.url === '/api/v1/task-templates' && c.method === 'POST')?.body).toEqual({
        name: '大廳巡檢',
        kind: 'inspect',
        priority: 'P3',
        floorId: '1f',
        target: { poiId: 'p-lobby' },
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: '刪除範本 安全巡查' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '刪除範本' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/v1/task-templates/t1' && c.method === 'DELETE')).toBe(true));
  });

  it('「在地圖上點選…」開啟平面圖取座標', async () => {
    setup();
    await screen.findByRole('option', { name: '1F 辦公室 - 在地圖上點選…' });
    fireEvent.change(screen.getByLabelText('目標位置'), { target: { value: 'pick:1f' } });
    const dlg = screen.getByRole('dialog', { name: '在地圖上點選目標位置' });
    expect((within(dlg).getByRole('button', { name: '使用這個位置' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
