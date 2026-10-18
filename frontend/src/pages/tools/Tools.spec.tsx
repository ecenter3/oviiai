import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAuth } from '../../stores/auth';
import { useToast } from '../../stores/toast';
import { type Asset, AssetsPage } from './AssetsPage';
import { HELP, HelpPage } from './HelpPage';
import { LogsPage, type RobotLog } from './LogsPage';
import { VersionsPage, type VersionsResp } from './VersionsPage';

type Call = { url: string; method: string; body?: unknown; form?: FormData };
function setup(ui: ReactNode, routes: (url: string, method: string) => unknown, perms = ['media', 'op.remote', 'logs', 'versions', 'help']) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const form = init?.body instanceof FormData ? init.body : undefined;
      calls.push({ url, method, form, body: init?.body && !form ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify(routes(url, method) ?? {}));
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

const ROBOTS = [
  { id: 'r1', code: 'ANBOT-001', caps: ['talk', 'screen'], live: { online: true } },
  { id: 'r2', code: 'B2-001', caps: ['talk_live'], live: { online: false } },
  { id: 'r3', code: 'X30-001', caps: [], live: { online: true } },
];
const asset = (over: Partial<Asset>): Asset => ({ id: 'a1', kind: 'audio', name: '請勿進入', note: null, mime: 'audio/mpeg', sizeBytes: 30720, durationMs: 2400, text: null, createdByName: '管理員', createdAt: '2026-10-18T02:00:00Z', url: 'http://s3/a1.mp3', ...over });

describe('音視頻管理（T-42）', () => {
  it('列表、試聽；只列出能播放或有螢幕的機器人；推送與略過原因', async () => {
    const calls = setup(<AssetsPage />, (url, method) => {
      if (url.endsWith('/robots')) return ROBOTS;
      if (url.includes('/assets?kind=audio')) return [asset({})];
      if (url.includes('/assets?kind=image')) return [asset({ id: 'i1', kind: 'image', name: '禁止進入', mime: 'image/png', durationMs: null, url: 'http://s3/i1.png' })];
      if (method === 'POST' && url.endsWith('/push')) return [{ robotId: 'r1', code: 'ANBOT-001', ok: true }, { robotId: 'r2', code: 'B2-001', ok: false, reason: '離線' }];
      return [];
    });
    const row = (await screen.findByText('請勿進入')).closest('tr')!;
    expect(row.textContent).toContain('mpeg · 00:02 · 30 KB');
    fireEvent.click(within(row).getByRole('button', { name: '展開預覽' }));
    expect(screen.getByLabelText('預覽 請勿進入').getAttribute('src')).toBe('http://s3/a1.mp3');
    // 音訊：能播放的（talk、talk_live）才列出
    await screen.findByText('ANBOT-001');
    expect(screen.getByText('B2-001')).toBeTruthy();
    expect(screen.queryByText('X30-001')).toBeNull();
    fireEvent.click(within(row).getByRole('button', { name: '推送' }));
    await waitFor(() => expect(toasts()).toContain('請先在右側勾選機器人'));
    fireEvent.click(screen.getByText('ANBOT-001').closest('label')!.querySelector('input')!);
    fireEvent.click(screen.getByText('B2-001').closest('label')!.querySelector('input')!);
    fireEvent.click(within(row).getByRole('button', { name: '推送' }));
    await waitFor(() => expect(toasts()).toContain('已推送「請勿進入」到 1 台機器人'));
    expect(toasts()).toContain('沒有推送：B2-001（離線）');
    expect(calls.find((c) => c.url.endsWith('/push'))!.body).toEqual({ robotIds: ['r1', 'r2'] });

    // 警示圖：只列出有螢幕的；推送帶顯示秒數
    fireEvent.click(screen.getByLabelText('警示圖'));
    await screen.findByText('禁止進入');
    expect(screen.queryByText('B2-001')).toBeNull();
    expect(screen.getByLabelText('顯示時間')).toBeTruthy();
  });

  it('上傳音訊（帶長度）、新增詞條', async () => {
    const calls = setup(<AssetsPage />, (url) => (url.endsWith('/robots') ? ROBOTS : url.includes('/assets?') ? [] : asset({ name: 'new' })));
    class FakeAudio {
      duration = 3.2;
      onloadedmetadata: (() => void) | null = null;
      set src(_v: string) {
        setTimeout(() => this.onloadedmetadata?.());
      }
    }
    vi.stubGlobal('Audio', FakeAudio);
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => undefined }));
    await screen.findByText('還沒有音訊，按右側「上傳檔案」');
    fireEvent.change(screen.getByLabelText('選擇檔案'), { target: { files: [new File([new Uint8Array(10)], '請離開.mp3', { type: 'audio/mpeg' })] } });
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.form)).toBe(true));
    const f = calls.find((c) => c.form)!.form!;
    expect([f.get('kind'), f.get('durationMs'), (f.get('file') as File).name]).toEqual(['audio', '3200', '請離開.mp3']);

    fireEvent.click(screen.getByLabelText('詞條'));
    fireEvent.click(await screen.findByRole('button', { name: '新增詞條' }));
    fireEvent.change(screen.getByLabelText('名稱'), { target: { value: '疏散' } });
    fireEvent.change(screen.getByLabelText('內容'), { target: { value: '請往出口疏散' } });
    fireEvent.click(screen.getByRole('button', { name: '新增' }));
    await waitFor(() => expect(calls.find((c) => c.url.endsWith('/assets/text'))?.body).toEqual({ name: '疏散', text: '請往出口疏散' }));
  });
});

