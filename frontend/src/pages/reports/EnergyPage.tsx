import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api/client';
import { LineChart } from '../../components/LineChart';
import { formatTime, t } from '../../i18n';
import { dayRange, taipeiDate } from './time';

interface RobotRow {
  id: string;
  code: string;
}
interface EnergyPoint {
  at: string;
  battery: number | null;
  voltage: number | null;
  current: number | null;
  consumption: number | null;
  charging: boolean;
}
interface ChargeRow {
  id: string;
  startedAt: string;
  endedAt: string | null;
  startPct: number | null;
  endPct: number | null;
  mode: string;
  chargerCode: string | null;
  minutes: number;
}
export interface EnergyResp {
  code: string;
  bucketSec: number;
  points: EnergyPoint[];
  charges: ChargeRow[];
  summary: { chargeCount: number; chargeMinutes: number; avgChargeMinutes: number | null; chargedPct: number; chargeRatePctH: number | null; usedPct: number };
}

/** 原型的四張曲線：電壓、電量、耗電量、電流（顏色沿用原型） */
const CARDS = [
  { key: 'voltage', title: 'energy.voltage', unit: 'V', color: '#38bdf8' },
  { key: 'battery', title: 'energy.battery', unit: '%', color: '#22d3ee', yMin: 0, yMax: 100 },
  { key: 'consumption', title: 'energy.consumption', unit: '%/h', color: '#a78bfa' },
  { key: 'current', title: 'energy.current', unit: 'A', color: '#fbbf24' },
] as const;

const RT_WINDOW_MS = 60_000;
const RT_POLL_MS = 2_000;

/**
 * 能耗管理（/energy，原型「能耗管理」）：實時（最近 1 分鐘、每 2 秒更新）與歷史（選日期、時段）曲線，
 * 歷史模式下方列出充電紀錄與統計（charge_sessions）。資料來自遙測（電量、電壓、電流），耗電量由電量變化推算。
 */
