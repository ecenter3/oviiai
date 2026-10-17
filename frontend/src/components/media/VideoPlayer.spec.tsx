import { act, cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuth } from '../../stores/auth';
import { useMedia } from '../../stores/media';
import { MediaControls } from './MediaControls';
import { VideoPlayer } from './VideoPlayer';

/** 最小的 RTCPeerConnection 替身：記下 SDP，連線狀態由測試控制 */
class FakePC {
  static last: FakePC;
  connectionState = 'new';
  iceGatheringState = 'complete';
  localDescription: { sdp: string } | null = null;
  remote: { type: string; sdp: string } | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ontrack: ((e: unknown) => void) | null = null;
  closed = false;
  transceivers: string[] = [];
  constructor() {
    FakePC.last = this;
  }
  addTransceiver(kind: string) {
    this.transceivers.push(kind);
  }
  async createOffer() {
    return { type: 'offer', sdp: 'v=0 offer' };
  }
  async setLocalDescription(d: { sdp: string }) {
    this.localDescription = d;
  }
  async setRemoteDescription(d: { type: string; sdp: string }) {
    this.remote = d;
  }
  addEventListener() {}
  close() {
    this.closed = true;
  }
  setState(s: string) {
    this.connectionState = s;
    this.onconnectionstatechange?.();
  }
}

let calls: { url: string; method: string; headers?: HeadersInit; body?: unknown }[];
function stubFetch(token: (url: string) => Response) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET', headers: init?.headers, body: init?.body });
      if (url.includes('/token')) return token(url);
      if (url.includes('/whep')) return new Response('v=0 answer', { status: 201, headers: { Location: '/cam/CAM-1/whep/sess-1' } });
      if (url.includes('/media/snapshot')) return new Response(JSON.stringify({ id: 'm1' }));
      if (url.includes('/media/recordings')) return new Response(JSON.stringify({ id: 'r1', durationS: 4 }));
      return new Response('{}');
    }),
  );
}

beforeEach(() => vi.stubGlobal('RTCPeerConnection', FakePC));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('VideoPlayer（T-29）', () => {
  it('取播放憑證 → WHEP（SDP、帶憑證）→ 連上顯示播放中；卸載時結束 WHEP 工作階段', async () => {
    stubFetch(() => new Response(JSON.stringify({ token: 'tok-1', whepUrl: 'http://mtx:8889/cam/CAM-1/whep' })));
    const { unmount, container } = render(<VideoPlayer streamKey="cam/CAM-1" label="1F 大門" />);
    expect(screen.getByText('連線中…')).toBeTruthy();
    await waitFor(() => expect(FakePC.last?.remote?.sdp).toBe('v=0 answer'));
    expect(calls[0].url).toBe('/api/v1/streams/cam%2FCAM-1/token');
    const whep = calls.find((c) => c.url.includes('/whep'))!;
    expect(whep.url).toBe('http://mtx:8889/cam/CAM-1/whep?token=tok-1');
    expect(new Headers(whep.headers).get('Content-Type')).toBe('application/sdp');
    expect(whep.body).toBe('v=0 offer');
    expect(FakePC.last.transceivers).toEqual(['video', 'audio']);
    act(() => FakePC.last.setState('connected'));
    expect(container.querySelector('.vplayer.playing')).toBeTruthy();
    unmount();
    expect(calls.some((c) => c.method === 'DELETE' && c.url === 'http://mtx:8889/cam/CAM-1/whep/sess-1')).toBe(true);
  });

  it('沒有影像來源（404）：顯示訊息、不重連', async () => {
    stubFetch(() => new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'x' } }), { status: 404 }));
    render(<VideoPlayer streamKey="robot/B2-001/front" label="B2-001 前鏡頭" />);
    expect(await screen.findByText('沒有影像來源')).toBeTruthy();
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.filter((c) => c.url.includes('/token'))).toHaveLength(1);
  });

  it('斷線：每 3 秒重連，重連時重新取憑證', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubFetch(() => new Response(JSON.stringify({ token: 'tok', whepUrl: 'http://mtx:8889/cam/CAM-1/whep' })));
    render(<VideoPlayer streamKey="cam/CAM-1" label="1F 大門" />);
    await waitFor(() => expect(FakePC.last?.remote).toBeTruthy());
    const first = FakePC.last;
    act(() => first.setState('failed'));
    expect(first.closed).toBe(true);
    expect(screen.getByText('影像中斷，重新連線（第 1 次）…')).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });
    await waitFor(() => expect(calls.filter((c) => c.url.includes('/token'))).toHaveLength(2));
  });
});

describe('抓拍、錄影按鈕（T-28）', () => {
  it('有 op.remote 才顯示；抓拍送 streamKey；錄影中顯示停止與計時', async () => {
    stubFetch(() => new Response('{}'));
    useAuth.setState({ status: 'authed', perms: ['monitor', 'op.remote'], user: null });
    useMedia.setState({ recordings: [] });
    const { rerender } = render(<MediaControls streamKey="cam/CAM-1" name="1F 大門" />);
    fireEvent.click(screen.getByRole('button', { name: '抓拍' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/media/snapshot'))).toBe(true));
    expect(JSON.parse(String(calls.find((c) => c.url.endsWith('/media/snapshot'))!.body))).toEqual({ streamKey: 'cam/CAM-1' });
    fireEvent.click(screen.getByRole('button', { name: '錄影' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/media/recordings') && c.method === 'POST')).toBe(true));

    act(() => useMedia.setState({ recordings: [{ id: 'r1', streamKey: 'cam/CAM-1', name: '1F 大門', startedAt: new Date(Date.now() - 65_000).toISOString(), maxSec: 600, userId: 'u' }] }));
    rerender(<MediaControls streamKey="cam/CAM-1" name="1F 大門" />);
    const stop = screen.getByRole('button', { name: /停止/ });
    expect(stop.textContent).toMatch(/01:0[4-7]/);
    fireEvent.click(stop);
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/media/recordings/r1/stop'))).toBe(true));

    cleanup();
    useAuth.setState({ status: 'authed', perms: ['monitor'], user: null });
    render(<MediaControls streamKey="cam/CAM-1" name="1F 大門" />);
    expect(screen.queryByRole('button', { name: '抓拍' })).toBeNull();
  });
});
