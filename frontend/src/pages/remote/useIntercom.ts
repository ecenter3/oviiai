import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../api/client';
import { iceGathered } from '../../components/media/VideoPlayer';
import { t } from '../../i18n';

/** 對講顯示哪一種（依機器人能力；不做品牌判斷）：live 即時（方案 A）、ptt 按鍵說話（方案 B） */
export function talkMode(caps: readonly string[]): 'live' | 'ptt' | null {
  if (caps.includes('talk_live')) return 'live';
  if (caps.includes('talk')) return 'ptt';
  return null;
}

/** 麥克風：開回音消除、降噪（控制室多半用電腦喇叭聽現場聲音） */
const MIC: MediaStreamConstraints = { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false };

function micError(e: unknown): string {
  const name = e instanceof DOMException ? e.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return t('talk.err.denied');
  if (name === 'NotFoundError') return t('talk.err.nomic');
  return e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e);
}

export type LiveState = { s: 'idle' } | { s: 'connecting' } | { s: 'live'; since: number } | { s: 'error'; message: string };

/**
 * 方案 A 即時對講（影像與整合 §2）：麥克風以 WHIP 推到 MediaMTX 的 talk/{代碼}；
 * 推上來後通知後端叫轉接器拉流送到機器人喇叭。現場聲音從影像串流聽（對講時取消靜音）。
 * 掛斷、離開頁面、換機器人、連線失敗都會結束（關麥克風、結束 WHIP、通知後端）。
 */
