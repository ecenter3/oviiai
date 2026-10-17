import { paramDefaults, type PermCode } from '@oviiai/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAuth } from '../../stores/auth';
import { useRealtime } from '../../stores/realtime';
import { useToast } from '../../stores/toast';
import { applyReport, ParamsPage } from './ParamsPage';

let calls: { url: string; method: string; body?: Record<string, unknown> }[];
function setup(perms: PermCode[] = ['params', 'op.config', 'settings']) {
  calls = [];
  const params = { walk: paramDefaults('walk'), video: paramDefaults('video'), talk: paramDefaults('talk'), ext: paramDefaults('ext') };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method: init?.method ?? 'GET', body });
      const json = (b: unknown) => new Response(JSON.stringify(b));
      if (url.endsWith('/robots'))
        return json([
          { id: 'r1', code: 'B2-001', floorId: '1f' },
          { id: 'r2', code: 'B2-002', floorId: '1f' },
          { id: 'r3', code: 'X30-001', floorId: '2f' },
        ]);
      if (url.endsWith('/floors')) return json([{ id: '1f', name: '1F 辦公室' }, { id: '2f', name: '2F 工廠' }]);
      if (url.endsWith('/params') && init?.method === 'PUT') return json({ sync: 'sent', cmdId: 'c_p1', params: { ...params, [body.subsystem]: body.values } });
      if (url.endsWith('/params')) return json({ code: 'B2-001', floorId: '1f', params, chargeReturnAt: 25 });
      if (url.endsWith('/apply-floor')) return json({ updated: 2, results: [{ code: 'B2-001', sync: 'sent' }, { code: 'B2-002', sync: 'offline' }] });
      return json({});
    }),
  );
  useAuth.setState({ status: 'authed', perms, user: null });
  render(
    <MemoryRouter>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ParamsPage />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('機器人參數（T-27）', () => {
  it('四個子系統表單（欄位來自 contracts）；回充電量顯示全廠設定；儲存送 PUT 目前子系統', async () => {
    setup();
    const speed = await screen.findByRole('slider', { name: '導航速度' });
    expect(screen.getByText('25%')).toBeTruthy();
    fireEvent.change(speed, { target: { value: '0.6' } });
    fireEvent.click(screen.getByRole('radio', { name: '安全模式' }));
    expect(screen.getByText('尚未儲存')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '儲存參數' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.url).toBe('/api/v1/robots/r1/params');
    expect(put.body).toEqual({ subsystem: 'walk', values: { ...paramDefaults('walk'), speed: 0.6, collide: 'safe' } });

    fireEvent.click(screen.getByRole('tab', { name: '拓展參數' }));
    expect(screen.getByText('識別反應')).toBeTruthy();
    expect((screen.getByRole('combobox', { name: '黑名單' }) as HTMLSelectElement).value).toBe('alarm');
  });

  it('數字超出範圍：顯示錯誤、不能儲存', async () => {
    setup();
    fireEvent.click(await screen.findByRole('tab', { name: '交互子系統' }));
    const wait = await screen.findByRole('spinbutton', { name: '交互等待時間' });
    fireEvent.change(wait, { target: { value: '999' } });
    expect(screen.getByRole('alert').textContent).toBe('需介於 5 到 300');
    expect((screen.getByRole('button', { name: '儲存參數' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('套用同樓層：確認後先儲存目前這台，再送 apply-floor（來源、樓層、子系統）', async () => {
    setup();
    await screen.findByRole('slider', { name: '導航速度' });
    fireEvent.click(screen.getByRole('button', { name: '套用到同樓層全部機器人' }));
    const dlg = screen.getByRole('alertdialog');
    expect(dlg.textContent).toContain('1F 辦公室 全部 2 台');
    fireEvent.click(within(dlg).getByRole('button', { name: '套用' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/apply-floor'))).toBe(true));
    const order = calls.filter((c) => c.method !== 'GET').map((c) => c.url);
    expect(order).toEqual(['/api/v1/robots/r1/params', '/api/v1/robots/params/apply-floor']);
    expect(calls.find((c) => c.url.endsWith('/apply-floor'))!.body).toEqual({ fromRobotId: 'r1', floorId: '1f', subsystem: 'walk' });
  });

  it('只有 params（沒有 op.config）：可看不可改', async () => {
    setup(['params']);
    const speed = await screen.findByRole('slider', { name: '導航速度' });
    expect((speed as HTMLInputElement).closest('fieldset')!.disabled).toBe(true);
    expect(screen.queryByRole('button', { name: '儲存參數' })).toBeNull();
    expect(screen.getByText('目前身分只能檢視參數')).toBeTruthy();
    expect(screen.getByText('25%')).toBeTruthy(); // 沒有 settings 權限也看得到全廠回充門檻
    expect(screen.queryByRole('link', { name: '到「派工與充電規則」調整' })).toBeNull();
  });

  it('儲存後等轉接器回報：顯示已套用幾項、此機型不支援哪些（PR #13 審查第 2 點）', async () => {
    setup();
    await screen.findByRole('slider', { name: '導航速度' });
    useRealtime.setState({ cmdResults: [] });
    fireEvent.click(screen.getByRole('button', { name: '儲存參數' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    await new Promise((r) => setTimeout(r, 0));
    act(() =>
      useRealtime.getState().addCmdResult({ cmdId: 'c_p1', robotId: 'r1', code: 'B2-001', type: 'set_params', status: 'done', result: { applied: ['walk.speed'], ignored: ['walk.collide', 'walk.avoid'] } }),
    );
    await waitFor(() => expect(JSON.stringify(useToast.getState())).toContain('B2-001：已套用 1 項，此機型不支援：碰撞模式、繞障模式'));
  });

  it('applyReport：全部套用、失敗、舊版轉接器沒有 result、超過 6 項只列前 6 項', () => {
    const base = { cmdId: 'c', robotId: 'r', code: 'B2-001', type: 'set_params' };
    expect(applyReport('B2-001', { ...base, status: 'done', result: { applied: ['walk.speed'], ignored: [] } })).toEqual(['B2-001：1 項參數都已套用到機器人', 'ok']);
    expect(applyReport('B2-001', { ...base, status: 'failed', error: { code: 'X', msg: '逾時' } })[1]).toBe('error');
    expect(applyReport('B2-001', { ...base, status: 'done' })[0]).toBe('B2-001：機器人已收到參數');
    const many = ['hardStop', 'strobe', 'strobeTimer', 'strobeTime', 'lightTimer', 'lightTime', 'collide', 'avoid'].map((k) => `walk.${k}`);
    expect(applyReport('B2-001', { ...base, status: 'done', result: { applied: [], ignored: many } })[0]).toMatch(/照明燈時段 等 2 項$/);
  });
});
