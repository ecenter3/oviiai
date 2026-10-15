import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, ApiError } from '../../api/client';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { PermGate } from '../../components/PermGate';
import { formatTime, t, type MessageKey } from '../../i18n';
import { ACTIVE_STATUSES, type DispatchMode, type Task, useTasks } from '../../stores/tasks';
import { useToast } from '../../stores/toast';
import { RejectDialog, targetLabel } from '../monitor/TasksPanel';

interface Floor {
  id: string;
  name: string;
}
interface TaskDetail extends Task {
  events: { at: string; type: string; data: Record<string, unknown> | null }[];
}

const PRIO: Record<Task['priority'], number> = { P1: 1, P2: 2, P3: 3, P4: 4 };

/** 審批期限還剩幾天（台北日期，含今天） */
export function daysLeft(until: string, now = new Date()): number {
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(now);
  return Math.round((Date.parse(`${until}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

/**
 * 派工管理（/dispatch）。這一版是審批頁（T-18）：審批模式狀態、待審批清單（核准、駁回、全部核准）、
 * 最近任務與歷程。手動建單、任務範本在 T-20 加入。
 */
export function DispatchPage() {
  const qc = useQueryClient();
  const floors = useQuery({ queryKey: ['floors'], queryFn: () => api<Floor[]>('/floors') });
  const mode = useQuery({ queryKey: ['dispatch', 'mode'], queryFn: () => api<DispatchMode>('/dispatch/mode'), refetchInterval: 60_000 });
  const pendingQ = useQuery({
    queryKey: ['tasks', 'pending'],
    queryFn: () => api<{ items: Task[] }>('/tasks?status=pending_approval&size=100'),
  });
  const recent = useQuery({ queryKey: ['tasks', 'recent'], queryFn: () => api<{ items: Task[] }>('/tasks?size=30') });
  const [rejecting, setRejecting] = useState<Task | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const floorName = (id: string) => floors.data?.find((f) => f.id === id)?.name ?? id;

  // task.updated（WebSocket）→ 重新整理清單
  const version = useTasks((s) => s.active);
  useEffect(() => {
    void qc.invalidateQueries({ queryKey: ['tasks'] });
  }, [version, qc]);

  const pending = [...(pendingQ.data?.items ?? [])].sort((a, b) => PRIO[a.priority] - PRIO[b.priority] || a.createdAt.localeCompare(b.createdAt));

  async function approve(list: Task[]) {
    let n = 0;
    for (const task of list) {
      try {
        await api(`/tasks/${task.id}/approve`, { method: 'POST' });
        n++;
      } catch (e) {
        if (list.length === 1) useToast.getState().show(e instanceof ApiError ? e.message : String(e), 'error');
      }
    }
    if (n) useToast.getState().show(list.length === 1 ? t('monitor.tasks.approved', { code: list[0].code }) : t('monitor.tasks.approvedAll', { n }), 'ok');
    await qc.invalidateQueries({ queryKey: ['tasks'] });
  }

  return (
    <div className="page dispatch-page">
      <h1 className="page-h">{t('page.dispatch')}</h1>
      <div className="dgrid2">
        <section className="dcard">
          <h3>{t('dispatch.approval.title')}</h3>
          {mode.data && <ApprovalStatus mode={mode.data} />}
          <p className="hint">{t('dispatch.create.later')}</p>
        </section>

        <section className="dcard">
          <h3>
            {t('dispatch.pending.title', { n: pending.length })}
            {pending.length > 1 && (
              <PermGate perms={['op.approve']}>
                <button type="button" className="mini yes push" onClick={() => void approve(pending)}>
                  {t('monitor.tasks.approveAll')}
                </button>
              </PermGate>
            )}
          </h3>
          {pending.length === 0 ? (
            <p className="muted">{t('dispatch.pending.empty')}</p>
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t('dispatch.col.code')}</th>
                  <th>{t('dispatch.col.priority')}</th>
                  <th>{t('dispatch.col.floor')}</th>
                  <th>{t('dispatch.col.target')}</th>
                  <th>{t('dispatch.col.createdBy')}</th>
                  <th>{t('dispatch.col.createdAt')}</th>
                  <th>{t('dispatch.col.note')}</th>
                  <th>{t('dispatch.col.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {pending.map((task) => (
                  <tr key={task.id} data-task={task.code}>
                    <td className="mono link" onClick={() => setDetail(task.id)}>
                      {task.code}
                    </td>
                    <td>
                      <span className={`prio ${task.priority}`}>{task.priority}</span>
                    </td>
                    <td>{floorName(task.floorId)}</td>
                    <td>{targetLabel(task)}</td>
                    <td>{task.createdByName ?? '—'}</td>
                    <td className="mono">{formatTime(task.createdAt)}</td>
                    <td>{task.note ?? ''}</td>
                    <td className="acts-cell">
                      <PermGate perms={['op.approve']}>
                        <button type="button" className="mini yes" onClick={() => void approve([task])}>
                          {t('monitor.tasks.approve')}
                        </button>
                        <button type="button" className="mini no" onClick={() => setRejecting(task)}>
                          {t('monitor.tasks.reject')}
                        </button>
                      </PermGate>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      <section className="dcard">
        <h3>{t('dispatch.recent.title')}</h3>
        {(recent.data?.items ?? []).length === 0 ? (
          <p className="muted">{t('dispatch.recent.empty')}</p>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>{t('dispatch.col.code')}</th>
                <th>{t('dispatch.col.priority')}</th>
                <th>{t('dispatch.col.floor')}</th>
                <th>{t('dispatch.col.target')}</th>
                <th>{t('dispatch.col.robot')}</th>
                <th>{t('dispatch.col.status')}</th>
                <th>{t('dispatch.col.source')}</th>
                <th>{t('dispatch.col.createdAt')}</th>
              </tr>
            </thead>
            <tbody>
              {(recent.data?.items ?? []).map((task) => (
                <tr key={task.id} className="clickable" onClick={() => setDetail(task.id)} data-task={task.code}>
                  <td className="mono">{task.code}</td>
                  <td>
                    <span className={`prio ${task.priority}`}>{task.priority}</span>
                  </td>
                  <td>{floorName(task.floorId)}</td>
                  <td>{targetLabel(task)}</td>
                  <td className="mono">{task.robotCode ?? '—'}</td>
                  <td>
                    <span className={`tstatus ${task.status}`}>{t(`task.status.${task.status}` as MessageKey)}</span>
                  </td>
                  <td>{t(`task.source.${task.source}` as MessageKey)}</td>
                  <td className="mono">{formatTime(task.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {rejecting && <RejectDialog task={rejecting} onClose={() => setRejecting(null)} />}
      {detail && <TaskDrawer id={detail} floorName={floorName} onClose={() => setDetail(null)} />}
    </div>
  );
}

function ApprovalStatus({ mode }: { mode: DispatchMode }) {
  const left = mode.approvalUntil ? daysLeft(mode.approvalUntil) : null;
  return (
    <div className={`approval ${mode.approval ? 'on' : 'off'}`} role="status">
      <strong>{t(mode.approval ? 'dispatch.approval.on' : 'dispatch.approval.off')}</strong>
      <p>{t(mode.approval ? 'dispatch.approval.onBody' : 'dispatch.approval.offBody')}</p>
      {mode.approvalUntil && mode.approvalSetting && (
        <p className="until">
          {t('dispatch.approval.until', { date: mode.approvalUntil })}
          {left !== null && left > 0 && ` · ${t('dispatch.approval.daysLeft', { n: left })}`}
          {left === 0 && ` · ${t('dispatch.approval.lastDay')}`}
          {left !== null && left < 0 && ` · ${t('dispatch.approval.expired')}`}
        </p>
      )}
      {mode.approval && <p className="hint">{t('dispatch.approval.autoClose')}</p>}
      <p className="hint">
        {t(mode.p1Preempt ? 'dispatch.preempt.on' : 'dispatch.preempt.off')} · {t('dispatch.approval.toggleHint')}
      </p>
    </div>
  );
}

/** 任務詳情與歷程（task_events） */
function TaskDrawer({ id, floorName, onClose }: { id: string; floorName(id: string): string; onClose(): void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['tasks', 'detail', id], queryFn: () => api<TaskDetail>(`/tasks/${id}`) });
  const [confirm, setConfirm] = useState(false);
  const task = q.data;
  const active = task && ACTIVE_STATUSES.includes(task.status);

  async function cancel() {
    if (!task) return;
    try {
      await api(`/tasks/${task.id}/cancel`, { method: 'POST' });
      useToast.getState().show(t('dispatch.detail.cancelled', { code: task.code }), 'warn');
      await qc.invalidateQueries({ queryKey: ['tasks'] });
    } catch (e) {
      useToast.getState().show(e instanceof ApiError ? e.message : String(e), 'error');
    }
  }

  return (
    <aside className="drawer" role="dialog" aria-label={task ? t('dispatch.detail.title', { code: task.code }) : ''} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="drawer-head">
        <h2>{task?.code ?? '…'}</h2>
        <button type="button" className="btn" onClick={onClose}>
          {t('dispatch.detail.close')}
        </button>
      </div>
      {task && (
        <div className="drawer-body">
          <dl className="kv">
            <dt>{t('dispatch.col.status')}</dt>
            <dd>
              <span className={`tstatus ${task.status}`}>{t(`task.status.${task.status}` as MessageKey)}</span>
            </dd>
            <dt>{t('dispatch.col.priority')}</dt>
            <dd>
              <span className={`prio ${task.priority}`}>{task.priority}</span>
            </dd>
            <dt>{t('dispatch.col.floor')}</dt>
            <dd>{floorName(task.floorId)}</dd>
            <dt>{t('dispatch.col.target')}</dt>
            <dd>{targetLabel(task)}</dd>
            <dt>{t('dispatch.col.robot')}</dt>
            <dd>{task.robotCode ?? '—'}</dd>
            <dt>{t('dispatch.col.createdBy')}</dt>
            <dd>{task.createdByName ?? '—'}</dd>
            {task.approvedByName && (
              <>
                <dt>{t('dispatch.detail.approvedBy')}</dt>
                <dd>{task.approvedByName}</dd>
              </>
            )}
            {task.failReason && (
              <>
                <dt>{t('dispatch.detail.failReason')}</dt>
                <dd>{task.failReason}</dd>
              </>
            )}
            {task.rejectReason && (
              <>
                <dt>{t('dispatch.detail.rejectReason')}</dt>
                <dd>{task.rejectReason}</dd>
              </>
            )}
            {task.note && (
              <>
                <dt>{t('dispatch.col.note')}</dt>
                <dd>{task.note}</dd>
              </>
            )}
          </dl>
          <div>
            <div className="muted">{t('dispatch.detail.events')}</div>
            <ol className="timeline">
              {task.events.map((e, i) => (
                <li key={i}>
                  <time className="mono">{formatTime(e.at)}</time>
                  <span>{eventLabel(e)}</span>
                </li>
              ))}
            </ol>
          </div>
          {active && (
            <PermGate perms={['op.dispatch']}>
              <button type="button" className="btn danger" onClick={() => setConfirm(true)}>
                {t('dispatch.detail.cancel')}
              </button>
            </PermGate>
          )}
        </div>
      )}
      {confirm && task && (
        <ConfirmDialog
          title={t('dispatch.detail.cancel')}
          body={t('dispatch.detail.cancelConfirm', { code: task.code })}
          confirmText={t('dispatch.detail.cancel')}
          danger
          onCancel={() => setConfirm(false)}
          onConfirm={() => {
            setConfirm(false);
            void cancel();
          }}
        />
      )}
    </aside>
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAUSE_REASONS = new Set(['offline', 'estop', 'teleop', 'charge', 'preempt']);

/** 暫停原因用介面文字，其他原因（失敗訊息等）原樣顯示 */
function reasonLabel(r: unknown): string | null {
  if (typeof r !== 'string' || !r) return null;
  return PAUSE_REASONS.has(r) ? t(`task.pause.${r}` as MessageKey) : r;
}

function eventLabel(e: TaskDetail['events'][number]): string {
  const key = `event.${e.type}` as MessageKey;
  const base = t(key) === key ? e.type : t(key);
  const d = e.data ?? {};
  // 舊資料的 by 可能是使用者 id：不顯示 UUID
  const extra = [d.robot, reasonLabel(d.reason ?? d.resumed), d.by].filter((x): x is string => typeof x === 'string' && !!x && !UUID.test(x));
  return extra.length ? `${base}（${extra.join(' · ')}）` : base;
}