describe('日誌管理（T-42）', () => {
  const log = (over: Partial<RobotLog>): RobotLog => ({ id: 'l1', robotId: 'r1', robotCode: 'ANBOT-001', subsystem: 'motion', status: 'uploaded', sizeBytes: 2048, error: null, requestedByName: '維修', createdAt: '2026-10-18T02:00:00Z', uploadedAt: '2026-10-18T02:00:05Z', fileName: 'ANBOT-001_motion_20261018100000.log', ...over });
  it('列表（下載、上傳中、失敗原因）；選機器人與子系統後獲取文件', async () => {
    const calls = setup(<LogsPage />, (url, method) => {
      if (url.endsWith('/robots')) return ROBOTS;
      if (method === 'POST') return log({ id: 'l3', status: 'requested', subsystem: 'video' });
      if (url.includes('/robot-logs/l1/url')) return { url: 'http://s3/dl' };
      return { items: [log({}), log({ id: 'l2', status: 'failed', error: '磁碟錯誤', fileName: 'ANBOT-001_motion_20261018090000.log' })], total: 2 };
    });
    const row = (await screen.findByText('ANBOT-001_motion_20261018100000.log')).closest('tr')!;
    expect(row.textContent).toContain('2.0 KB');
    expect(screen.getByText('失敗：磁碟錯誤')).toBeTruthy();
    const btn = screen.getByRole('button', { name: '獲取文件' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('機器人'), { target: { value: 'r1' } });
    fireEvent.change(screen.getByLabelText('子系統'), { target: { value: 'video' } });
    fireEvent.click(btn);
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ robotId: 'r1', subsystem: 'video' }));
    await waitFor(() => expect(toasts()).toContain('已請 ANBOT-001 上傳視頻子系統日誌'));
  });
});

describe('版本管理（T-42）', () => {
  it('後端、前端、轉接器（版本、狀態、機器人）、機器人', async () => {
    const v: VersionsResp = {
      backend: { version: '1.2.0', commit: 'abc123', node: 'v22.22.3', startedAt: '2026-10-18T01:00:00Z' },
      adapters: [
        { name: 'mock', version: '0.2.0', alive: true, lastSeen: '2026-10-18T02:00:00Z', robots: ['ANBOT-001', 'B2-001'] },
        { name: 'deep_x30', version: '0.2.0', alive: false, lastSeen: '2026-10-17T02:00:00Z', robots: ['X30-001'] },
      ],
      robots: [{ id: 'r1', code: 'ANBOT-001', brand: 'anbot', model: 'ANBOT-Y', serialNo: 'SN1', adapter: 'mock', enabled: true, online: true }],
    };
    setup(<VersionsPage />, () => v);
    const be = (await screen.findByText('1.2.0')).closest('tr')!;
    expect(be.textContent).toContain('1.2.0');
    expect(be.textContent).toContain('commit abc123');
    expect(screen.getByText('前端').closest('tr')!.textContent).toContain(__APP_VERSION__);
    expect(screen.getAllByText('mock')[0].closest('tr')!.textContent).toContain('連線中');
    expect(screen.getByText('deep_x30').closest('tr')!.textContent).toContain('斷線');
    expect(screen.getByText('SN1').closest('tr')!.textContent).toContain('待 SDK 提供');
  });
});

describe('幫助中心（T-42）', () => {
  it('分類、搜尋、打開文章看步驟', () => {
    setup(<HelpPage />, () => ({}));
    expect(screen.getByText(`共 ${HELP.length} 篇`)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '常見問題' }));
    expect(screen.getByText(`共 ${HELP.filter((h) => h[0] === '常見問題').length} 篇`)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '全部分類' }));
    fireEvent.change(screen.getByLabelText('搜索'), { target: { value: '急停' } });
    fireEvent.click(screen.getByRole('button', { name: '搜索' }));
    fireEvent.click(screen.getByRole('button', { name: /急停與解除/ }));
    const dlg = screen.getByRole('dialog', { name: '急停與解除' });
    expect(within(dlg).getAllByRole('listitem').length).toBeGreaterThan(1);
    fireEvent.change(screen.getByLabelText('搜索'), { target: { value: '不存在的字' } });
    fireEvent.click(screen.getByRole('button', { name: '搜索' }));
    expect(screen.getByText('找不到相關文章，換個關鍵字試試')).toBeTruthy();
  });
});
