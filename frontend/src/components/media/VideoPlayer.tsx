import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../api/client';
import { t } from '../../i18n';

type Status = 'connecting' | 'playing' | 'retrying' | 'nosource' | 'limit';

/** 同一個瀏覽器同時播放的上限（影像與整合 §1：16 路） */
export const MAX_STREAMS = 16;
let playing = 0;
const RETRY_MS = 3_000;

/**
 * 影像播放（工程開發手冊「影像與整合」§1、前端 VideoPlayer）：
 * 先向後端取 60 秒播放憑證，再以 WHEP 向 MediaMTX 建立 WebRTC 連線；斷線每 3 秒重連（重連時重新取憑證）。
 * 不轉碼、延遲 1 秒內。沒有影像來源（404）時不重連。
 */
export function VideoPlayer({ streamKey, label, className, children }: { streamKey: string; label: string; className?: string; children?: React.ReactNode }) {
  const video = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState<Status>('connecting');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (playing >= MAX_STREAMS) {
      setStatus('limit');
      return;
    }
    playing++;
    let stopped = false;
    let pc: RTCPeerConnection | null = null;
    let session: string | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      pc?.close();
      pc = null;
      if (session) void fetch(session, { method: 'DELETE' }).catch(() => undefined);
      session = null;
    };
    const again = () => {
      cleanup();
      if (stopped) return;
      setStatus('retrying');
      setAttempt((n) => n + 1);
      retry = setTimeout(() => void connect(), RETRY_MS);
    };

    async function connect() {
      if (stopped) return;
      try {
        const tok = await api<{ token: string; whepUrl: string }>(`/streams/${encodeURIComponent(streamKey)}/token`);
        if (stopped) return;
        pc = new RTCPeerConnection();
        pc.addTransceiver('video', { direction: 'recvonly' });
        pc.addTransceiver('audio', { direction: 'recvonly' });
        pc.ontrack = (e) => {
          if (video.current && e.streams[0] && video.current.srcObject !== e.streams[0]) video.current.srcObject = e.streams[0];
        };
        pc.onconnectionstatechange = () => {
          const s = pc?.connectionState;
          if (s === 'connected') setStatus('playing');
          else if (s === 'failed' || s === 'disconnected' || s === 'closed') again();
        };
        await pc.setLocalDescription(await pc.createOffer());
        await iceGathered(pc);
        const res = await fetch(`${tok.whepUrl}?token=${encodeURIComponent(tok.token)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/sdp' },
          body: pc.localDescription!.sdp,
        });
        if (!res.ok) throw new Error(`WHEP ${res.status}`);
        const loc = res.headers.get('Location');
        session = loc ? new URL(loc, tok.whepUrl).toString() : null;
        await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() });
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) {
          cleanup();
          setStatus('nosource');
          return;
        }
        again();
      }
    }

    setStatus('connecting');
    void connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      cleanup();
      playing--;
    };
  }, [streamKey]);

  const text: Record<Status, string> = {
    connecting: t('video.connecting'),
    playing: '',
    retrying: t('video.retrying', { n: attempt }),
    nosource: t('video.nosource'),
    limit: t('video.limit', { n: MAX_STREAMS }),
  };
  return (
    <div className={`vplayer ${status} ${className ?? ''}`} data-stream={streamKey}>
      <video ref={video} autoPlay muted playsInline aria-label={label} />
      {status !== 'playing' && <div className="vstatus">{text[status]}</div>}
      <div className="vlabel">{label}</div>
      {children && <div className="vtools">{children}</div>}
    </div>
  );
}

/** 等 ICE 候選收集完（最多 2 秒）：MediaMTX 收到完整 SDP 就不需要再補候選 */
function iceGathered(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, 2_000);
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(t);
        resolve();
      }
    });
  });
}
