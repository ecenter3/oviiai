import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/client';
import { FloorMap, type MapMark } from '../../components/FloorMap/FloorMap';
import { formatTime, t } from '../../i18n';
import { addDays, duration, taipeiDate, taipeiIso, tr } from './time';

interface RobotRow {
  id: string;
  code: string;
  floorId: string;
}
interface Floor {
  id: string;
  name: string;
  planUrl: string | null;
  widthM: number | null;
  heightM: number | null;
}
export interface ReportRow {
  id: string;
  code: string;
  kind: string;
  source: string;
  priority: string;
  status: string;
  floorId: string;
  robotId: string | null;
  robotCode: string | null;
  createdByName: string | null;
  note: string | null;
  targetName: string | null;
  targetType: 'poi' | 'path' | 'point';
  startedAt: string | null;
  endedAt: string | null;
  failReason: string | null;
}
export interface Report extends ReportRow {
  durationMs: number | null;
  distanceM: number;
  track: { x: number; y: number }[];
  waypoints: { x: number; y: number }[];
  target: { x?: number; y?: number } | null;
  alarms: number;
  snapshots: number;
  clips: number;
}

const label = (key: string) => tr(key, key.split('.').pop()!);
/** 任務名稱：備註，沒有就「種類＋目標」 */
export const taskName = (r: ReportRow) => r.note || `${label(`dispatch.kind.${r.kind}`)}${r.targetName ? ` · ${r.targetName}` : ''}`;
const operator = (r: ReportRow) => r.createdByName ?? label(`report.source.${r.source}`);
const SIZE = 20;

/**
 * 任務報告（/reports，原型「任務報告」）：已結束的任務，依日期、樓層、機器人、名稱篩選；
 * 「查看路徑」在平面圖上畫實際軌跡；「查看報告」顯示明細，可列印。
 */
