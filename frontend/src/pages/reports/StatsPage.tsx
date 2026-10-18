import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { api, ApiError, download } from '../../api/client';
import { BarChart } from '../../components/BarChart';
import { t } from '../../i18n';
import { useToast } from '../../stores/toast';
import { addDays, taipeiDate, tr } from './time';

interface RobotRow {
  id: string;
  code: string;
  floorId: string;
}
interface Floor {
  id: string;
  name: string;
}
interface Day {
  date: string;
  tasksDone: number;
  tasksFailed: number;
  tasksCancelled: number;
  alarmsBusiness: number;
  alarmsSystem: number;
  talks: number;
  distanceM: number;
  busyH: number;
  chargingH: number;
  idleH: number;
  faultH: number;
  offlineH: number;
  utilization: number | null;
}
export interface StatsResp {
  from: string;
  to: string;
  generatedAt: string;
  robotCount: number;
  totals: Omit<Day, 'date' | 'utilization'> & { alarmStatus: Record<string, number>; utilization: number | null; availability: number | null };
  days: Day[];
  robots: { id: string; code: string; floorId: string; tasksDone: number; distanceM: number; busyH: number; utilization: number | null; availability: number | null }[];
  schedules: { id: string; name: string; startTime: string; repeat: string; enabled: boolean; floorId: string; pathName: string | null; robotCode: string | null }[];
}

type Kind = 'week' | 'month' | 'quarter' | 'year' | 'custom';
const KINDS: Kind[] = ['week', 'month', 'quarter', 'year', 'custom'];

/** 報表期間選項（台北日期）：近 8 週、6 個月、4 季、2 年 */
export function periods(kind: Kind, today = taipeiDate()): { label: string; from: string; to: string }[] {
  const [y, m, d] = today.split('-').map(Number);
  const iso = (yy: number, mm: number, dd: number) => new Date(Date.UTC(yy, mm, dd)).toISOString().slice(0, 10);
  const out: { label: string; from: string; to: string }[] = [];
  if (kind === 'week') {
    const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
    for (let i = 0; i < 8; i++) {
      const mon = addDays(today, -dow - 7 * i);
      const sun = addDays(mon, 6);
      out.push({ label: t('stats.period.week', { from: mon.slice(5), to: sun.slice(5) }), from: mon, to: sun });
    }
  } else if (kind === 'month') {
    for (let i = 0; i < 6; i++) {
      const a = new Date(Date.UTC(y, m - 1 - i, 1));
      out.push({ label: t('stats.period.month', { y: a.getUTCFullYear(), m: a.getUTCMonth() + 1 }), from: iso(a.getUTCFullYear(), a.getUTCMonth(), 1), to: iso(a.getUTCFullYear(), a.getUTCMonth() + 1, 0) });
    }
  } else if (kind === 'quarter') {
    for (let i = 0; i < 4; i++) {
      const q0 = Math.floor((m - 1) / 3) - i;
      const yy = y + Math.floor(q0 / 4);
      const q = ((q0 % 4) + 4) % 4;
      out.push({ label: t('stats.period.quarter', { y: yy, q: q + 1 }), from: iso(yy, q * 3, 1), to: iso(yy, q * 3 + 3, 0) });
    }
  } else if (kind === 'year') {
    for (let i = 0; i < 2; i++) out.push({ label: t('stats.period.year', { y: y - i }), from: `${y - i}-01-01`, to: `${y - i}-12-31` });
  }
  return out.map((p) => ({ ...p, to: p.to > today ? today : p.to }));
}

/** 分類色（驗證過的色盤）：藍、橘；告警處理狀態用狀態色＋文字 */
const C1 = '#2a78d6';
const C2 = '#eb6834';
const STATUS_COLOR: Record<string, string> = { closed: '#008300', reported: '#1baf7a', open: '#d03b3b', review: '#eda100', handling: '#eda100', false_alarm: '#9ca3af', info: '#9ca3af' };

/**
 * 數據統計（/stats，原型「數據統計」報表紙面）：週、月、季、年或自訂期間，可依樓層、機器人篩選；
 * 工作數據總覽、圖表（任務量、告警量、稼動率、里程）、詳情（巡邏排程、每日、各機器人、告警處理），可匯出 Excel、列印。
 */
