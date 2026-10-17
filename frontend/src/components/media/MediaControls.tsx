import { useEffect, useState } from 'react';
import { api, ApiError } from '../../api/client';
import { t } from '../../i18n';
import { type MediaItem, useMedia } from '../../stores/media';
import { useToast } from '../../stores/toast';
import { PermGate } from '../PermGate';

/** 影像上的抓拍、錄影按鈕（T-28；需要 op.remote） */
export function MediaControls({ streamKey, name }: { streamKey: string; name: string }) {
  const rec = useMedia((s) => s.recordings.find((r) => r.streamKey === streamKey));
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const toast = useToast.getState().show;

  useEffect(() => {
    if (!rec) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [rec]);

  async function run<T>(fn: () => Promise<T>, ok: (r: T) => string) {
    setBusy(true);
    try {
      toast(ok(await fn()), 'ok');
    } catch (e) {
      toast(e instanceof ApiError ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  const secs = rec ? Math.max(0, Math.floor((now - Date.parse(rec.startedAt)) / 1000)) : 0;
  return (
    <PermGate perms={['op.remote']}>
      <button
        type="button"
        className="vbtn"
        disabled={busy}
        onClick={() => void run(() => api<MediaItem>('/media/snapshot', { method: 'POST', json: { streamKey } }), () => t('media.snap.ok', { name }))}
      >
        {t('media.snap')}
      </button>
      {rec ? (
        <button
          type="button"
          className="vbtn rec"
          disabled={busy}
          onClick={() => void run(() => api<MediaItem>(`/media/recordings/${rec.id}/stop`, { method: 'POST' }), (r) => t('media.rec.saved', { name, s: r.durationS ?? 0 }))}
        >
          ● {t('media.rec.stop')} {`${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`}
        </button>
      ) : (
        <button type="button" className="vbtn" disabled={busy} onClick={() => void run(() => api('/media/recordings', { method: 'POST', json: { streamKey } }), () => t('media.rec.started', { name }))}>
          {t('media.rec.start')}
        </button>
      )}
    </PermGate>
  );
}