export function useLiveTalk(robotId: string | null) {
  const [state, setState] = useState<LiveState>({ s: 'idle' });
  const res = useRef<{ pc: RTCPeerConnection; stream: MediaStream; session: string | null; robotId: string } | null>(null);

  const teardown = useCallback(async (notify: boolean) => {
    const r = res.current;
    res.current = null;
    if (!r) return;
    r.stream.getTracks().forEach((tr) => tr.stop());
    r.pc.close();
    if (r.session) void fetch(r.session, { method: 'DELETE' }).catch(() => undefined);
    if (notify) await api(`/robots/${r.robotId}/talk`, { method: 'DELETE' }).catch(() => undefined);
  }, []);

  const stop = useCallback(async () => {
    await teardown(true);
    setState({ s: 'idle' });
  }, [teardown]);

  const start = useCallback(async () => {
    if (!robotId || res.current) return;
    setState({ s: 'connecting' });
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia(MIC);
      const tok = await api<{ whipUrl: string; token: string }>(`/robots/${robotId}/talk`, { method: 'POST' });
      const pc = new RTCPeerConnection();
      res.current = { pc, stream, session: null, robotId };
      for (const tr of stream.getAudioTracks()) pc.addTransceiver(tr, { direction: 'sendonly', streams: [stream] });
      const connected = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(t('talk.err.timeout'))), 10_000);
        pc.onconnectionstatechange = () => {
          if (pc.connectionState === 'connected') {
            clearTimeout(timer);
            resolve();
          } else if (pc.connectionState === 'failed') {
            clearTimeout(timer);
            reject(new Error(t('talk.err.failed')));
          }
        };
      });
      await pc.setLocalDescription(await pc.createOffer());
      await iceGathered(pc);
      const r = await fetch(`${tok.whipUrl}?token=${encodeURIComponent(tok.token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp' },
        body: pc.localDescription!.sdp,
      });
      if (!r.ok) throw new Error(r.status === 400 || r.status === 409 ? t('talk.err.busy') : `WHIP ${r.status}`);
      const loc = r.headers.get('Location');
      res.current.session = loc ? new URL(loc, tok.whipUrl).toString() : null;
      await pc.setRemoteDescription({ type: 'answer', sdp: await r.text() });
      await connected;
      await api(`/robots/${robotId}/talk/started`, { method: 'POST' });
      // 通話中斷線：結束並提示
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
          void teardown(true).then(() => setState({ s: 'error', message: t('talk.err.dropped') }));
        }
      };
      setState({ s: 'live', since: Date.now() });
    } catch (e) {
      if (!res.current) stream?.getTracks().forEach((tr) => tr.stop());
      await teardown(true);
      setState({ s: 'error', message: micError(e) });
    }
  }, [robotId, teardown]);

  // 換機器人、離開頁面：掛斷
  useEffect(() => {
    return () => {
      void teardown(true);
      setState({ s: 'idle' });
    };
  }, [robotId, teardown]);

  return { state, start, stop };
}

export const PTT_MAX_MS = 30_000;
const PTT_MIN_MS = 400;
const MIME = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];

export type PttState = { s: 'idle' } | { s: 'recording'; since: number } | { s: 'sending' };

/**
 * 方案 B 按鍵說話：按住錄音、放開送出（speak 指令帶音檔），最長 30 秒自動送出；太短（< 0.4 秒）不送。
 * 回傳 onResult 給呼叫端顯示結果。
 */
export function usePushToTalk(robotId: string | null, onResult: (r: { ok: boolean; message: string }) => void) {
  const [state, setState] = useState<PttState>({ s: 'idle' });
  const rec = useRef<{ mr: MediaRecorder; stream: MediaStream; since: number; chunks: Blob[]; timer: ReturnType<typeof setTimeout> } | null>(null);
  const cb = useRef(onResult);
  cb.current = onResult;
  const pressed = useRef(false);

  const finish = useCallback(
    (send: boolean) => {
      const r = rec.current;
      if (!r) return;
      rec.current = null;
      clearTimeout(r.timer);
      const durationMs = Date.now() - r.since;
      r.mr.onstop = async () => {
        r.stream.getTracks().forEach((tr) => tr.stop());
        if (!send || !robotId) return setState({ s: 'idle' });
        if (durationMs < PTT_MIN_MS) {
          setState({ s: 'idle' });
          return cb.current({ ok: false, message: t('talk.ptt.short') });
        }
        setState({ s: 'sending' });
        const blob = new Blob(r.chunks, { type: r.mr.mimeType || 'audio/webm' });
        const body = new FormData();
        body.append('file', blob, `speak.${blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm'}`);
        body.append('durationMs', String(Math.min(durationMs, PTT_MAX_MS)));
        try {
          await api(`/robots/${robotId}/speak-audio`, { method: 'POST', body });
          cb.current({ ok: true, message: t('talk.ptt.sent', { s: (durationMs / 1000).toFixed(1) }) });
        } catch (e) {
          cb.current({ ok: false, message: e instanceof ApiError ? e.message : String(e) });
        } finally {
          setState({ s: 'idle' });
        }
      };
      if (r.mr.state !== 'inactive') r.mr.stop();
      else void r.mr.onstop?.(new Event('stop'));
    },
    [robotId],
  );

  const press = useCallback(async () => {
    if (!robotId || rec.current || state.s === 'sending') return;
    pressed.current = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia(MIC);
      // 取得麥克風的期間已經放開：不錄
      if (!pressed.current) return stream.getTracks().forEach((tr) => tr.stop());
      const mimeType = MIME.find((m) => typeof MediaRecorder.isTypeSupported !== 'function' || MediaRecorder.isTypeSupported(m));
      const mr = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 32_000 } : undefined);
      const chunks: Blob[] = [];
      mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      const since = Date.now();
      rec.current = { mr, stream, since, chunks, timer: setTimeout(() => finish(true), PTT_MAX_MS) };
      mr.start(250);
      setState({ s: 'recording', since });
    } catch (e) {
      cb.current({ ok: false, message: micError(e) });
    }
  }, [robotId, state.s, finish]);

  const release = useCallback(() => {
    pressed.current = false;
    finish(true);
  }, [finish]);

  useEffect(() => () => finish(false), [robotId, finish]);

  return { state, press, release };
}
