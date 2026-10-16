import { t, type MessageKey } from '../i18n';
import type { AlarmStatus } from '../stores/alarms';

/** 告警等級標籤（前端頁面 §2 LevelTag；原型 .lvl：一級紅、二級黃、三級綠） */
export function LevelTag({ level }: { level: 1 | 2 | 3 }) {
  return (
    <span className={`lvl l${level}`}>
      <i aria-hidden="true" />
      {t(`alarm.level.${level}` as MessageKey)}
    </span>
  );
}

const ST_CLASS: Record<AlarmStatus, string> = {
  review: 'st-review',
  open: 'st-open',
  handling: 'st-doing',
  reported: 'st-up',
  closed: 'st-done',
  false_alarm: 'st-false',
  info: 'st-false',
};

const PILL_CLASS: Record<AlarmStatus, string> = {
  review: 's-review',
  open: 's-open',
  handling: 's-doing',
  reported: 's-up',
  closed: 's-closed',
  false_alarm: 's-false',
  info: 's-false',
};

/** 處理狀態（前端頁面 §2 StatusTag）；pill 為監控頁告警日誌的膠囊樣式 */
export function StatusTag({ status, pill }: { status: AlarmStatus; pill?: boolean }) {
  return <span className={pill ? `pill ${PILL_CLASS[status]}` : ST_CLASS[status]}>{t(`alarm.status.${status}` as MessageKey)}</span>;
}