export function EnergyPage() {
  const robots = useQuery({ queryKey: ['robots', 'list'], queryFn: () => api<RobotRow[]>('/robots') });
  const [robotId, setRobotId] = useState('');
  const [mode, setMode] = useState<'rt' | 'hist'>('rt');
  const [date, setDate] = useState(taipeiDate());
  const [from, setFrom] = useState('00:00');
  const [to, setTo] = useState('23:59');
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!robotId && robots.data?.length) setRobotId(robots.data[0].id);
  }, [robots.data, robotId]);
  useEffect(() => {
    if (mode !== 'rt') return;
    const id = setInterval(() => setNow(Date.now()), RT_POLL_MS);
    return () => clearInterval(id);
  }, [mode]);

  const range = useMemo(
    () => (mode === 'rt' ? { from: new Date(now - RT_WINDOW_MS).toISOString(), to: new Date(now).toISOString() } : dayRange(date, from, to)),
    [mode, now, date, from, to],
  );
  const data = useQuery({
    queryKey: ['energy', robotId, range.from, range.to],
    queryFn: () => api<EnergyResp>(`/energy/${robotId}?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`),
    enabled: !!robotId,
    placeholderData: (prev) => prev,
  });

  const domain: [number, number] = [new Date(range.from).getTime(), Math.min(new Date(range.to).getTime(), Math.max(now, new Date(range.from).getTime() + 1))];
  const code = robots.data?.find((r) => r.id === robotId)?.code ?? '';
  const gap = Math.max(10_000, (data.data?.bucketSec ?? 2) * 3000);
  const s = data.data?.summary;

  return (
    <div className="pg2">
      <section className="panel">
        <div className="pane-head">
          <div className="seg2" role="tablist">
            {(['rt', 'hist'] as const).map((m) => (
              <button key={m} type="button" role="tab" aria-selected={mode === m} className={mode === m ? 'on' : ''} onClick={() => setMode(m)}>
                {t(`energy.mode.${m}`)}
              </button>
            ))}
          </div>
          <span className="meta">{code && (mode === 'rt' ? t('energy.meta.rt', { code }) : t('energy.meta.hist', { code, date }))}</span>
        </div>
        <div className="scroll">
          <div className="chart-grid">
            {CARDS.map((c) => (
              <LineChart
                key={c.key}
                title={t(c.title)}
                unit={c.unit}
                color={c.color}
                yMin={'yMin' in c ? c.yMin : undefined}
                yMax={'yMax' in c ? c.yMax : undefined}
                domain={domain}
                gapMs={gap}
                points={(data.data?.points ?? []).map((p) => ({ t: new Date(p.at).getTime(), v: p[c.key] }))}
              />
            ))}
          </div>
          {mode === 'hist' && s && (
            <div className="pane-body en-charge">
              <h3>{t('energy.charge.title')}</h3>
              <div className="en-stats">
                <Stat label={t('energy.charge.count')} value={String(s.chargeCount)} unit={t('energy.unit.times')} />
                <Stat label={t('energy.charge.minutes')} value={String(s.chargeMinutes)} unit={t('energy.unit.min')} />
                <Stat label={t('energy.charge.avg')} value={s.avgChargeMinutes == null ? '—' : String(s.avgChargeMinutes)} unit={t('energy.unit.min')} />
                <Stat label={t('energy.charge.gained')} value={String(s.chargedPct)} unit="%" />
                <Stat label={t('energy.charge.rate')} value={s.chargeRatePctH == null ? '—' : String(s.chargeRatePctH)} unit="%/h" />
                <Stat label={t('energy.used')} value={String(s.usedPct)} unit="%" />
              </div>
              <div className="tbl-wrap">
                <table className="dtbl">
                  <thead>
                    <tr>
                      <th>{t('alarm.col.no')}</th>
                      <th>{t('energy.col.start')}</th>
                      <th>{t('energy.col.end')}</th>
                      <th>{t('energy.col.minutes')}</th>
                      <th>{t('energy.col.pct')}</th>
                      <th>{t('energy.col.charger')}</th>
                      <th>{t('energy.col.mode')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.data!.charges.length === 0 && (
                      <tr>
                        <td colSpan={7} className="tbl-empty">
                          {t('energy.charge.empty')}
                        </td>
                      </tr>
                    )}
                    {data.data!.charges.map((c, i) => (
                      <tr key={c.id}>
                        <td>{i + 1}</td>
                        <td className="mono">{formatTime(c.startedAt)}</td>
                        <td className="mono">{c.endedAt ? formatTime(c.endedAt) : t('energy.charging')}</td>
                        <td className="num">{c.minutes}</td>
                        <td className="mono">
                          {c.startPct ?? '—'}% → {c.endPct == null ? '—' : `${c.endPct}%`}
                        </td>
                        <td className="mono">{c.chargerCode ?? '—'}</td>
                        <td>{t(c.mode === 'manual' ? 'settings.chargeMode.manual' : 'settings.chargeMode.auto')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </section>
      <aside className="panel filt">
        <div className="scroll">
          <div className="filt-in">
            <label className="fl">
              {t('energy.robot')}
              <select value={robotId} onChange={(e) => setRobotId(e.target.value)}>
                {robots.data?.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.code}
                  </option>
                ))}
              </select>
            </label>
            {mode === 'hist' && (
              <>
                <label className="fl">
                  {t('energy.date')}
                  <input type="date" value={date} max={taipeiDate()} onChange={(e) => e.target.value && setDate(e.target.value)} />
                </label>
                <div className="fl">
                  {t('energy.time')}
                  <div className="trange">
                    <input type="time" aria-label={t('energy.time.from')} value={from} onChange={(e) => setFrom(e.target.value || '00:00')} />
                    <span>~</span>
                    <input type="time" aria-label={t('energy.time.to')} value={to} onChange={(e) => setTo(e.target.value || '23:59')} />
                  </div>
                </div>
              </>
            )}
            <p className="hint">{t(mode === 'rt' ? 'energy.hint.rt' : 'energy.hint.hist')}</p>
          </div>
        </div>
      </aside>
    </div>
  );
}

function Stat({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div className="en-stat">
      <span>{label}</span>
      <b>
        {value}
        <small>{unit}</small>
      </b>
    </div>
  );
}
