import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAuth } from '../../stores/auth';
import { chargeOrderOk, SettingsPage } from './SettingsPage';

const VALUES = {
  'charge.returnAt': 25,
  'charge.minAccept': 40,
  'charge.resumeAt': 90,
  'dispatch.p1Preempt': true,
  'dispatch.approval': true,
  'dispatch.approvalUntil': '2027-01-31',
  'alarm.aiConfidence': 70,
  'robot.offlineSec': 10,
  'cmd.timeoutSec': 15,
  'charge.mode.anbot': 'auto',
  'charge.mode.unitree': 'manual',
};

function setup(perms: string[], pending = 3) {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const json = (b: unknown) => new Response(JSON.stringify(b));
      if (url.endsWith('/settings') && !init?.method) return json({ values: VALUES, defaults: { ...VALUES, 'charge.returnAt': 25 }, brands: ['anbot', 'unitree'] });
      if (url.endsWith('/settings')) return json({ values: VALUES, released: pending });
      if (url.endsWith('/floors') && !init?.method) return json([{ id: '1f', name: '1F 辦公室', robotQuota: 10 }]);
      if (url.endsWith('/robots')) return json([{ floorId: '1f', model: 'B2' }]);
      if (url.endsWith('/cameras')) return json([{ floorId: '1f' }]);
      if (url.endsWith('/dispatch/mode')) return json({ approval: true, approvalSetting: true, approvalUntil: '2027-01-31', p1Preempt: true, pending });
      return json({ ok: true });
    }),
  );
  useAuth.setState({ status: 'authed', perms, user: null });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SettingsPage />
    </QueryClientProvider>,
  );
  return calls;
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const puts = (calls: { method: string; url: string; body?: unknown }[]) => calls.filter((c) => c.method === 'PUT');

describe('派工與充電規則頁（T-20）', () => {
  it('順序檢查：回充 < 接單 < 充電完成', () => {
    expect(chargeOrderOk({ 'charge.returnAt': 25, 'charge.minAccept': 40, 'charge.resumeAt': 90 })).toBe(true);
    expect(chargeOrderOk({ 'charge.returnAt': 45, 'charge.minAccept': 40, 'charge.resumeAt': 90 })).toBe(false);
  });

  it('顯示目前設定：充電門檻、各品牌充電方式、樓層配置', async () => {
    setup(['settings', 'op.config']);
    // 表單值在設定載入後由 effect 帶入：等值出現（第一次渲染可能還是 0）
    const ret = (await screen.findByLabelText('回充門檻')) as HTMLInputElement;
    await waitFor(() => expect(ret.value).toBe('25'));
    expect((screen.getByLabelText('萬為') as HTMLSelectElement).value).toBe('auto');
    expect((screen.getByLabelText('宇樹') as HTMLSelectElement).value).toBe('manual');
    expect((screen.getByLabelText('1F 辦公室 配置台數') as HTMLInputElement).value).toBe('10');
  });

  it('門檻順序不對：顯示錯誤、不送出', async () => {
    const calls = setup(['settings', 'op.config']);
    fireEvent.change(await screen.findByLabelText('回充門檻'), { target: { value: '45' } });
    expect(screen.getByRole('alert').textContent).toContain('回充門檻必須低於接單最低電量');
    fireEvent.click(screen.getByRole('button', { name: '儲存設定' }));
    expect(puts(calls)).toEqual([]);
  });

  it('只送出有改的設定；改樓層台數走 PUT /floors/:id', async () => {
    const calls = setup(['settings', 'op.config']);
    fireEvent.change(await screen.findByLabelText('回充門檻'), { target: { value: '30' } });
    fireEvent.change(screen.getByLabelText('萬為'), { target: { value: 'manual' } });
    fireEvent.change(screen.getByLabelText('1F 辦公室 配置台數'), { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: '儲存設定' }));
    await waitFor(() => expect(puts(calls)).toHaveLength(2));
    expect(puts(calls)[0].body).toEqual({ values: { 'charge.returnAt': 30, 'charge.mode.anbot': 'manual' } });
    expect(puts(calls)[1]).toMatchObject({ url: '/api/v1/floors/1f', body: { robotQuota: 12 } });
  });

  it('關閉審批：提示有幾筆待審批會立即派出，確認後才儲存（PR #7 審查第 3 點）', async () => {
    const calls = setup(['settings', 'op.config'], 3);
    fireEvent.click(await screen.findByLabelText('審批模式（上線第一個月）'));
    fireEvent.click(screen.getByRole('button', { name: '儲存設定' }));
    const dlg = await screen.findByRole('alertdialog');
    expect(dlg.textContent).toContain('目前有 3 筆待審批任務，關閉後會立即自動派工');
    expect(puts(calls)).toEqual([]);
    fireEvent.click(within(dlg).getByRole('button', { name: '關閉並派出' }));
    await waitFor(() => expect(puts(calls)[0]?.body).toEqual({ values: { 'dispatch.approval': false } }));
  });

  it('沒有待審批時直接關閉，不跳確認', async () => {
    const calls = setup(['settings', 'op.config'], 0);
    fireEvent.click(await screen.findByLabelText('審批模式（上線第一個月）'));
    fireEvent.click(screen.getByRole('button', { name: '儲存設定' }));
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('還原預設值', async () => {
    setup(['settings', 'op.config']);
    fireEvent.change(await screen.findByLabelText('回充門檻'), { target: { value: '33' } });
    fireEvent.click(screen.getByRole('button', { name: '還原預設值' }));
    expect((screen.getByLabelText('回充門檻') as HTMLInputElement).value).toBe('25');
  });

  it('沒有 op.config 只能檢視', async () => {
    setup(['settings']);
    expect((await screen.findByLabelText('回充門檻')).matches(':disabled')).toBe(true); // 由 fieldset disabled 停用
    expect((screen.getByRole('button', { name: '儲存設定' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('你沒有修改設定的權限（op.config），只能檢視。')).toBeTruthy();
  });
});
