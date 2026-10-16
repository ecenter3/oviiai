import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api/client';
import { StatusTag } from '../../components/AlarmTags';
import { t } from '../../i18n';
import { type Alarm, useAlarms } from '../../stores/alarms';
import { useAuth } from '../../stores/auth';
import { AlarmDialog } from '../alarms/AlarmDialog';

const LEVEL_CLASS = { 1: 'P1', 2: 'P2', 3: 'P3' } as const;
const hhmm = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false });

/**
 * 實時監控下方「告警日誌（最後 20 條）」（原型 drawAlerts）：最新在上，WebSocket alarm.new 即時加入。
 * 點告警跳到告警頁處理（沒有告警頁權限就在原地開處理視窗）。
 */
export function AlertLog() {
  const q = useQuery({ queryKey: ['alarms', 'recent'], queryFn: () => api<{ items: Alarm[] }>('/alarms?size=20') });
  const recent = useAlarms((s) => s.recent);
  const setRecent = useAlarms((s) => s.setRecent);
  const can = useAuth((s) => s.can);
  const navigate = useNavigate();
  const [fresh, setFresh] = useState<string | null>(null);
  const [inline, setInline] = useState<string | null>(null);

  useEffect(() => {
    if (q.data) setRecent(q.data.items);
  }, [q.data, setRecent]);

  // 新進的那一則閃一下
  const top = recent[0]?.id;
  useEffect(() => {
    if (!top || !q.data || q.data.items[0]?.id === top) return;
    setFresh(top);
    const id = setTimeout(() => setFresh(null), 1_200);
    return () => clearTimeout(id);
  }, [top, q.data]);

  const open = recent.filter((a) => a.status === 'open' || a.status === 'handling').length;
  const review = recent.filter((a) => a.status === 'review').length;

  function go(a: Alarm) {
    const page = a.category === 'system' ? 'sysalarm' : 'bizalarm';
    if (can(page)) navigate(`/alarms/${a.category}?id=${a.id}`);
    else setInline(a.id);
  }

  return (
    <section className="panel alerts" aria-label={t('monitor.alerts')}>
      <div className="panel-head">
        {t('monitor.alerts')}
        <span className="meta">{t('monitor.alerts.meta', { open, review })}</span>
      </div>
      <div className="scroll">
        {recent.length === 0 ? (
          <div className="empty">{t('monitor.alerts.empty')}</div>
        ) : (
          <div className="alert-list">
            {recent.map((a) => (
              <button
                key={a.id}
                type="button"
                data-alarm={a.code}
                className={`alert ${LEVEL_CLASS[a.level]}${['closed', 'false_alarm', 'info'].includes(a.status) ? ' closed' : ''}${fresh === a.id ? ' new' : ''}`}
                onClick={() => go(a)}
              >
                <span className="alert-main">
                  <span className="sev">{a.level === 1 ? '🚨' : a.level === 2 ? '⚠️' : 'ℹ️'}</span>
                  <span className="msg">
                    {a.message}
                    <em>({a.robotCode ?? a.floorId?.toUpperCase() ?? '—'})</em>
                  </span>
                  <span className={`conf${a.confidence !== null ? '' : ' none'}`}>{a.confidence !== null ? `AI ${a.confidence}%` : ''}</span>
                  <StatusTag status={a.status} pill />
                  <time>{hhmm.format(new Date(a.occurredAt))}</time>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
      {inline && <AlarmDialog id={inline} onClose={() => setInline(null)} />}
    </section>
  );
}