export function ReportsPage() {
  const robots = useQuery({ queryKey: ['robots', 'list'], queryFn: () => api<RobotRow[]>('/robots') });
  const floors = useQuery({ queryKey: ['floors'], queryFn: () => api<Floor[]>('/floors') });
  const today = taipeiDate();
  const [draft, setDraft] = useState({ from: addDays(today, -6), to: today, floorId: '', robotId: '', q: '' });
  const [f, setF] = useState(draft);
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<{ id: string; view: 'report' | 'path' } | null>(null);

  const params = new URLSearchParams({ from: taipeiIso(f.from), to: taipeiIso(addDays(f.to, 1)), page: String(page), size: String(SIZE) });
  if (f.floorId) params.set('floorId', f.floorId);
  if (f.robotId) params.set('robotId', f.robotId);
  if (f.q.trim()) params.set('q', f.q.trim());
  const list = useQuery({
    queryKey: ['reports', params.toString()],
    queryFn: () => api<{ items: ReportRow[]; total: number }>(`/reports/tasks?${params}`),
    placeholderData: (prev) => prev,
  });
  const pages = Math.max(1, Math.ceil((list.data?.total ?? 0) / SIZE));
  const floorName = (id: string) => floors.data?.find((x) => x.id === id)?.name ?? id;

  return (
    <div className="pg2">
      <section className="panel">
        <div className="pane-head">
          <span className="title">{t('page.reports')}</span>
          <span className="meta">{t('report.meta', { from: f.from, to: f.to, n: list.data?.total ?? 0 })}</span>
        </div>
        <div className="scroll">
          <div className="pane-body">
            <div className="tbl-wrap">
              <table className="dtbl">
                <thead>
                  <tr>
                    <th>{t('alarm.col.no')}</th>
                    <th>{t('report.col.name')}</th>
                    <th>{t('report.col.nature')}</th>
                    <th>{t('report.col.path')}</th>
                    <th>{t('report.col.robot')}</th>
                    <th>{t('report.col.operator')}</th>
                    <th>{t('report.col.period')}</th>
                    <th>{t('report.col.result')}</th>
                    <th>{t('report.col.report')}</th>
                  </tr>
                </thead>
                <tbody>
                  {list.data?.items.length === 0 && (
                    <tr>
                      <td colSpan={9} className="tbl-empty">
                        {t('report.empty')}
                      </td>
                    </tr>
                  )}
                  {list.data?.items.map((r, i) => (
                    <tr key={r.id}>
                      <td>{(page - 1) * SIZE + i + 1}</td>
                      <td>
                        {taskName(r)}
                        <div className="sub mono">{r.code}</div>
                      </td>
                      <td>{label(`dispatch.kind.${r.kind}`)}</td>
                      <td>
                        {r.robotId ? (
                          <button type="button" className="lnk" onClick={() => setOpen({ id: r.id, view: 'path' })}>
                            {r.targetType === 'path' && r.targetName ? r.targetName : t('report.viewPath')}
                          </button>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="mono">{r.robotCode ?? '—'}</td>
                      <td>{operator(r)}</td>
                      <td className="mono">
                        {r.startedAt && `${formatTime(r.startedAt).slice(5, 16)} ～ ${r.endedAt ? formatTime(r.endedAt).slice(11, 16) : ''}`}
                      </td>
                      <td>
                        <span className={`badge2 ${r.status === 'done' ? 'ok' : r.status === 'failed' ? 'bad' : ''}`}>{label(`task.status.${r.status}`)}</span>
                      </td>
                      <td>
                        <button type="button" className="obtn" onClick={() => setOpen({ id: r.id, view: 'report' })}>
                          {t('report.view')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {list.data && list.data.total > SIZE && (
              <div className="pager">
                <span>{t('alarm.pager', { total: list.data.total })}</span>
                <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} aria-label={t('alarm.pager.prev')}>
                  ‹
                </button>
                <span className="mono">
                  {page} / {pages}
                </span>
                <button type="button" disabled={page >= pages} onClick={() => setPage((p) => p + 1)} aria-label={t('alarm.pager.next')}>
                  ›
                </button>
              </div>
            )}
          </div>
        </div>
      </section>
      <aside className="panel filt">
        <form
          className="scroll filt-in"
          onSubmit={(e) => {
            e.preventDefault();
            setPage(1);
            setF(draft);
          }}
        >
          <div className="fl">
            {t('report.range')}
            <div className="trange">
              <input type="date" aria-label={`${t('report.range')}（起）`} value={draft.from} max={draft.to} onChange={(e) => e.target.value && setDraft({ ...draft, from: e.target.value })} />
              <span>~</span>
              <input type="date" aria-label={`${t('report.range')}（迄）`} value={draft.to} min={draft.from} max={today} onChange={(e) => e.target.value && setDraft({ ...draft, to: e.target.value })} />
            </div>
          </div>
          <label className="fl">
            {t('report.floor')}
            <select value={draft.floorId} onChange={(e) => setDraft({ ...draft, floorId: e.target.value, robotId: '' })}>
              <option value="">{t('report.allFloors')}</option>
              {floors.data?.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </label>
          <label className="fl">
            {t('report.robot')}
            <select value={draft.robotId} onChange={(e) => setDraft({ ...draft, robotId: e.target.value })}>
              <option value="">{t('report.allRobots')}</option>
              {robots.data
                ?.filter((r) => !draft.floorId || r.floorId === draft.floorId)
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.code}
                  </option>
                ))}
            </select>
          </label>
          <label className="fl">
            {t('report.name')}
            <input value={draft.q} maxLength={64} placeholder={t('report.namePh')} onChange={(e) => setDraft({ ...draft, q: e.target.value })} />
          </label>
          <button type="submit" className="go2">
            {t('report.search')}
          </button>
        </form>
      </aside>
      {open && <ReportDialog id={open.id} view={open.view} floors={floors.data ?? []} floorName={floorName} onClose={() => setOpen(null)} onView={(view) => setOpen({ ...open, view })} />}
    </div>
  );
}

function ReportDialog(props: { id: string; view: 'report' | 'path'; floors: Floor[]; floorName(id: string): string; onClose(): void; onView(v: 'report' | 'path'): void }) {
  const rep = useQuery({ queryKey: ['reports', 'one', props.id], queryFn: () => api<Report>(`/reports/tasks/${props.id}`) });
  const r = rep.data;
  const floor = props.floors.find((x) => x.id === r?.floorId);
  const marks: MapMark[] = r
    ? [
        ...r.waypoints.map((p, i) => ({ id: `w${i}`, x: p.x, y: p.y, label: String(i + 1), tone: 'draft' as const })),
        ...(r.track.length ? [{ id: 'start', x: r.track[0].x, y: r.track[0].y, label: t('report.mark.start'), tone: 'ok' as const }] : []),
        ...(r.track.length > 1 ? [{ id: 'end', x: r.track.at(-1)!.x, y: r.track.at(-1)!.y, label: t('report.mark.end'), tone: 'warn' as const }] : []),
      ]
    : [];
  const title = r ? t(props.view === 'report' ? 'report.title' : 'report.pathTitle', { name: taskName(r) }) : t('common.loading');
  return (
    <div className="modal-bg report-print" onKeyDown={(e) => e.key === 'Escape' && props.onClose()}>
      <div className="modal wide2 report-dlg" role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {r && props.view === 'report' && (
          <table className="kvt">
            <tbody>
              <Row k={t('report.k.code')} v={r.code} />
              <Row k={t('report.k.name')} v={taskName(r)} body />
              <Row k={t('report.k.nature')} v={`${label(`dispatch.kind.${r.kind}`)}（${r.priority}）`} body />
              <Row k={t('report.k.robot')} v={`${r.robotCode ?? '—'}（${props.floorName(r.floorId)}）`} />
              <Row k={t('report.k.operator')} v={operator(r)} body />
              <Row k={t('report.k.period')} v={r.startedAt ? `${formatTime(r.startedAt)} ～ ${r.endedAt ? formatTime(r.endedAt).slice(11) : '—'}` : '—'} />
              <Row k={t('report.k.duration')} v={r.durationMs == null ? '—' : duration(r.durationMs)} body />
              <Row k={t('report.k.target')} v={r.targetName ?? (r.target?.x != null ? `(${r.target.x}, ${r.target.y})` : '—')} body />
              <Row k={t('report.k.distance')} v={`${r.distanceM.toFixed(1)} m`} />
              <Row k={t('report.k.waypoints')} v={r.waypoints.length ? t('report.n', { n: r.waypoints.length }) : '—'} body />
              <Row k={t('report.k.alarms')} v={t('report.times', { n: r.alarms })} body />
              <Row k={t('report.k.media')} v={t('report.media', { s: r.snapshots, c: r.clips })} body />
              <Row k={t('report.k.result')} v={`${label(`task.status.${r.status}`)}${r.failReason ? `：${r.failReason}` : ''}`} body tone={r.status === 'done' ? 'ok' : 'bad'} />
            </tbody>
          </table>
        )}
        {r && props.view === 'path' && <p className="hint">{t('report.pathMeta', { floor: props.floorName(r.floorId), n: r.track.length, d: r.distanceM.toFixed(0) })}</p>}
        {r && (props.view === 'path' || r.track.length > 1) && (
          <div className="report-map">
            <FloorMap
              widthM={floor?.widthM}
              heightM={floor?.heightM}
              planUrl={floor?.planUrl}
              paths={[{ id: 'track', points: r.track, tone: 'sel' }]}
              marks={marks}
              viewKey={r.id}
            />
          </div>
        )}
        {r && r.track.length === 0 && <p className="hint">{t('report.noTrack')}</p>}
        <div className="row no-print">
          {props.view === 'report' ? (
            <button type="button" className="btn" onClick={() => window.print()} disabled={!r}>
              {t('report.print')}
            </button>
          ) : (
            <button type="button" className="btn" onClick={() => props.onView('report')}>
              {t('report.view')}
            </button>
          )}
          <button type="button" className="btn primary" onClick={props.onClose} autoFocus>
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({ k, v, body, tone }: { k: string; v: string; body?: boolean; tone?: 'ok' | 'bad' }) {
  return (
    <tr>
      <th>{k}</th>
      <td className={`${body ? 'body' : ''}${tone ? ` tone-${tone}` : ''}`}>{v}</td>
    </tr>
  );
}
