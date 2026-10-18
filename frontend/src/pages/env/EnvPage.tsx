import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api/client';
import { type EnvThreshold, EnvThresholds, fmtV, limitText } from '../../components/EnvThresholds';
import { FloorMap, type MapMark } from '../../components/FloorMap/FloorMap';
import { type ChartPoint, LineChart } from '../../components/LineChart';
import { formatTime, t } from '../../i18n';
import { addDays, taipeiDate, taipeiIso } from '../reports/time';

export interface Floor {
  id: string;
  name: string;
  planUrl: string | null;
  widthM: number | null;
  heightM: number | null;
}
type Over = 'high' | 'low' | null;
export interface EnvSummary {
  floorId: string;
  bucketSec: number;
  thresholds: EnvThreshold[];
  series: { kind: string; points: { at: string; avg: number; min: number; max: number }[] }[];
  latest: { robotId: string; code: string; at: string; x: number | null; y: number | null; values: Record<string, { value: number; unit: string; over: Over }> }[];
  alarms: Record<string, number>;
  alarmTotal: number;
}
export interface EnvMap {
  kind: string;
  unit: string;
  cell: number;
  cells: { x: number; y: number; n: number; avg: number; min: number; max: number; lastAt: string; over: Over }[];
}

/** 各項目的線色（溫度、濕度沿用原型） */
export const KIND_COLOR: Record<string, string> = {
  temp: '#fb923c',
  humidity: '#38bdf8',
  co: '#a78bfa',
  co2: '#94a3b8',
  ch4: '#f472b6',
  h2s: '#facc15',
  o2: '#34d399',
  smoke: '#cbd5e1',
  pm25: '#fbbf24',
  noise: '#22d3ee',
};
const POLL_MS = 30_000;

/**
 * 環境監測（/env，原型「環境監測」）：選期間與樓層，看各項目的趨勢（時間桶平均，紅點是桶內超標的最高或最低值、
 * 紅虛線是閾值）、各機器人目前數值，以及平面圖上的量測位置（依格子彙總，超標標紅）。側欄可改閾值（告警設置權限）。
 */
