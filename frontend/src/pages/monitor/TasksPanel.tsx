import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import { api, ApiError } from '../../api/client';
import { PermGate } from '../../components/PermGate';
import { t, type MessageKey } from '../../i18n';
import { ACTIVE_STATUSES, type Task, useTasks } from '../../stores/tasks';
import { useToast } from '../../stores/toast';

const PRIO: Record<Task['priority'], number> = { P1: 1, P2: 2, P3: 3, P4: 4 };
const byPrio = (a: Task, b: Task) => PRIO[a.priority] - PRIO[b.priority] || a.createdAt.localeCompare(b.createdAt);

const GROUPS = [
  { key: 'review', label: 'monitor.tasks.review', ico: 'approve', glyph: '✎', statuses: ['pending_approval'] },
  { key: 'pending', label: 'monitor.tasks.pending', ico: 'pending', glyph: '⏳', statuses: ['queued'] },
  { key: 'running', label: 'monitor.tasks.running', ico: 'running', glyph: '▶', statuses: ['assigned', 'running', 'paused'] },
] as const;

export function targetLabel(task: Task): string {
  const tg = task.target;
  if ('x' in tg) return t('monitor.tasks.target.xy', { x: tg.x.toFixed(1), y: tg.y.toFixed(1) });
  return 'pathId' in tg ? t('monitor.tasks.target.path') : t('monitor.tasks.target.poi');
}

/** 實時監控左欄「派工任務」（原型）：待審核、待派工、進行中；P1 紅框；點有機器人的任務在地圖上定位 */
export function TasksPanel(props: { floorName(id: string): string; onFocusRobot(task: Task): void; focusedRobotId: string | null }) {
  const load = useTasks((s) => s.load);
  const active = useTasks((s) => s.active);
  const initial = useQuery({
    queryKey: ['tasks', 'active'],
    queryFn: () => api<{ items: Task[] }>(`/tasks?status=${ACTIVE_STATUSES.join(',')}&size=100`),
  });
  useEffect(() => {
    if (initial.data) load(initial.data.items);
  }, [initial.data, load]);

  const [rejecting, setRejecting] = useState<Task | null>(null);
  const tasks = Object.values(active);

  async function approve(task: Task) {
    try {
      await api(`/tasks/${task.id}/approve`, { method: 'POST' });
      useToast.getState().show(t('monitor.tasks.approved', { code: task.code }), 'ok');
    } catch (e) {
      useToast.getState().show(e instanceof ApiError ? e.message : String(e), 'error');
    }
  }

  return (
    <section className="panel tasks" aria-label={t('monitor.tasks')}>
      <div className="panel-head">{t('monitor.tasks')}</div>
      <div className="scroll">
        {GROUPS.map((g) => {
          const list = tasks.filter((x) => (g.statuses as readonly string[]).includes(x.status)).sort(byPrio);
          return (
            <div key={g.key}>
              <div className="group-title">
                <span className={`ico ${g.ico}`}>{g.glyph}</span>
                {t(g.label)} <span className="n">({list.length})</span>
              </div>
              {list.length === 0 ? (
                <div className="empty">{t('monitor.tasks.empty')}</div>
              ) : (
                <div className="task-list">
                  {list.map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      floorName={props.floorName(task.floorId)}
                      selected={!!task.robotId && task.robotId === props.focusedRobotId}
                      onClick={task.robotId && g.key === 'running' ? () => props.onFocusRobot(task) : undefined}
                      onApprove={() => void approve(task)}
                      onReject={() => setRejecting(task)}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {rejecting && <RejectDialog task={rejecting} onClose={() => setRejecting(null)} />}
    </section>
  );
}

function TaskCard(props: { task: Task; floorName: string; selected: boolean; onClick?: () => void; onApprove(): void; onReject(): void }) {
  const { task } = props;
  const sub =
    task.status === 'paused'
      ? t('monitor.tasks.paused', { reason: task.progress.pausedBy ? t(`task.pause.${task.progress.pausedBy}` as MessageKey) : '' })
      : task.status === 'queued'
        ? task.pinnedRobot && task.robotCode
          ? t('monitor.tasks.pinned', { robot: task.robotCode })
          : t('monitor.tasks.noRobot')
        : task.robotCode
          ? `${task.robotCode} · ${t(`task.status.${task.status}` as MessageKey)}`
          : t(`task.status.${task.status}` as MessageKey);
  return (
    <div
      className={`task${task.priority === 'P1' ? ' p1' : ''}${props.selected ? ' sel' : ''}${props.onClick ? ' clickable' : ''}`}
      onClick={props.onClick}
      onKeyDown={(e) => props.onClick && (e.key === 'Enter' || e.key === ' ') && props.onClick()}
      role={props.onClick ? 'button' : undefined}
      tabIndex={props.onClick ? 0 : undefined}
      data-task={task.code}
    >
      <div className="task-top">
        <span className="task-id">{task.code}</span>
        <span className="task-src">{t(`task.source.${task.source}` as MessageKey)}</span>
      </div>
      <div className="task-desc">
        <span>
          {props.floorName} {targetLabel(task)}
        </span>
        <span className={`prio ${task.priority}`}>{task.priority}</span>
      </div>
      <div className="task-sub">{sub}</div>
      {task.status === 'pending_approval' && (
        <PermGate perms={['op.approve']}>
          <div className="task-acts">
            <button type="button" className="mini yes" onClick={props.onApprove}>
              {t('monitor.tasks.approve')}
            </button>
            <button type="button" className="mini no" onClick={props.onReject}>
              {t('monitor.tasks.reject')}
            </button>
          </div>
        </PermGate>
      )}
    </div>
  );
}

function RejectDialog({ task, onClose }: { task: Task; onClose(): void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!reason.trim()) return;
    setBusy(true);
    try {
      await api(`/tasks/${task.id}/reject`, { method: 'POST', json: { reason: reason.trim() } });
      useToast.getState().show(t('monitor.tasks.rejected', { code: task.code }), 'warn');
      onClose();
    } catch (err) {
      useToast.getState().show(err instanceof ApiError ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="modal-bg" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <form className="modal" role="dialog" aria-modal="true" aria-label={t('monitor.tasks.rejectTitle', { code: task.code })} onSubmit={submit}>
        <h2>{t('monitor.tasks.rejectTitle', { code: task.code })}</h2>
        <label>
          {t('monitor.tasks.rejectReason')}
          <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} autoFocus />
        </label>
        <div className="row">
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn danger solid" disabled={busy || !reason.trim()}>
            {t('monitor.tasks.reject')}
          </button>
        </div>
      </form>
    </div>
  );
}
