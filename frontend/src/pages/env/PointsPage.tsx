import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, ApiError } from '../../api/client';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { type EnvThreshold, fmtV, useEnvThresholds } from '../../components/EnvThresholds';
import { FloorMap, type MapMark } from '../../components/FloorMap/FloorMap';
import { formatTime, t } from '../../i18n';
import { useAuth } from '../../stores/auth';
import { useToast } from '../../stores/toast';
import { addDays, taipeiDate, taipeiIso } from '../reports/time';
import type { Floor } from './EnvPage';

type Freq = 'pass' | '1h' | '4h';
const FREQS: Freq[] = ['pass', '1h', '4h'];
export interface InspectionPoint {
  id: string;
  poiId: string;
  name: string;
  floorId: string;
  x: number;
  y: number;
  freq: Freq;
  radiusM: number;
  enabled: boolean;
  createdAt: string;
  lastAt: string | null;
  lastRobot: string | null;
  values: Record<string, { value: number; unit: string; at: string; over: 'high' | 'low' | null }>;
  status: 'none' | 'ok' | 'over';
  measuring: boolean;
}
interface Poi {
  id: string;
  floorId: string;
  name: string;
  kind: 'poi' | 'parking';
}
const POLL_MS = 15_000;

/**
 * 定點檢測（/points，原型「環境檢測點」）：從興趣點挑選檢測點，機器人經過（進入半徑內）時記錄環境數值；
 * 列表顯示最近一次的數值與是否超標，平面圖標示各點狀態。「立即檢測」派一張環境監測任務過去（要派工權限）。
 */
