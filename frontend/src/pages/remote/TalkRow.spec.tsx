import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuth } from '../../stores/auth';
import { useTalkEvents } from '../../stores/talk';
import { useToast } from '../../stores/toast';
import { TalkRow } from './TalkRow';
import { talkMode } from './useIntercom';

/** 麥克風、WebRTC、MediaRecorder 替身 */
class Track {
  stopped = false;
  kind = 'audio';
  stop() {
    this.stopped = true;
  }
}
let track: Track;
class FakePC {
  static last: FakePC;
  connectionState = 'new';
  iceGatheringState = 'complete';
  localDescription: { sdp: string } | null = null;
  remote: { sdp: string } | null = null;
  onconnectionstatechange: (() => void) | null = null;
  added: { dir: string }[] = [];
  closed = false;
  constructor() {
    FakePC.last = this;
  }
  addTransceiver(_t: unknown, init: { direction: string }) {
    this.added.push({ dir: init.direction });
  }
  async createOffer() {
    return { type: 'offer', sdp: 'v=0 mic' };
  }
  async setLocalDescription(d: { sdp: string }) {
    this.localDescription = d;
  }
  async setRemoteDescription(d: { sdp: string }) {
    this.remote = d;
    // MediaMTX 回答後 ICE 連上
    setTimeout(() => {
      this.connectionState = 'connected';
      this.onconnectionstatechange?.();
    }, 0);
  }
  addEventListener() {}
  close() {
    this.closed = true;
  }
}
class FakeRecorder {
  static isTypeSupported = (m: string) => m === 'audio/webm;codecs=opus';
  state = 'inactive';
  mimeType = 'audio/webm;codecs=opus';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: ((e: Event) => void) | null = null;
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['opus'], { type: this.mimeType }) });
    void this.onstop?.(new Event('stop'));
  }
}

let calls: { url: string; method: string; body?: unknown }[];
let getUserMedia: ReturnType<typeof vi.fn>;
beforeEach(() => {
  calls = [];
  track = new Track();
  getUserMedia = vi.fn(async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }));
  vi.stubGlobal('navigator', { ...navigator, mediaDevices: { getUserMedia } });
  vi.stubGlobal('RTCPeerConnection', FakePC);
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body });
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
      if (url.endsWith('/talk') && init?.method === 'POST') return json({ whipUrl: 'http://mtx:8889/talk/B2-001/whip', token: 'pub-tok' });
      if (url.includes('/whip')) return new Response('v=0 answer', { status: 201, headers: { Location: '/talk/B2-001/whip/sess-9' } });
      if (url.endsWith('/talk/started')) return json({ cmdId: 'c_1' });
      if (url.endsWith('/talk') && init?.method === 'DELETE') return new Response(null, { status: 204 });
      if (url.endsWith('/speak-audio')) return json({ cmdId: 'c_2' }, 202);
      return json({});
    }),
  );
  useToast.setState({ toasts: [] });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const toasts = () => useToast.getState().toasts.map((x) => x.text);

describe('對講方式依能力（T-31）', () => {
  it('talk_live → 即時；只有 talk → 按鍵說話；都沒有 → 不顯示', () => {
    expect(talkMode(['ptz', 'talk_live', 'talk'])).toBe('live');
    expect(talkMode(['talk'])).toBe('ptt');
    expect(talkMode(['ptz'])).toBeNull();
    const { container } = render(<TalkRow robotId="r1" caps={['ptz']} online onLive={() => {}} />);
    expect(container.textContent).toBe('');
  });
});

