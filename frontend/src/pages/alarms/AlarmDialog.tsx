import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../api/client';
import { LevelTag, StatusTag } from '../../components/AlarmTags';
import { FloorMap } from '../../components/FloorMap/FloorMap';
import { formatTime, t, type MessageKey } from '../../i18n';
import { ACTION_TO, ACTIONS, ACTIVE, type Alarm, type AlarmAction, type AlarmStatus, useAlarms } from '../../stores/alarms';
import { useAuth } from '../../stores/auth';
import { useToast } from '../../stores/toast';

interface AlarmDetail extends Alarm {
  events: { at: string; userName: string | null; from: AlarmStatus | null; to: AlarmStatus | null; note: string | null }[];
}
export interface FloorInfo {
  id: string;
  name: string;
  planUrl: string | null;
  widthM: number | null;
  heightM: number | null;
}

/**
 * 告警處理視窗（原型 alarmModal）：內容、級別、AI 信心值、狀態、截圖、發生地點（平面圖）、處理歷程；
 * 依狀態顯示合法的處理按鈕（後端邏輯 §5），可填處理說明、派機器人查看。
 */
export function AlarmDialog({ id, onClose }: { id: string; onClose(): void }) {
  const qc = useQueryClient();
  const can = useAuth((s) => s.can);
  const q = useQuery({ queryKey: ['alarms', 'detail', id], queryFn: () => api<AlarmDetail>(`/alarms/${id}`) });
  const floors = useQuery({ queryKey: ['floors'], queryFn: () => api<FloorInfo[]>('/floors') });
  const aiConfidence = useQuery({
    queryKey: ['settings', 'aiConfidence'],
    queryFn: () => api<{ values: Record<string, unknown> }>('/settings').then((r) => Number(r.values['alarm.aiConfidence'] ?? 70)),
    enabled: can('settings'),
  });
  const version = useAlarms((s) => s.version);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const closeBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => closeBtn.current?.focus(), []);
  // 別人處理了（alarm.updated）→ 重新讀取
  useEffect(() => {
    void qc.invalidateQueries({ queryKey: ['alarms', 'detail', id] });
  }, [version, id, qc]);

  const a = q.data;
  const floor = floors.data?.find((f) => f.id === a?.floorId);
  const acts = a ? ACTIONS[a.status] : [];
  const canAct = can('op.alarm');

  async function act(k: AlarmAction) {
    if (!a) return;
    setBusy(true);
    try {
      const r =
        k === 'report'
          ? await api<Alarm>(`/alarms/${a.id}/report`, { method: 'POST', json: { note: note || null } })
          : await api<Alarm>(`/alarms/${a.id}/transition`, { method: 'POST', json: { to: ACTION_TO[k], note: note || null } });
      useToast
        .getState()
        .show(k === 'report' ? t('alarm.act.reported') : t('alarm.act.done', { code: a.code, status: t(`alarm.status.${r.status}` as MessageKey) }), 'ok');
      setNote('');
      useAlarms.getState().dismissPopup(a.id);
      qc.setQueryData(['alarms', 'detail', id], (old: AlarmDetail | undefined) => (old ? { ...old, ...r } : old));
    } catch (e) {
      useToast.getState().show(e instanceof ApiError ? e.message : String(e), 'error');
    } finally {
      // 不等重新查詢：告警事件持續進來時查詢會一直被重啟，按鈕會卡在停用
      void qc.invalidateQueries({ queryKey: ['alarms'] });
      setBusy(false);
    }
  }

  async function dispatch() {
    if (!a) return;
    setBusy(true);
    try {
      const r = await api<{ taskCode: string }>(`/alarms/${a.id}/dispatch`, { method: 'POST' });
      useToast.getState().show(t('alarm.act.dispatched', { code: r.taskCode }), 'ok');
    } catch (e) {
      useToast.getState().show(e instanceof ApiError ? e.message : String(e), 'error');
    } finally {
      void qc.invalidateQueries({ queryKey: ['alarms', 'detail', id] });
      setBusy(false);
    }
  }

  const located = a && a.x !== null && a.y !== null && floor;

  return (
    <div className="modal-bg" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="modal wide-modal alarm-dialog" role="dialog" aria-modal="true" aria-label={a ? t('alarm.detail.title', { name: a.name }) : t('common.loading')}>
        <h2>{a ? t('alarm.detail.title', { name: a.name }) : t('common.loading')}</h2>
        {q.isError && <p className="error">{q.error instanceof ApiError ? q.error.message : String(q.error)}</p>}
        {a && (
          <div className="ad-body">
            <div className="ad-main">
              <table className="kvt">
                <tbody>
                  <tr>
                    <th>{t('alarm.detail.message')}</th>
                    <td className="body">{a.message}</td>
                  </tr>
                  <tr>
                    <th>{t('alarm.detail.code')}</th>
                    <td>{a.code}</td>
                  </tr>
                  <tr>
                    <th>{t('alarm.detail.time')}</th>
                    <td>{formatTime(a.occurredAt)}</td>
                  </tr>
                  <tr>
                    <th>{t('alarm.detail.floor')}</th>
                    <td>{floor?.name ?? a.floorId ?? '—'}</td>
                  </tr>
                  <tr>
                    <th>{t('alarm.detail.robot')}</th>
                    <td>{a.robotCode ?? '—'}</td>
                  </tr>
                  <tr>
                    <th>{t('alarm.detail.level')}</th>
                    <td>
                      <LevelTag level={a.level} />
                    </td>
                  </tr>
                  {a.confidence !== null && (
                    <tr>
                      <th>{t('alarm.detail.confidence')}</th>
                      <td>
                        {a.confidence}%{aiConfidence.data !== undefined && a.confidence < aiConfidence.data ? t('alarm.detail.lowConfidence') : ''}
                      </td>
                    </tr>
                  )}
                  <tr>
                    <th>{t('alarm.detail.status')}</th>
                    <td>
                      <StatusTag status={a.status} />
                    </td>
                  </tr>
                  {a.handledAt && (
                    <tr>
                      <th>{t('alarm.detail.handledAt')}</th>
                      <td>
                        {formatTime(a.handledAt)}
                        {a.handlerName ? ` · ${a.handlerName}` : ''}
                      </td>
                    </tr>
                  )}
                  {a.repeatCount > 1 && (
                    <tr>
                      <th>{t('alarm.detail.repeat')}</th>
                      <td>{a.repeatCount}</td>
                    </tr>
                  )}
                </tbody>
              </table>
              <div>
                <div className="muted">{t('alarm.detail.history')}</div>
                {a.events.length ? (
                  <ol className="timeline">
                    {a.events.map((e, i) => (
                      <li key={i}>
                        <time className="mono">{formatTime(e.at)}</time>
                        <span>{eventText(e)}</span>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="muted">{t('alarm.detail.noHistory')}</p>
                )}
              </div>
            </div>
            <div className="ad-side">
              <div>
                <div className="muted">{t('alarm.detail.media')}</div>
                {a.snapshotUrl ? <img className="ad-shot" src={a.snapshotUrl} alt={a.message} /> : <div className="ad-noshot">{t('alarm.detail.noMedia')}</div>}
              </div>
              {located && (
                <div>
                  <div className="muted">{t('alarm.detail.location')}</div>
                  <div className="ad-map">
                    <FloorMap
                      widthM={floor.widthM}
                      heightM={floor.heightM}
                      planUrl={floor.planUrl}
                      alarms={[{ id: a.id, x: a.x!, y: a.y!, label: a.name }]}
                      viewKey={a.id}
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
        {a && acts.length > 0 && canAct && (
          <textarea className="ad-note" placeholder={t('alarm.detail.note')} aria-label={t('alarm.detail.note')} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
        )}
        {a && acts.length > 0 && !canAct && <p className="hint">{t('alarm.detail.noPerm')}</p>}
        <div className="row">
          <button ref={closeBtn} type="button" className="btn" onClick={onClose}>
            {t('common.close')}
          </button>
          {a && located && ACTIVE.includes(a.status) && can('op.dispatch') && (
            <button type="button" className="btn" disabled={busy} onClick={() => void dispatch()}>
              {t('alarm.act.dispatch')}
            </button>
          )}
          {a &&
            canAct &&
            acts.map((k) => (
              <button
                key={k}
                type="button"
                className={`btn ${k === 'false_alarm' ? 'danger' : k === 'close' || k === 'confirm' || k === 'handle' ? 'primary' : ''}`}
                disabled={busy}
                onClick={() => void act(k)}
              >
                {t(`alarm.act.${k}` as MessageKey)}
              </button>
            ))}
        </div>
      </div>
    </div>
  );
}

function eventText(e: AlarmDetail['events'][number]): string {
  const who = e.userName ?? t('alarm.detail.system');
  const what = e.to ? (e.from ? `${t(`alarm.status.${e.from}` as MessageKey)} → ${t(`alarm.status.${e.to}` as MessageKey)}` : t(`alarm.status.${e.to}` as MessageKey)) : '';
  return [who, what, e.note].filter(Boolean).join(' · ');
}