export function PointsPage() {
  const qc = useQueryClient();
  const can = useAuth((s) => s.can);
  const toast = useToast.getState().show;
  const floors = useQuery({ queryKey: ['floors'], queryFn: () => api<Floor[]>('/floors') });
  const th = useEnvThresholds();
  const [floorId, setFloorId] = useState('');
  const [add, setAdd] = useState({ poiId: '', freq: 'pass' as Freq, radius: '2' });
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<InspectionPoint | null>(null);
  const [history, setHistory] = useState<InspectionPoint | null>(null);
  useEffect(() => {
    if (!floorId && floors.data?.length) setFloorId(floors.data[0].id);
  }, [floors.data, floorId]);
  const list = useQuery({
    queryKey: ['env', 'points', floorId],
    queryFn: () => api<InspectionPoint[]>(`/env/points?floorId=${floorId}`),
    enabled: !!floorId,
    refetchInterval: POLL_MS,
  });
  const pois = useQuery({ queryKey: ['pois', floorId], queryFn: () => api<Poi[]>(`/pois?floor=${floorId}`), enabled: !!floorId });
  const free = useMemo(() => (pois.data ?? []).filter((p) => !list.data?.some((x) => x.poiId === p.id)), [pois.data, list.data]);
  const firstFree = free[0]?.id ?? '';
  useEffect(() => {
    if (!free.some((p) => p.id === add.poiId) && add.poiId !== firstFree) setAdd((a) => ({ ...a, poiId: firstFree }));
  }, [free, firstFree, add.poiId]);

  const floor = floors.data?.find((f) => f.id === floorId);
  const kindName = (k: string) => th.data?.find((x) => x.kind === k)?.name ?? k;
  const order = (k: string) => th.data?.find((x) => x.kind === k)?.sort ?? 99;
  const refresh = () => qc.invalidateQueries({ queryKey: ['env', 'points'] });

  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    try {
      await fn();
      toast(ok, 'ok');
      await refresh();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  }
  const create = () =>
    run(() => api('/env/points', { method: 'POST', json: { poiId: add.poiId, freq: add.freq, radiusM: Number(add.radius) || 2 } }), t('points.added'));
  const patch = (p: InspectionPoint, body: Partial<Pick<InspectionPoint, 'freq' | 'enabled'>>) =>
    run(() => api(`/env/points/${p.id}`, { method: 'PATCH', json: body }), t('points.updated'));
  const measure = (p: InspectionPoint) =>
    run(async () => {
      const r = await api<{ taskCode: string }>(`/env/points/${p.id}/measure`, { method: 'POST', json: {} });
      toast(t('points.measureSent', { name: p.name, code: r.taskCode }), 'ok');
    }, t('points.measuring'));

  const marks: MapMark[] = (list.data ?? []).map((p) => ({
    id: p.id,
    x: p.x,
    y: p.y,
    label: '',
    caption: p.name,
    tone: !p.enabled ? 'draft' : p.status === 'over' ? 'bad' : p.status === 'ok' ? 'ok' : 'warn',
    title: p.lastAt ? `${p.name} · ${formatTime(p.lastAt)}` : `${p.name} · ${t('points.never')}`,
  }));

  return (
    <div className="pg2">
      <section className="panel">
        <div className="pane-head">
          <span className="title">{t('page.points')}</span>
          <span className="meta">{floor && t('points.meta', { floor: floor.name, n: list.data?.length ?? 0, over: list.data?.filter((p) => p.status === 'over').length ?? 0 })}</span>
        </div>
        <div className="scroll">
          <div className="pane-body">
            <div className="tbl-wrap">
              <table className="dtbl">
                <thead>
                  <tr>
                    <th>{t('alarm.col.no')}</th>
                    <th>{t('points.col.place')}</th>
                    <th>{t('points.col.freq')}</th>
                    <th>{t('points.col.values')}</th>
                    <th>{t('points.col.at')}</th>
                    <th>{t('points.col.status')}</th>
                    <th>{t('points.col.ops')}</th>
                  </tr>
                </thead>
                <tbody>
                  {list.data?.length === 0 && (
                    <tr>
                      <td colSpan={7} className="tbl-empty">
                        {t('points.empty')}
                      </td>
                    </tr>
                  )}
                  {list.data?.map((p, i) => (
                    <tr key={p.id} className={p.enabled ? '' : 'off'}>
                      <td>{i + 1}</td>
                      <td>
                        {p.name}
                        <div className="sub mono">{t('points.radius', { r: fmtV(p.radiusM) })}</div>
                      </td>
                      <td>
                        <select aria-label={t('points.freqOf', { name: p.name })} value={p.freq} disabled={busy} onChange={(e) => void patch(p, { freq: e.target.value as Freq })}>
                          {FREQS.map((f) => (
                            <option key={f} value={f}>
                              {t(`points.freq.${f}`)}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <div className="pt-vals">
                          {Object.entries(p.values)
                            .sort(([a], [b]) => order(a) - order(b))
                            .map(([k, v]) => (
                              <span key={k} className={v.over ? 'over' : ''}>
                                {kindName(k)} <b className="mono">{fmtV(v.value)}</b> {v.unit}
                              </span>
                            ))}
                          {!p.lastAt && <span className="muted">{t('points.never')}</span>}
                        </div>
                      </td>
                      <td className="mono">
                        {p.lastAt ? formatTime(p.lastAt).slice(5, 16) : '—'}
                        {p.lastRobot && <div className="sub">{p.lastRobot}</div>}
                      </td>
                      <td>
                        {p.measuring ? (
                          <span className="badge2 blue">{t('points.status.measuring')}</span>
                        ) : !p.enabled ? (
                          <span className="badge2">{t('points.status.off')}</span>
                        ) : p.status === 'over' ? (
                          <span className="badge2 black">{t('env.over')}</span>
                        ) : p.status === 'ok' ? (
                          <span className="badge2 ok">{t('env.ok')}</span>
                        ) : (
                          <span className="badge2">{t('points.status.none')}</span>
                        )}
                      </td>
                      <td>
                        <div className="acts">
                          <button type="button" className="obtn" onClick={() => setHistory(p)}>
                            {t('points.history')}
                          </button>
                          {can('op.dispatch') && (
                            <button type="button" className="obtn" disabled={busy || !p.enabled || p.measuring} onClick={() => void measure(p)}>
                              {t('points.measure')}
                            </button>
                          )}
                          <button type="button" className="obtn" disabled={busy} onClick={() => void patch(p, { enabled: !p.enabled })}>
                            {t(p.enabled ? 'points.disable' : 'points.enable')}
                          </button>
                          <button type="button" className="obtn red" disabled={busy} onClick={() => setRemoving(p)}>
                            {t('points.remove')}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {floor && (
              <div className="env-map">
                <FloorMap widthM={floor.widthM} heightM={floor.heightM} planUrl={floor.planUrl} marks={marks} viewKey={floor.id} />
              </div>
            )}
          </div>
        </div>
      </section>
      <aside className="panel filt">
        <div className="scroll">
          <div className="filt-in">
            <label className="fl">
              {t('env.floor')}
              <select value={floorId} onChange={(e) => setFloorId(e.target.value)}>
                {floors.data?.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="fl">{t('points.add')}</div>
            <label className="fl">
              {t('points.poi')}
              <select value={add.poiId} onChange={(e) => setAdd({ ...add, poiId: e.target.value })}>
                {free.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            {pois.data && !free.length && <p className="fhint">{t(pois.data.length ? 'points.allUsed' : 'points.noPoi')}</p>}
            <label className="fl">
              {t('points.col.freq')}
              <select value={add.freq} onChange={(e) => setAdd({ ...add, freq: e.target.value as Freq })}>
                {FREQS.map((f) => (
                  <option key={f} value={f}>
                    {t(`points.freq.${f}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="fl">
              {t('points.radiusM')}
              <input type="number" min={0.5} max={10} step={0.5} value={add.radius} onChange={(e) => setAdd({ ...add, radius: e.target.value })} />
            </label>
            <button type="button" className="go2" disabled={busy || !add.poiId} onClick={() => void create()}>
              {t('points.add')}
            </button>
            <p className="hint">{t('points.hint')}</p>
          </div>
        </div>
      </aside>
      {removing && (
        <ConfirmDialog
          title={t('points.remove')}
          body={t('points.removeConfirm', { name: removing.name })}
          confirmText={t('points.remove')}
          danger
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            const p = removing;
            setRemoving(null);
            void run(() => api(`/env/points/${p.id}`, { method: 'DELETE' }), t('points.removed'));
          }}
        />
      )}
      {history && <HistoryDialog point={history} kindName={kindName} order={order} thresholds={th.data ?? []} onClose={() => setHistory(null)} />}
    </div>
  );
}

const HSIZE = 20;

/** 檢測點的量測紀錄（最近 7 天） */
function HistoryDialog({ point, kindName, order, thresholds, onClose }: { point: InspectionPoint; kindName(k: string): string; order(k: string): number; thresholds: EnvThreshold[]; onClose(): void }) {
  /** 以目前的閾值標紅 */
  const overOf = (k: string, v: number) => {
    const x = thresholds.find((y) => y.kind === k);
    return !!x && ((x.max != null && v > x.max) || (x.min != null && v < x.min));
  };
  const [page, setPage] = useState(1);
  const today = taipeiDate();
  const qs = new URLSearchParams({ from: taipeiIso(addDays(today, -6)), to: taipeiIso(addDays(today, 1)), page: String(page), size: String(HSIZE) });
  const q = useQuery({
    queryKey: ['env', 'point-readings', point.id, qs.toString()],
    queryFn: () => api<{ items: { at: string; robotCode: string | null; values: Record<string, number> }[]; total: number }>(`/env/points/${point.id}/readings?${qs}`),
    placeholderData: (p) => p,
  });
  const kinds = [...new Set(q.data?.items.flatMap((r) => Object.keys(r.values)) ?? [])].sort((a, b) => order(a) - order(b));
  const pages = Math.max(1, Math.ceil((q.data?.total ?? 0) / HSIZE));
  return createPortal(
    <div className="modal-bg" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="modal wide2" role="dialog" aria-modal="true" aria-label={t('points.historyTitle', { name: point.name })}>
        <h2>{t('points.historyTitle', { name: point.name })}</h2>
        <p className="hint">{t('points.historyMeta', { n: q.data?.total ?? 0 })}</p>
        <div className="tbl-wrap">
          <table className="dtbl">
            <thead>
              <tr>
                <th>{t('points.col.at')}</th>
                <th>{t('env.col.robot')}</th>
                {kinds.map((k) => (
                  <th key={k}>{kindName(k)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {q.data?.items.length === 0 && (
                <tr>
                  <td colSpan={2} className="tbl-empty">
                    {t('points.never')}
                  </td>
                </tr>
              )}
              {q.data?.items.map((r) => (
                <tr key={`${r.at}${r.robotCode}`}>
                  <td className="mono">{formatTime(r.at)}</td>
                  <td className="mono">{r.robotCode ?? '—'}</td>
                  {kinds.map((k) => (
                    <td key={k} className={`num${r.values[k] != null && overOf(k, r.values[k]) ? ' over' : ''}`}>
                      {r.values[k] == null ? '—' : fmtV(r.values[k])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {q.data && q.data.total > HSIZE && (
          <div className="pager">
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
        <div className="row">
          <button type="button" className="btn primary" onClick={onClose} autoFocus>
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
