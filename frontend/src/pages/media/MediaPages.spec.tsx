import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { PermCode } from '@oviiai/contracts';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAuth } from '../../stores/auth';
import { type MediaItem, useMedia } from '../../stores/media';
import { CapturesPage, mediaQuery, RecordsPage } from './MediaPages';

const item = (over: Partial<MediaItem>): MediaItem => ({
  id: 'm1',
  kind: 'snapshot',
  source: 'manual',
  streamKey: 'robot/B2-001/front',
  robotId: 'r1',
  robotCode: 'B2-001',
  cameraId: null,
  cameraCode: null,
  cameraName: null,
  floorId: '1f',
  alarmId: null,
  createdAt: '2026-10-17T02:00:00Z',
  endedAt: null,
  durationS: null,
  sizeBytes: 12000,
  contentType: 'image/jpeg',
  createdByName: '值班警衛',
  url: 'http://s3/media/a.jpg?sig',
  ...over,
});

let calls: { url: string; method: string; body?: unknown }[];
function setup(ui: ReactNode, items: MediaItem[], perms: PermCode[] = ['captures', 'records', 'op.media']) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const json = (b: unknown) => new Response(JSON.stringify(b));
      if (url.endsWith('/media/options')) return json({ robots: [{ id: 'r1', code: 'B2-001', floorId: '1f' }], cameras: [{ id: 'c1', code: 'CAM-1F-01', name: '1F 大門', floorId: '1f' }] });
      if (url.includes('/media?')) return json({ items, total: items.length, page: 1, size: 60 });
      if (url.includes('/url?download=1')) return json({ url: 'http://s3/dl' });
      if (url.endsWith('/media/delete')) return json({ deleted: 2 });
      return json({});
    }),
  );
  useAuth.setState({ status: 'authed', perms, user: null });
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('抓拍圖片、錄像回放（T-28）', () => {
  it('查詢字串：日期以台北時間整天計、機器人或攝影機、方式', () => {
    expect(Object.fromEntries(new URLSearchParams(mediaQuery('clip', { from: '2026-10-10', to: '2026-10-16', who: 'camera:c1', source: 'alarm' }, 2, 20)))).toEqual({
      kind: 'clip',
      page: '2',
      size: '20',
      from: '2026-10-10T00:00:00+08:00',
      to: '2026-10-17T00:00:00+08:00',
      camera: 'c1',
      source: 'alarm',
    });
  });

  it('縮圖牆：方式標籤、全選刪除（先確認）、點縮圖看大圖並下載；新抓拍即時重新查詢', async () => {
    setup(<CapturesPage />, [
      item({}),
      item({ id: 'm2', robotCode: null, robotId: null, cameraId: 'c1', cameraCode: 'CAM-1F-01', cameraName: '1F 大門', source: 'alarm' }),
      item({ id: 'm3', source: 'alarm', alarmId: 'a1' }),
    ]);
    const cards = await screen.findAllByRole('button', { name: /放大檢視/ });
    expect(cards).toHaveLength(3);
    // 告警證據不能選（全選也不含它）
    expect(screen.getAllByRole('button', { name: '選取' })).toHaveLength(2);
    expect(screen.getByLabelText('告警證據，保存期滿自動清除，不能手動刪除')).toBeTruthy();
    expect(screen.getAllByText('告警抓拍', { selector: '.badge2' })).toHaveLength(2);
    expect(screen.getByText('CAM-1F-01 1F 大門', { selector: 'b' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '全選' }));
    fireEvent.click(screen.getByRole('button', { name: '刪除（2）' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '刪除' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/media/delete'))).toBe(true));
    expect(calls.find((c) => c.url.endsWith('/media/delete'))!.body).toEqual({ ids: ['m1', 'm2'] });

    fireEvent.click(cards[0]);
    const box = screen.getByRole('dialog', { name: 'B2-001' });
    expect(box.querySelector('img')!.getAttribute('src')).toBe('http://s3/media/a.jpg?sig');
    fireEvent.click(within(box).getByRole('button', { name: '下載' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/media/m1/url?download=1'))).toBe(true));

    const before = calls.filter((c) => c.url.includes('/media?')).length;
    act(() => useMedia.getState().bump());
    await waitFor(() => expect(calls.filter((c) => c.url.includes('/media?')).length).toBe(before + 1));
  });

  it('沒有 op.media：不顯示全選、刪除與勾選框', async () => {
    setup(<CapturesPage />, [item({})], ['captures']);
    await screen.findAllByRole('button', { name: /放大檢視/ });
    expect(screen.queryByRole('button', { name: '全選' })).toBeNull();
    expect(screen.queryByRole('button', { name: /刪除/ })).toBeNull();
    expect(screen.queryByRole('button', { name: '選取' })).toBeNull();
  });

  it('錄像表格：時長、觸發方式；播放開影片視窗', async () => {
    setup(<RecordsPage />, [item({ kind: 'clip', durationS: 125, endedAt: '2026-10-17T02:02:05Z', contentType: 'video/mp4', url: 'http://s3/c.mp4?sig', sizeBytes: 2_500_000 })]);
    await screen.findByText('02:05');
    const row = screen.getAllByRole('row')[1];
    expect(within(row).getByText('手動錄影')).toBeTruthy();
    expect(within(row).getByText('2.4 MB')).toBeTruthy();
    fireEvent.click(within(row).getByRole('button', { name: '播放' }));
    const dlg = screen.getByRole('dialog', { name: '錄影回放 · B2-001' });
    expect(dlg.querySelector('video')!.getAttribute('src')).toBe('http://s3/c.mp4?sig');
    expect(calls.some((c) => c.url.includes('kind=clip') && c.url.includes('size=20'))).toBe(true);
  });
});
