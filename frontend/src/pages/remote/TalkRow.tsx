import { useEffect, useState } from 'react';
import { t } from '../../i18n';
import { useToast } from '../../stores/toast';
import { PTT_MAX_MS, talkMode, useLiveTalk, usePushToTalk } from './useIntercom';

const mmss = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

const MIC_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </svg>
);

/** 每秒更新一次（顯示通話、錄音時間） */
function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/**
 * 遠端對講（原型「遠端對講」列；T-31）。依機器人能力：talk_live → 即時對講（對講／掛斷），
 * 只有 talk → 按住說話；兩者都沒有不顯示。
 */
export function TalkRow({ robotId, caps, online, onLive }: { robotId: string; caps: string[]; online: boolean; onLive(live: boolean): void }) {
  const mode = talkMode(caps);
  if (!mode) return null;
  return mode === 'live' ? <LiveRow robotId={robotId} online={online} onLive={onLive} /> : <PttRow robotId={robotId} online={online} />;
}

function LiveRow({ robotId, online, onLive }: { robotId: string; online: boolean; onLive(live: boolean): void }) {
  const talk = useLiveTalk(robotId);
  const live = talk.state.s === 'live';
  const now = useNow(live);
  useEffect(() => onLive(live), [live, onLive]);
  useEffect(() => () => onLive(false), [onLive]);
  useEffect(() => {
    if (talk.state.s === 'error') useToast.getState().show(talk.state.message, 'error');
  }, [talk.state]);
  const info =
    talk.state.s === 'live'
      ? t('talk.live.on', { t: mmss(now - talk.state.since) })
      : talk.state.s === 'connecting'
        ? t('talk.live.connecting')
        : t('talk.live.hint');
  return (
    <div className="arow">
      <span className="ai">{MIC_ICON}</span>
      <span className="al">
        {t('remote.act.talk')}
        <small aria-live="polite">{info}</small>
      </span>
      <button
        type="button"
        className={`abtn${live ? ' active' : ''}`}
        disabled={(!online && !live) || talk.state.s === 'connecting'}
        onClick={() => void (live ? talk.stop() : talk.start())}
      >
        {live ? t('talk.hangup') : t('talk.call')}
      </button>
    </div>
  );
}

function PttRow({ robotId, online }: { robotId: string; online: boolean }) {
  const ptt = usePushToTalk(robotId, (r) => useToast.getState().show(r.message, r.ok ? 'ok' : 'error'));
  const rec = ptt.state.s === 'recording';
  const now = useNow(rec);
  const info = ptt.state.s === 'recording' ? t('talk.ptt.recording', { t: mmss(now - ptt.state.since), max: PTT_MAX_MS / 1000 }) : ptt.state.s === 'sending' ? t('talk.ptt.sending') : t('talk.ptt.hint');
  return (
    <div className="arow">
      <span className="ai">{MIC_ICON}</span>
      <span className="al">
        {t('remote.act.talk')}
        <small aria-live="polite">{info}</small>
      </span>
      <button
        type="button"
        className={`abtn ptt${rec ? ' active' : ''}`}
        disabled={!online || ptt.state.s === 'sending'}
        aria-pressed={rec}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture?.(e.pointerId);
          void ptt.press();
        }}
        onPointerUp={ptt.release}
        onPointerCancel={ptt.release}
        onKeyDown={(e) => {
          if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
            e.preventDefault();
            void ptt.press();
          }
        }}
        onKeyUp={(e) => (e.key === ' ' || e.key === 'Enter') && ptt.release()}
        onContextMenu={(e) => e.preventDefault()}
      >
        {rec ? t('talk.ptt.release') : t('talk.ptt.hold')}
      </button>
    </div>
  );
}
