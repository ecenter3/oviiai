import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../../api/client';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { t, type MessageKey } from '../../i18n';
import { useAuth } from '../../stores/auth';
import type { DispatchMode } from '../../stores/tasks';
import { useToast } from '../../stores/toast';

interface Floor {
  id: string;
  name: string;
  robotQuota: number;
}
interface SettingsResp {
  values: Record<string, unknown>;
  defaults: Record<string, unknown>;
  brands: string[];
}
interface RobotRow {
  floorId: string;
  model: string;
}

type Values = Record<string, unknown>;

/** 回充 < 接單 < 充電完成（與後端相同） */
export function chargeOrderOk(v: Values): boolean {
  const r = Number(v['charge.returnAt']);
  const a = Number(v['charge.minAccept']);
  const c = Number(v['charge.resumeAt']);
  return r < a && a < c;
}

const brandLabel = (b: string) => {
  const key = `brand.${b}` as MessageKey;
  return t(key) === key ? b : t(key);
};

/**
 * 派工與充電規則（/settings，原型「系統設定」）：樓層配置台數、充電策略、充電方式（各品牌）、派工規則。
 * 儲存後立即生效。關閉審批時若有待審批任務，先確認「會立即派出幾筆」（PR #7 審查第 3 點）。
 */
export function SettingsPage() {
  const qc = useQueryClient();
  const canEdit = useAuth((s) => s.can('op.config'));
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api<SettingsResp>('/settings') });
  const floors = useQuery({ queryKey: ['floors'], queryFn: () => api<Floor[]>('/floors') });
  const robots = useQuery({ queryKey: ['robots', 'list'], queryFn: () => api<RobotRow[]>('/robots'), retry: false });
  const cameras = useQuery({ queryKey: ['cameras', 'all'], queryFn: () => api<{ floorId: string }[]>('/cameras'), retry: false });
  const [v, setV] = useState<Values>({});
  const [quota, setQuota] = useState<Record<string, number>>({});
  const [confirm, setConfirm] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (settings.data) setV(settings.data.values);
  }, [settings.data]);
  useEffect(() => {
    if (floors.data) setQuota(Object.fromEntries(floors.data.map((f) => [f.id, f.robotQuota])));
  }, [floors.data]);

  const set = (k: string, val: unknown) => setV((s) => ({ ...s, [k]: val }));
  const num = (k: string) => Number(v[k] ?? 0);
  const orderOk = chargeOrderOk(v);

  const changed = useMemo(() => {
    const orig = settings.data?.values ?? {};
    return Object.fromEntries(Object.entries(v).filter(([k, val]) => JSON.stringify(orig[k]) !== JSON.stringify(val)));
  }, [v, settings.data]);
  const quotaChanged = (floors.data ?? []).filter((f) => quota[f.id] !== undefined && quota[f.id] !== f.robotQuota);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!orderOk) return setError(t('settings.error.order'));
    // 審批由開改關：有待審批任務時先確認
    if (settings.data?.values['dispatch.approval'] === true && changed['dispatch.approval'] === false) {
      const mode = await api<DispatchMode>('/dispatch/mode');
      if (mode.pending > 0) return setConfirm(mode.pending);
    }
    await save();
  }

  async function save() {
    setConfirm(null);
    setBusy(true);
    try {
      let released = 0;
      if (Object.keys(changed).length) {
        const r = await api<{ released: number }>('/settings', { method: 'PUT', json: { values: changed } });
        released = r.released;
      }
      for (const f of quotaChanged) await api(`/floors/${f.id}`, { method: 'PUT', json: { robotQuota: quota[f.id] } });
      useToast.getState().show(t('settings.saved'), 'ok');
      if (released) useToast.getState().show(t('settings.released', { n: released }), 'warn');
      await Promise.all(['settings', 'floors', 'dispatch'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    if (!settings.data) return;
    setV({ ...v, ...settings.data.defaults });
  }

  if (!settings.data) return <div className="page muted">{t('common.loading')}</div>;
  const robotsOf = (f: string) => (robots.data ?? []).filter((r) => r.floorId === f);

  return (
    <div className="page">
      <h1 className="page-h">{t('settings.title')}</h1>
      {!canEdit && <p className="notice">{t('settings.readonly')}</p>}
      <form className="sgrid" onSubmit={submit} noValidate>
        <fieldset disabled={!canEdit} className="contents">
          <section className="dcard wide">
            <h3>{t('settings.floors')}</h3>
            <table className="ftable">
              <thead>
                <tr>
                  <th>{t('settings.floors.floor')}</th>
                  <th>{t('settings.floors.quota')}</th>
                  <th>{t('settings.floors.registered')}</th>
                  <th>{t('settings.floors.models')}</th>
                  <th>{t('settings.floors.cameras')}</th>
                </tr>
              </thead>
              <tbody>
                {(floors.data ?? []).map((f) => (
                  <tr key={f.id}>
                    <td>{f.name}</td>
                    <td>
                      <input
                        type="number"
                        min={0}
                        max={100}
                        aria-label={`${f.name} ${t('settings.floors.quota')}`}
                        value={quota[f.id] ?? f.robotQuota}
                        onChange={(e) => setQuota((q) => ({ ...q, [f.id]: Math.max(0, Number(e.target.value)) }))}
                      />
                    </td>
                    <td className="mono">{robotsOf(f.id).length}</td>
                    <td>{[...new Set(robotsOf(f.id).map((r) => r.model))].join('、') || '—'}</td>
                    <td className="mono">{(cameras.data ?? []).filter((c) => c.floorId === f.id).length}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>{t('settings.floors.total')}</td>
                  <td>{Object.values(quota).reduce((a, b) => a + b, 0)}</td>
                  <td>{robots.data?.length ?? '—'}</td>
                  <td />
                  <td>{cameras.data?.length ?? '—'}</td>
                </tr>
              </tfoot>
            </table>
            <p className="hint">{t('settings.floors.hint')}</p>
          </section>

          <section className="dcard">
            <h3>{t('settings.charge')}</h3>
            <div className="two">
              {(['returnAt', 'minAccept', 'resumeAt'] as const).map((k) => (
                <div className="field" key={k}>
                  <label htmlFor={`c-${k}`}>{t(`settings.charge.${k}` as MessageKey)}</label>
                  <div className="unit">
                    <input
                      id={`c-${k}`}
                      type="number"
                      inputMode="numeric"
                      aria-invalid={!orderOk}
                      value={num(`charge.${k}`)}
                      onChange={(e) => set(`charge.${k}`, Number(e.target.value))}
                    />
                  </div>
                </div>
              ))}
            </div>
            <ChargeScale returnAt={num('charge.returnAt')} minAccept={num('charge.minAccept')} resumeAt={num('charge.resumeAt')} />
            <div className="scale-legend">
              <span>
                <i style={{ background: 'rgba(239,68,68,.55)' }} />
                {t('settings.charge.z1')}
              </span>
              <span>
                <i style={{ background: 'rgba(245,158,11,.5)' }} />
                {t('settings.charge.z2')}
              </span>
              <span>
                <i style={{ background: 'rgba(34,197,94,.45)' }} />
                {t('settings.charge.z3')}
              </span>
            </div>
            <p className="hint">{t('settings.charge.hint')}</p>

            <h3 className="sub">{t('settings.chargeMode')}</h3>
            {settings.data.brands.map((b) => (
              <div className="field" key={b}>
                <label htmlFor={`mode-${b}`}>{brandLabel(b)}</label>
                <select id={`mode-${b}`} value={String(v[`charge.mode.${b}`] ?? 'auto')} onChange={(e) => set(`charge.mode.${b}`, e.target.value)}>
                  <option value="auto">{t('settings.chargeMode.auto')}</option>
                  <option value="manual">{t('settings.chargeMode.manual')}</option>
                </select>
              </div>
            ))}
            <p className="hint">{t('settings.chargeMode.hint')}</p>
          </section>

          <section className="dcard">
            <h3>{t('settings.dispatch')}</h3>
            <label className="toggle">
              <span className="txt">
                <strong>{t('settings.preempt')}</strong>
                <span>{t('settings.preempt.body')}</span>
              </span>
              <span className="switch">
                <input type="checkbox" checked={v['dispatch.p1Preempt'] === true} onChange={(e) => set('dispatch.p1Preempt', e.target.checked)} />
                <i />
              </span>
            </label>
            <label className="toggle">
              <span className="txt">
                <strong>{t('settings.approval')}</strong>
                <span>{t('settings.approval.body')}</span>
              </span>
              <span className="switch">
                <input type="checkbox" aria-label={t('settings.approval')} checked={v['dispatch.approval'] === true} onChange={(e) => set('dispatch.approval', e.target.checked)} />
                <i />
              </span>
            </label>
            <div className="field">
              <label htmlFor="cUntil">{t('settings.approvalUntil')}</label>
              <input
                id="cUntil"
                type="date"
                value={String(v['dispatch.approvalUntil'] ?? '')}
                onChange={(e) => set('dispatch.approvalUntil', e.target.value || null)}
                disabled={v['dispatch.approval'] !== true}
              />
            </div>
            <div className="toggle block">
              <span className="txt">
                <strong>{t('settings.aiConf')}</strong>
                <span>{t('settings.aiConf.body')}</span>
              </span>
              <div className="conf-row">
                <input
                  type="range"
                  min={30}
                  max={95}
                  step={5}
                  aria-label={t('settings.aiConf')}
                  value={num('alarm.aiConfidence')}
                  onChange={(e) => set('alarm.aiConfidence', Number(e.target.value))}
                />
                <b>{num('alarm.aiConfidence')}%</b>
              </div>
            </div>
            <div className="toggle block">
              <span className="txt">
                <strong>{t('settings.teleopIdle')}</strong>
                <span>{t('settings.teleopIdle.body')}</span>
              </span>
              <div className="conf-row">
                <input
                  type="range"
                  min={60}
                  max={1800}
                  step={60}
                  aria-label={t('settings.teleopIdle')}
                  value={num('teleop.idleSec') || 300}
                  onChange={(e) => set('teleop.idleSec', Number(e.target.value))}
                />
                <b>{t('settings.minutes', { n: Math.round((num('teleop.idleSec') || 300) / 60) })}</b>
              </div>
            </div>
          </section>
        </fieldset>

        <div className="save-bar wide">
          <span className="err" role="alert">
            {error ?? (!orderOk ? t('settings.error.order') : '')}
          </span>
          <button type="button" className="btn" onClick={reset} disabled={!canEdit}>
            {t('settings.reset')}
          </button>
          <button type="submit" className="btn primary" disabled={!canEdit || busy || (!Object.keys(changed).length && !quotaChanged.length)}>
            {t('settings.save')}
          </button>
        </div>
      </form>

      {confirm !== null && (
        <ConfirmDialog
          title={t('settings.approvalOffTitle')}
          body={t('settings.approvalOffBody', { n: confirm })}
          confirmText={t('settings.approvalOffConfirm')}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void save()}
        />
      )}
    </div>
  );
}

/** 原型的電量刻度：紅（立即回充）｜橘（不接新任務）｜綠（可接任務） */
function ChargeScale({ returnAt, minAccept, resumeAt }: { returnAt: number; minAccept: number; resumeAt: number }) {
  const c = (n: number) => Math.max(0, Math.min(100, n));
  return (
    <div className="scale" aria-hidden="true">
      <div className="z1" style={{ width: `${c(returnAt)}%` }} />
      <div className="z2" style={{ width: `${Math.max(0, c(minAccept) - c(returnAt))}%` }} />
      <div className="z3" style={{ width: `${Math.max(0, 100 - c(minAccept))}%` }} />
      {[returnAt, minAccept, resumeAt].map((m, i) => (
        <div key={i} className="mark" style={{ left: `${c(m)}%` }}>
          <span>{m}%</span>
        </div>
      ))}
    </div>
  );
}