export function StatsPage() {
  const robots = useQuery({ queryKey: ['robots', 'list'], queryFn: () => api<RobotRow[]>('/robots') });
  const floors = useQuery({ queryKey: ['floors'], queryFn: () => api<Floor[]>('/floors') });
  const today = taipeiDate();
  const [kind, setKind] = useState<Kind>('week');
  const opts = useMemo(() => periods(kind, today), [kind, today]);
  const [period, setPeriod] = useState(0);
  const [custom, setCustom] = useState({ from: addDays(today, -6), to: today });
  const [floorId, setFloorId] = useState('');
  const [robotId, setRobotId] = useState('');
  const [busy, setBusy] = useState(false);
  const range = kind === 'custom' ? custom : (opts[period] ?? opts[0]);
  const qs = new URLSearchParams({ from: range.from, to: range.to });
  if (floorId) qs.set('floorId', floorId);
  if (robotId) qs.set('robotId', robotId);
  const data = useQuery({ queryKey: ['stats', qs.toString()], queryFn: () => api<StatsResp>(`/stats/summary?${qs}`), placeholderData: (p) => p });
  const s = data.data;
  const floorName = (id: string) => floors.data?.find((f) => f.id === id)?.name ?? id;
  const scope = robotId ? (robots.data?.find((r) => r.id === robotId)?.code ?? '') : floorId ? floorName(floorId) : t('stats.allFloors');

  async function exportXlsx() {
    setBusy(true);
    try {
      await download(`/stats/export?${qs}`, `stats-${range.from.replace(/-/g, '')}-${range.to.replace(/-/g, '')}.xlsx`);
    } catch (e) {
      useToast.getState().show(e instanceof ApiError ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  const labels = s?.days.map((d) => d.date.slice(5)) ?? [];
  const T = s?.totals;
  const pct = (v: number | null | undefined) => (v == null ? '—' : `${v}%`);
  const statusRows = T ? Object.entries(T.alarmStatus).sort((a, b) => b[1] - a[1]) : [];
  const alarmTotal = statusRows.reduce((a, [, n]) => a + n, 0);

  return (
    <div className="pg2">
      <section className="panel">
        <div className="paper-wrap">
          <article className="paper stats-paper" aria-busy={data.isFetching}>
            <h2>{t('stats.title')}</h2>
            <table>
              <tbody>
                <tr>
                  <th>{t('stats.h.scope')}</th>
                  <td className="v">{scope}</td>
                  <th>{t('stats.h.robots')}</th>
                  <td className="v">{s?.robotCount ?? '—'}</td>
                </tr>
                <tr>
                  <th>{t('stats.h.from')}</th>
                  <td className="v">{range.from}</td>
                  <th>{t('stats.h.to')}</th>
                  <td className="v">{range.to}</td>
                </tr>
                <tr>
                  <th>{t('stats.h.generated')}</th>
                  <td className="v" colSpan={3}>
                    {today}
                  </td>
                </tr>
              </tbody>
            </table>

            {T && (
              <>
                <h3>{t('stats.overview')}</h3>
                <table>
                  <tbody>
                    <tr>
                      <th rowSpan={5}>
                        {t('stats.o.hours')}
                        <br />
                        {(T.busyH + T.chargingH + T.idleH + T.faultH + T.offlineH).toFixed(2)}
                      </th>
                      <td>{t('stats.o.busy')}</td>
                      <td className="v">{T.busyH.toFixed(2)}</td>
                    </tr>
                    <tr>
                      <td>{t('stats.o.charging')}</td>
                      <td className="v">{T.chargingH.toFixed(2)}</td>
                    </tr>
                    <tr>
                      <td>{t('stats.o.idle')}</td>
                      <td className="v">{T.idleH.toFixed(2)}</td>
                    </tr>
                    <tr>
                      <td>{t('stats.o.fault')}</td>
                      <td className="v">{T.faultH.toFixed(2)}</td>
                    </tr>
                    <tr>
                      <td>{t('stats.o.offline')}</td>
                      <td className="v">{T.offlineH.toFixed(2)}</td>
                    </tr>
                    <tr>
                      <th rowSpan={2}>{t('stats.o.rate')}</th>
                      <td>{t('stats.o.utilization')}</td>
                      <td className="v">{pct(T.utilization)}</td>
                    </tr>
                    <tr>
                      <td>{t('stats.o.availability')}</td>
                      <td className="v">{pct(T.availability)}</td>
                    </tr>
                    <tr>
                      <th rowSpan={4}>
                        {t('stats.o.tasks')}
                        <br />
                        {T.tasksDone + T.tasksFailed + T.tasksCancelled}
                      </th>
                      <td>{t('stats.o.done')}</td>
                      <td className="v">{T.tasksDone}</td>
                    </tr>
                    <tr>
                      <td>{t('stats.o.failed')}</td>
                      <td className="v">{T.tasksFailed}</td>
                    </tr>
                    <tr>
                      <td>{t('stats.o.cancelled')}</td>
                      <td className="v">{T.tasksCancelled}</td>
                    </tr>
                    <tr>
                      <td>{t('stats.o.distance')}</td>
                      <td className="v">{T.distanceM.toFixed(1)}</td>
                    </tr>
                    <tr>
                      <th rowSpan={2}>
                        {t('stats.o.alarms')}
                        <br />
                        {T.alarmsBusiness + T.alarmsSystem}
                      </th>
                      <td>{t('stats.o.business')}</td>
                      <td className="v">{T.alarmsBusiness}</td>
                    </tr>
                    <tr>
                      <td>{t('stats.o.system')}</td>
                      <td className="v">{T.alarmsSystem}</td>
                    </tr>
                    <tr>
                      <th>{t('stats.o.talks')}</th>
                      <td colSpan={2} className="v">
                        {T.talks}
                      </td>
                    </tr>
                  </tbody>
                </table>

                <h3>{t('stats.charts')}</h3>
                <div className="pcharts">
                  <BarChart
                    title={t('stats.c.tasks')}
                    unit={t('stats.unit.times')}
                    labels={labels}
                    series={[
                      { name: t('stats.o.done'), color: C1, values: s!.days.map((d) => d.tasksDone) },
                      { name: t('stats.c.notDone'), color: C2, values: s!.days.map((d) => d.tasksFailed + d.tasksCancelled) },
                    ]}
                  />
                  <BarChart
                    title={t('stats.c.alarms')}
                    unit={t('stats.unit.times')}
                    labels={labels}
                    series={[
                      { name: t('stats.o.business'), color: C1, values: s!.days.map((d) => d.alarmsBusiness) },
                      { name: t('stats.o.system'), color: C2, values: s!.days.map((d) => d.alarmsSystem) },
                    ]}
                  />
                  <BarChart title={t('stats.o.utilization')} unit="%" max={100} labels={labels} series={[{ name: t('stats.o.utilization'), color: C1, values: s!.days.map((d) => d.utilization ?? 0) }]} />
                  <BarChart title={t('stats.o.distance')} unit="m" labels={labels} series={[{ name: t('stats.o.distance'), color: C1, values: s!.days.map((d) => Math.round(d.distanceM)) }]} />
                </div>

                <h3>{t('stats.details')}</h3>
                <table>
                  <tbody>
                    <tr>
                      <td className="band" colSpan={5}>
                        {t('stats.d.schedules')}
                      </td>
                    </tr>
                    <tr>
                      <th>{t('stats.d.name')}</th>
                      <th>{t('stats.d.path')}</th>
                      <th>{t('stats.d.time')}</th>
                      <th>{t('stats.d.robot')}</th>
                      <th>{t('stats.d.enabled')}</th>
                    </tr>
                    {s!.schedules.length === 0 && (
                      <tr>
                        <td colSpan={5} className="muted">
                          {t('stats.none')}
                        </td>
                      </tr>
                    )}
                    {s!.schedules.map((x) => (
                      <tr key={x.id}>
                        <td>{x.name}</td>
                        <td>{x.pathName ?? '—'}</td>
                        <td>
                          {x.startTime}（{tr(`stats.repeat.${x.repeat}`, x.repeat)}）
                        </td>
                        <td>{x.robotCode ?? t('stats.d.auto')}</td>
                        <td>{x.enabled ? '✓' : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <table>
                  <tbody>
                    <tr>
                      <td className="band" colSpan={9}>
                        {t('stats.d.daily')}
                      </td>
                    </tr>
                    <tr>
                      <th>{t('stats.d.date')}</th>
                      <th>{t('stats.o.done')}</th>
                      <th>{t('stats.c.notDone')}</th>
                      <th>{t('stats.o.business')}</th>
                      <th>{t('stats.o.system')}</th>
                      <th>{t('stats.d.distance')}</th>
                      <th>{t('stats.d.busy')}</th>
                      <th>{t('stats.d.charging')}</th>
                      <th>{t('stats.o.utilization')}</th>
                    </tr>
                    {s!.days.map((d) => (
                      <tr key={d.date}>
                        <td>{d.date}</td>
                        <td>{d.tasksDone}</td>
                        <td>{d.tasksFailed + d.tasksCancelled}</td>
                        <td>{d.alarmsBusiness}</td>
                        <td>{d.alarmsSystem}</td>
                        <td>{d.distanceM.toFixed(0)}</td>
                        <td>{d.busyH.toFixed(2)}</td>
                        <td>{d.chargingH.toFixed(2)}</td>
                        <td>{pct(d.utilization)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <table>
                  <tbody>
                    <tr>
                      <td className="band" colSpan={6}>
                        {t('stats.d.robots')}
                      </td>
                    </tr>
                    <tr>
                      <th>{t('stats.d.robot')}</th>
                      <th>{t('stats.d.floor')}</th>
                      <th>{t('stats.o.done')}</th>
                      <th>{t('stats.d.distance')}</th>
                      <th>{t('stats.o.utilization')}</th>
                      <th>{t('stats.o.availability')}</th>
                    </tr>
                    {s!.robots.map((r) => (
                      <tr key={r.id}>
                        <td>{r.code}</td>
                        <td>{floorName(r.floorId)}</td>
                        <td>{r.tasksDone}</td>
                        <td>{r.distanceM.toFixed(0)}</td>
                        <td>{pct(r.utilization)}</td>
                        <td>{pct(r.availability)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <table>
                  <tbody>
                    <tr>
                      <td className="band">{t('stats.d.alarmHandling')}</td>
                    </tr>
                    <tr>
                      <td>
                        {alarmTotal === 0 ? (
                          <span className="muted">{t('stats.none')}</span>
                        ) : (
                          <div className="pie">
                            <Donut parts={statusRows.map(([k, v]) => ({ v, c: STATUS_COLOR[k] ?? '#9ca3af' }))} total={alarmTotal} />
                            <ul>
                              {statusRows.map(([k, v]) => (
                                <li key={k}>
                                  <i style={{ background: STATUS_COLOR[k] ?? '#9ca3af' }} />
                                  {tr(`alarm.status.${k}`, k)} {v}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </>
            )}
          </article>
        </div>
      </section>
      <aside className="panel filt">
        <div className="scroll">
          <div className="filt-in">
            <div className="radios" role="radiogroup" aria-label={t('stats.kind')}>
              {KINDS.map((k) => (
                <label key={k}>
                  <input
                    type="radio"
                    name="stk"
                    checked={kind === k}
                    onChange={() => {
                      setKind(k);
                      setPeriod(0);
                    }}
                  />
                  {t(`stats.kind.${k}`)}
                </label>
              ))}
            </div>
            {kind === 'custom' ? (
              <div className="fl">
                {t('stats.period')}
                <div className="trange">
                  <input type="date" aria-label={`${t('stats.period')}（起）`} value={custom.from} max={custom.to} onChange={(e) => e.target.value && setCustom({ ...custom, from: e.target.value })} />
                  <span>~</span>
                  <input type="date" aria-label={`${t('stats.period')}（迄）`} value={custom.to} min={custom.from} max={today} onChange={(e) => e.target.value && setCustom({ ...custom, to: e.target.value })} />
                </div>
              </div>
            ) : (
              <label className="fl">
                {t('stats.period')}
                <select value={period} onChange={(e) => setPeriod(Number(e.target.value))}>
                  {opts.map((p, i) => (
                    <option key={p.from} value={i}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="fl">
              {t('report.floor')}
              <select
                value={floorId}
                onChange={(e) => {
                  setFloorId(e.target.value);
                  setRobotId('');
                }}
              >
                <option value="">{t('report.allFloors')}</option>
                {floors.data?.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="fl">
              {t('report.robot')}
              <select value={robotId} onChange={(e) => setRobotId(e.target.value)}>
                <option value="">{t('report.allRobots')}</option>
                {robots.data
                  ?.filter((r) => !floorId || r.floorId === floorId)
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.code}
                    </option>
                  ))}
              </select>
            </label>
            <button type="button" className="go2 warn" onClick={() => void exportXlsx()} disabled={busy || !s}>
              {t('stats.export')}
            </button>
            <button type="button" className="go2" onClick={() => window.print()} disabled={!s}>
              {t('report.print')}
            </button>
            <p className="hint">{t('stats.hint')}</p>
          </div>
        </div>
      </aside>
    </div>
  );
}

/** 環狀圖（原型告警處理比例）：每段一個狀態，旁邊列出狀態名稱與數量 */
function Donut({ parts, total }: { parts: { v: number; c: string }[]; total: number }) {
  let a = -Math.PI / 2;
  const P = (ang: number, r: number) => `${100 + r * Math.cos(ang)},${100 + r * Math.sin(ang)}`;
  return (
    <svg viewBox="0 0 200 200" role="img" aria-label={t('stats.d.alarmHandling')}>
      {parts.map((p, i) => {
        if (!p.v) return null;
        if (p.v === total) return <circle key={i} cx="100" cy="100" r="70" fill="none" stroke={p.c} strokeWidth="40" />;
        const a2 = a + (p.v / total) * Math.PI * 2;
        const large = a2 - a > Math.PI ? 1 : 0;
        const d = `M${P(a, 90)}A90,90 0 ${large} 1 ${P(a2, 90)}L${P(a2, 50)}A50,50 0 ${large} 0 ${P(a, 50)}Z`;
        a = a2;
        return <path key={i} d={d} fill={p.c} stroke="#fff" strokeWidth="2" />;
      })}
      <text x="100" y="96" textAnchor="middle" fontSize="13" fill="#6b7280">
        {t('stats.total')}
      </text>
      <text x="100" y="118" textAnchor="middle" fontSize="20" fontWeight="700" fill="#111827">
        {total}
      </text>
    </svg>
  );
}