export function EnvPage() {
  const floors = useQuery({ queryKey: ['floors'], queryFn: () => api<Floor[]>('/floors') });
  const today = taipeiDate();
  const [from, setFrom] = useState(addDays(today, -2));
  const [to, setTo] = useState(today);
  const [floorId, setFloorId] = useState('');
  const [kind, setKind] = useState('');
  useEffect(() => {
    if (!floorId && floors.data?.length) setFloorId(floors.data[0].id);
  }, [floors.data, floorId]);

  const range = useMemo(() => ({ from: taipeiIso(from), to: taipeiIso(addDays(to, 1)) }), [from, to]);
  const qs = `floorId=${floorId}&from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`;
  const live = to >= today;
  const tooLong = new Date(range.to).getTime() - new Date(range.from).getTime() > 31 * 86_400_000;
  const sum = useQuery({
    queryKey: ['env', 'summary', qs],
    queryFn: () => api<EnvSummary>(`/env/summary?${qs}`),
    enabled: !!floorId && !tooLong,
    placeholderData: (p) => p,
    refetchInterval: live ? POLL_MS : false,
  });
  const d = sum.data;
  const th = useMemo(() => new Map((d?.thresholds ?? []).map((x) => [x.kind, x])), [d]);
  const kinds = d?.series.map((s) => s.kind) ?? [];
  const mapKind = kinds.includes(kind) ? kind : (kinds[0] ?? '');
  const map = useQuery({
    queryKey: ['env', 'map', qs, mapKind],
    queryFn: () => api<EnvMap>(`/env/map?${qs}&kind=${mapKind}`),
    enabled: !!floorId && !!mapKind && !tooLong,
    placeholderData: (p) => p,
    refetchInterval: live ? POLL_MS : false,
  });
  const floor = floors.data?.find((f) => f.id === floorId);
  const t0 = new Date(range.from).getTime();
  const domain: [number, number] = [t0, Math.max(t0 + 60_000, Math.min(new Date(range.to).getTime(), Date.now()))];
  const gap = Math.max(120, (d?.bucketSec ?? 60) * 3) * 1000;
  const latestKinds = [...new Set(d?.latest.flatMap((r) => Object.keys(r.values)) ?? [])].sort((a, b) => (th.get(a)?.sort ?? 99) - (th.get(b)?.sort ?? 99));
  const name = (k: string) => th.get(k)?.name ?? k;

  const marks: MapMark[] = (map.data?.cells ?? []).map((c, i) => ({
    id: `c${i}`,
    x: c.x,
    y: c.y,
    label: '',
    caption: fmtV(c.over === 'high' ? c.max : c.over === 'low' ? c.min : c.avg),
    tone: c.over ? 'bad' : 'ok',
    title: t('env.cellTip', { avg: fmtV(c.avg), max: fmtV(c.max), min: fmtV(c.min), unit: map.data!.unit, n: c.n, at: formatTime(c.lastAt) }),
  }));

  return (
    <div className="pg2">
      <section className="panel">
        <div className="pane-head">
          <span className="title">{t('page.env')}</span>
          <span className="meta">{floor && t('env.meta', { floor: floor.name, from, to, n: d?.alarmTotal ?? 0 })}</span>
        </div>
        <div className="scroll">
          <div className="chart-grid">
            {d?.series.map((s) => {
              const lim = th.get(s.kind);
              const alerts: ChartPoint[] = [];
              for (const p of s.points) {
                const at = new Date(p.at).getTime();
                if (lim?.max != null && p.max > lim.max) alerts.push({ t: at, v: p.max });
                else if (lim?.min != null && p.min < lim.min) alerts.push({ t: at, v: p.min });
              }
              return (
                <LineChart
                  key={s.kind}
                  title={`${name(s.kind)}${d.alarms[s.kind] ? ` · ${t('env.overN', { n: d.alarms[s.kind] })}` : ''}`}
                  unit={lim?.unit ?? ''}
                  color={KIND_COLOR[s.kind] ?? '#22d3ee'}
                  domain={domain}
                  gapMs={gap}
                  points={s.points.map((p) => ({ t: new Date(p.at).getTime(), v: p.avg }))}
                  limits={lim ? { min: lim.min, max: lim.max } : undefined}
                  alerts={alerts}
                />
              );
            })}
          </div>
          {d && d.series.length === 0 && <p className="empty-state">{t('env.empty')}</p>}
          <div className="pane-body">
            <h3 className="vs-h">{t('env.now')}</h3>
            <div className="tbl-wrap">
              <table className="dtbl">
                <thead>
                  <tr>
                    <th>{t('env.col.robot')}</th>
                    {latestKinds.map((k) => (
                      <th key={k}>{name(k)}</th>
                    ))}
                    <th>{t('env.col.at')}</th>
                    <th>{t('env.col.status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {d?.latest.length === 0 && (
                    <tr>
                      <td colSpan={3} className="tbl-empty">
                        {t('env.nowEmpty')}
                      </td>
                    </tr>
                  )}
                  {d?.latest.map((r) => {
                    const bad = Object.values(r.values).some((v) => v.over);
                    return (
                      <tr key={r.robotId}>
                        <td className="mono">{r.code}</td>
                        {latestKinds.map((k) => {
                          const v = r.values[k];
                          return (
                            <td key={k} className={`num${v?.over ? ' over' : ''}`}>
                              {v ? `${fmtV(v.value)} ${v.unit}` : '—'}
                            </td>
                          );
                        })}
                        <td className="mono">{formatTime(r.at).slice(11, 19)}</td>
                        <td>{bad ? <span className="badge2 black">{t('env.over')}</span> : <span className="badge2 ok">{t('env.ok')}</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <h3 className="vs-h">
              {t('env.mapTitle')}
              {map.data && <small className="muted"> {t('env.mapMeta', { cell: map.data.cell, n: map.data.cells.length })}</small>}
            </h3>
            {kinds.length > 0 && (
              <div className="chips env-chips" role="group" aria-label={t('env.mapKind')}>
                {kinds.map((k) => (
                  <button key={k} type="button" className={k === mapKind ? 'on' : ''} aria-pressed={k === mapKind} onClick={() => setKind(k)}>
                    {name(k)}
                  </button>
                ))}
                {th.get(mapKind) && <span className="chips-n">{t('env.limit', { v: limitText(th.get(mapKind)!) })}</span>}
              </div>
            )}
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
              {t('env.from')}
              <input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} />
            </label>
            <label className="fl">
              {t('env.to')}
              <input type="date" value={to} min={from} max={today} onChange={(e) => e.target.value && setTo(e.target.value)} />
            </label>
            {tooLong && <p className="fhint err">{t('env.tooLong')}</p>}
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
            <div className="fl">{t('env.thTitle')}</div>
            <EnvThresholds compact />
          </div>
        </div>
      </aside>
    </div>
  );
}