describe('方案 A 即時對講', () => {
  it('對講：開麥克風（回音消除）→ 取推流憑證 → WHIP 推流 → 連上才通知後端；掛斷關麥克風、結束 WHIP、通知後端', async () => {
    const onLive = vi.fn();
    render(<TalkRow robotId="r1" caps={['talk_live']} online onLive={onLive} />);
    fireEvent.click(screen.getByRole('button', { name: '對講' }));
    await screen.findByRole('button', { name: '掛斷' });
    expect(getUserMedia).toHaveBeenCalledWith(expect.objectContaining({ audio: expect.objectContaining({ echoCancellation: true }), video: false }));
    const whip = calls.find((c) => c.url.includes('/whip'))!;
    expect(whip.url).toBe('http://mtx:8889/talk/B2-001/whip?token=pub-tok');
    expect(whip.body).toBe('v=0 mic');
    expect(FakePC.last.added).toEqual([{ dir: 'sendonly' }]);
    const order = calls.map((c) => `${c.method} ${c.url.replace('http://mtx:8889', '')}`);
    expect(order.indexOf('POST /api/v1/robots/r1/talk/started')).toBeGreaterThan(order.indexOf('POST /talk/B2-001/whip?token=pub-tok'));
    expect(screen.getByText(/雙向對講中 00:0\d/)).toBeTruthy();
    expect(onLive).toHaveBeenLastCalledWith(true);

    fireEvent.click(screen.getByRole('button', { name: '掛斷' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/v1/robots/r1/talk')).toBe(true));
    expect(calls.some((c) => c.method === 'DELETE' && c.url === 'http://mtx:8889/talk/B2-001/whip/sess-9')).toBe(true);
    expect(track.stopped).toBe(true);
    expect(FakePC.last.closed).toBe(true);
    expect(onLive).toHaveBeenLastCalledWith(false);
  });

  it('瀏覽器不給麥克風：提示，不打後端', async () => {
    getUserMedia.mockRejectedValueOnce(new DOMException('no', 'NotAllowedError'));
    render(<TalkRow robotId="r1" caps={['talk_live']} online onLive={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '對講' }));
    await waitFor(() => expect(toasts()).toContain('瀏覽器沒有允許使用麥克風，請在網址列左側允許後再試'));
    expect(calls).toEqual([]); // 沒有麥克風就不向後端取憑證
  });

  it('後端通知機器人端已斷線（talk.ended）：結束、提示，不再通知後端（PR #15 審查第 3 點）', async () => {
    const onLive = vi.fn();
    render(<TalkRow robotId="r1" caps={['talk_live']} online onLive={onLive} />);
    fireEvent.click(screen.getByRole('button', { name: '對講' }));
    await screen.findByRole('button', { name: '掛斷' });
    act(() => useTalkEvents.getState().setEnded({ robotId: 'r1', code: 'B2-001', reason: 'robot_failed', detail: '401' }));
    await screen.findByRole('button', { name: '對講' });
    await waitFor(() => expect(toasts()).toContain('機器人端已斷線，對講已結束'));
    expect(track.stopped).toBe(true);
    expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/v1/robots/r1/talk')).toBe(false);
    expect(onLive).toHaveBeenLastCalledWith(false);
  });

  it('系統管理員結束：提示是誰結束的；別台的通知不影響', async () => {
    render(<TalkRow robotId="r1" caps={['talk_live']} online onLive={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '對講' }));
    await screen.findByRole('button', { name: '掛斷' });
    act(() => useTalkEvents.getState().setEnded({ robotId: 'r9', code: 'B2-009', reason: 'stopped', by: 'admin' }));
    expect(screen.getByRole('button', { name: '掛斷' })).toBeTruthy();
    act(() => useTalkEvents.getState().setEnded({ robotId: 'r1', code: 'B2-001', reason: 'stopped', by: '值班主管' }));
    await waitFor(() => expect(toasts()).toContain('對講已被 值班主管 結束'));
  });

  it('本人在別的視窗結束：提示「已在其他視窗結束」，不再通知後端', async () => {
    useAuth.setState({ user: { id: 'u-me', username: 'me', displayName: '我', role: { id: 'r', name: '警衛' } } });
    render(<TalkRow robotId="r1" caps={['talk_live']} online onLive={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '對講' }));
    await screen.findByRole('button', { name: '掛斷' });
    act(() => useTalkEvents.getState().setEnded({ robotId: 'r1', code: 'B2-001', reason: 'stopped', by: '我', byUserId: 'u-me' }));
    await waitFor(() => expect(toasts()).toContain('對講已在其他視窗結束'));
    expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/v1/robots/r1/talk')).toBe(false);
    useAuth.setState({ user: null });
  });

  it('離開頁面（卸載）時掛斷', async () => {
    const view = render(<TalkRow robotId="r1" caps={['talk_live']} online onLive={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '對講' }));
    await screen.findByRole('button', { name: '掛斷' });
    view.unmount();
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/v1/robots/r1/talk')).toBe(true));
    expect(track.stopped).toBe(true);
  });
});

describe('方案 B 按鍵說話', () => {
  it('按住錄音、放開送出（音檔＋長度）；太短不送', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<TalkRow robotId="r1" caps={['talk']} online onLive={() => {}} />);
    const btn = screen.getByRole('button', { name: '按住說話' });
    fireEvent.pointerDown(btn);
    await screen.findByRole('button', { name: '放開送出' });
    act(() => vi.advanceTimersByTime(2_000));
    fireEvent.pointerUp(screen.getByRole('button', { name: '放開送出' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/speak-audio'))).toBe(true));
    const body = calls.find((c) => c.url.endsWith('/speak-audio'))!.body as FormData;
    expect((body.get('file') as File).type).toBe('audio/webm;codecs=opus');
    expect(Number(body.get('durationMs'))).toBeGreaterThanOrEqual(2000);
    await waitFor(() => expect(toasts().some((x) => x.startsWith('已送出'))).toBe(true));
    expect(track.stopped).toBe(true);

    fireEvent.pointerDown(screen.getByRole('button', { name: '按住說話' }));
    await screen.findByRole('button', { name: '放開送出' });
    fireEvent.pointerUp(screen.getByRole('button', { name: '放開送出' }));
    await waitFor(() => expect(toasts()).toContain('錄音太短，請按住說話後再放開'));
    expect(calls.filter((c) => c.url.endsWith('/speak-audio'))).toHaveLength(1);
    vi.useRealTimers();
  });

  it('最長 30 秒自動送出', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<TalkRow robotId="r1" caps={['talk']} online onLive={() => {}} />);
    fireEvent.pointerDown(screen.getByRole('button', { name: '按住說話' }));
    await screen.findByRole('button', { name: '放開送出' });
    act(() => vi.advanceTimersByTime(30_100));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/speak-audio'))).toBe(true));
    expect(Number((calls.find((c) => c.url.endsWith('/speak-audio'))!.body as FormData).get('durationMs'))).toBe(30_000);
    vi.useRealTimers();
  });

  it('離線時不能按', () => {
    render(<TalkRow robotId="r1" caps={['talk']} online={false} onLive={() => {}} />);
    expect((screen.getByRole('button', { name: '按住說話' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
