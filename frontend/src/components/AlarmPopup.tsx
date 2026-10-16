import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatTime, t, type MessageKey } from '../i18n';
import { AlarmDialog } from '../pages/alarms/AlarmDialog';
import { audioReady, playAlarm } from '../realtime/sound';
import { useAlarms } from '../stores/alarms';
import { useAuth } from '../stores/auth';

/** 一級告警彈窗開著時重複響鈴的間隔 */
const RING_MS = 5_000;

/**
 * 告警彈窗（系統規格書 §6：一級 全螢幕彈窗＋響鈴；原型 notifyAlarm .alarm-pop）。
 * 依告警設置的「彈窗提醒」顯示，一次一則；一級告警在處理或按「稍後處理」前每 5 秒再響一次。
 * 「處理」跳到告警頁開啟處理視窗；沒有告警頁權限就在原地開。
 */
export function AlarmPopup() {
  const popups = useAlarms((s) => s.popups);
  const dismiss = useAlarms((s) => s.dismissPopup);
  const can = useAuth((s) => s.can);
  const navigate = useNavigate();
  const [inline, setInline] = useState<string | null>(null);
  const handleBtn = useRef<HTMLButtonElement>(null);
  const a = popups[0];

  useEffect(() => {
    if (!a) return;
    handleBtn.current?.focus();
    if (a.level !== 1) return;
    const id = setInterval(() => playAlarm(1), RING_MS);
    return () => clearInterval(id);
  }, [a]);

  if (inline) return <AlarmDialog id={inline} onClose={() => setInline(null)} />;
  if (!a) return null;

  function handle() {
    dismiss(a.id);
    const page = a.category === 'system' ? 'sysalarm' : 'bizalarm';
    if (can(page)) navigate(`/alarms/${a.category}?id=${a.id}`);
    else setInline(a.id);
  }

  return (
    <div className="modal-bg alarm-pop-bg">
      <div className="modal alarm-pop" role="alertdialog" aria-modal="true" aria-label={t(`alarm.level.${a.level}` as MessageKey)}>
        <div className="modal-h">
          <span>{t(`alarm.level.${a.level}` as MessageKey)}</span>
          <span className="mono">{a.code}</span>
        </div>
        <p className="ap-name">{a.name}</p>
        <p className="ap-msg">{a.message}</p>
        <p className="hint">
          {formatTime(a.occurredAt)}
          {a.robotCode ? ` · ${a.robotCode}` : ''}
          {popups.length > 1 ? ` · ${t('alarm.popup.more', { n: popups.length - 1 })}` : ''}
        </p>
        {!audioReady() && <p className="hint">{t('alarm.popup.soundHint')}</p>}
        <div className="row">
          <button type="button" className="btn" onClick={() => dismiss(a.id)}>
            {t('alarm.popup.later')}
          </button>
          <button ref={handleBtn} type="button" className="btn danger solid" onClick={handle}>
            {t('alarm.popup.handle')}
          </button>
        </div>
      </div>
    </div>
  );
}
