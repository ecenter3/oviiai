import {
  PARAM_SCHEMA,
  PARAM_SUBSYSTEMS,
  REACT_ACTIONS,
  isParamField,
  subsystemSchema,
  type ParamField,
  type ParamSubsystem,
  type RobotParams,
  type SubsystemValues,
} from '@oviiai/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../api/client';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { t, type MessageKey } from '../../i18n';
import { useAuth } from '../../stores/auth';
import { useToast } from '../../stores/toast';

interface RobotOpt {
  id: string;
  code: string;
  floorId: string;
}
interface Floor {
  id: string;
  name: string;
}
type Sync = 'sent' | 'offline' | 'failed';

const ICON: Record<ParamSubsystem, ReactNode> = {
  walk: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v6M12 15v6M3 12h6M15 12h6" />
    </svg>
  ),
  video: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <rect x="7" y="9" width="7" height="6" rx="1" />
      <path d="M14 11l3-2v6l-3-2" />
    </svg>
  ),
  talk: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M8 10h8M8 13h5" />
    </svg>
  ),
  ext: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="3" />
      <path d="M12 6v2M12 16v2M6 12h2M16 12h2" />
    </svg>
  ),
};

const label = (k: string) => t(`params.f.${k}` as MessageKey);
const tipOf = (k: string): string | null => {
  const key = `params.tip.${k}` as MessageKey;
  const s = t(key);
  return s === key ? null : s;
};
const opt = (o: string) => t(`params.opt.${o}` as MessageKey);
const unitOf = (u?: string) => (u === 's' ? t('params.unit.s') : (u ?? ''));

/** 每個欄位第一個錯誤訊息（依 contracts 的 subsystemSchema，與後端同一份） */
function errorsOf(sub: ParamSubsystem, values: SubsystemValues | null): Record<string, string> {
  if (!values) return {};
  const r = subsystemSchema(sub).safeParse(values);
  if (r.success) return {};
  const out: Record<string, string> = {};
  for (const i of r.error.issues) {
    const k = String(i.path[0] ?? '');
    const f = PARAM_SCHEMA[sub].find((x) => isParamField(x) && x.k === k) as ParamField | undefined;
    out[k] ??= f && (f.t === 'num' || f.t === 'slider') ? t('params.range', { min: f.min, max: f.max }) : i.message;
  }
  return out;
}

/**
 * 機器人參數（/params，原型「機器人參數」；T-27）：四個子系統表單，儲存後送到機器人；可套用到同樓層全部機器人。
 * 欄位、選項、範圍都來自 @oviiai/contracts 的 PARAM_SCHEMA（後端用同一份驗證）。
 */
export function ParamsPage() {
  const qc = useQueryClient();
  const can = useAuth((s) => s.can);
  const canEdit = can('op.config');
  const robots = useQuery({ queryKey: ['robots', 'list'], queryFn: () => api<RobotOpt[]>('/robots') });
  const floors = useQuery({ queryKey: ['floors'], queryFn: () => api<Floor[]>('/floors') });
  const [robotId, setRobotId] = useState<string | null>(null);
  const [sub, setSub] = useState<ParamSubsystem>('walk');
  const [form, setForm] = useState<SubsystemValues | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);

  const list = robots.data ?? [];
  const rid = robotId ?? list[0]?.id ?? null;
  const robot = list.find((r) => r.id === rid);
  const floorName = (id?: string) => floors.data?.find((f) => f.id === id)?.name ?? id ?? '';
  const sameFloor = list.filter((r) => r.floorId === robot?.floorId);

  const data = useQuery({
    queryKey: ['params', rid],
    queryFn: () => api<{ code: string; floorId: string; params: RobotParams; chargeReturnAt: number }>(`/robots/${rid}/params`),
    enabled: !!rid,
  });
  const saved = data.data?.params[sub] ?? null;
  // 換機器人、換子系統、重新載入：表單回到已儲存的值
  useEffect(() => setForm(saved ? structuredClone(saved) : null), [saved]);

  const errs = useMemo(() => errorsOf(sub, form), [sub, form]);
  const dirty = !!form && !!saved && JSON.stringify(form) !== JSON.stringify(saved);
  const set = (k: string, v: unknown) => setForm((f) => (f ? { ...f, [k]: v } : f));

  async function save(): Promise<boolean> {
    if (!rid || !form || Object.keys(errs).length) return false;
    setBusy(true);
    try {
      const r = await api<{ sync: Sync; params: RobotParams }>(`/robots/${rid}/params`, { method: 'PUT', json: { subsystem: sub, values: form } });
      qc.setQueryData(['params', rid], (old: { params: RobotParams } | undefined) => (old ? { ...old, params: r.params } : old));
      const code = robot?.code ?? '';
      const key = r.sync === 'sent' ? 'params.saved' : r.sync === 'offline' ? 'params.savedOffline' : 'params.savedFailed';
      useToast.getState().show(t(key, { code }), r.sync === 'sent' ? 'ok' : 'warn');
      return true;
    } catch (e) {
      useToast.getState().show(e instanceof ApiError ? e.message : String(e), 'error');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function applyFloor() {
    if (!robot) return;
    if (!(await save())) return;
    setBusy(true);
    try {
      const r = await api<{ updated: number; results: { code: string; sync: Sync }[] }>('/robots/params/apply-floor', {
        method: 'POST',
        json: { fromRobotId: robot.id, floorId: robot.floorId, subsystem: sub },
      });
      await qc.invalidateQueries({ queryKey: ['params'] });
      const sent = r.results.filter((x) => x.sync === 'sent').length;
      useToast.getState().show(t('params.applied', { floor: floorName(robot.floorId), n: r.updated, sent, offline: r.updated - sent }), 'ok');
    } catch (e) {
      useToast.getState().show(e instanceof ApiError ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  const returnAt = data.data?.chargeReturnAt;

  return (
    <div className="pg2">
      <section className="panel">
        <div className="pane-head">
          <span className="title">{t(`params.title.${sub}`)}</span>
          <span className="meta">{robot ? `${robot.code} · ${floorName(robot.floorId)}` : ''}</span>
        </div>
        <div className="scroll">
          {!list.length && !robots.isLoading && <p className="empty-state">{t('params.noRobot')}</p>}
          {form && (
            <fieldset className="pform" disabled={!canEdit || busy} aria-label={t(`params.title.${sub}`)}>
              {sub === 'walk' && (
                <div className="prow">
                  <label>{t('params.return')}</label>
                  <div className="ctl2">
                    <span className="rv">{typeof returnAt === 'number' ? `${returnAt}%` : '—'}</span>
                    <span>{t('params.return.note')}</span>
                    {can('settings') && (
                      <Link className="obtn" to="/settings">
                        {t('params.return.go')}
                      </Link>
                    )}
                  </div>
                </div>
              )}
              {PARAM_SCHEMA[sub].map((it) =>
                isParamField(it) ? (
                  <Field key={it.k} f={it} value={form[it.k]} error={errs[it.k]} onChange={(v) => set(it.k, v)} />
                ) : (
                  <div key={it.sec} className="psec">
                    {t(`params.sec.${it.sec}` as MessageKey)}
                  </div>
                ),
              )}
            </fieldset>
          )}
        </div>
        <div className="pane-head pfoot">
          <span className="meta">{!canEdit ? t('params.readonly') : dirty ? t('params.dirty') : t('params.sdkNote')}</span>
          {canEdit && (
            <>
              <button type="button" className="obtn" disabled={busy || !form || !!Object.keys(errs).length} onClick={() => setConfirm(true)}>
                {t('params.applyFloor')}
              </button>
              <button type="button" className="btn primary" disabled={busy || !form || !!Object.keys(errs).length} onClick={() => void save()}>
                {t('params.save')}
              </button>
            </>
          )}
        </div>
      </section>
      <aside className="panel filt">
        <div className="scroll">
          <div className="filt-in">
            <label className="fl">
              {t('params.robot')}
              <select value={rid ?? ''} onChange={(e) => setRobotId(e.target.value)}>
                {list.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.code} · {floorName(r.floorId)}
                  </option>
                ))}
              </select>
            </label>
            <div className="subsys" role="tablist" aria-label={t('page.params')}>
              {PARAM_SUBSYSTEMS.map((s) => (
                <button key={s} type="button" role="tab" aria-selected={s === sub} className={s === sub ? 'on' : ''} onClick={() => setSub(s)}>
                  {ICON[s]}
                  {t(`params.sub.${s}`)}
                </button>
              ))}
            </div>
          </div>
        </div>
      </aside>
      {confirm && robot && (
        <ConfirmDialog
          title={t('params.applyFloor')}
          body={t('params.applyConfirm', { sub: t(`params.title.${sub}`), floor: floorName(robot.floorId), n: sameFloor.length })}
          confirmText={t('params.apply')}
          onCancel={() => setConfirm(false)}
          onConfirm={() => {
            setConfirm(false);
            void applyFloor();
          }}
        />
      )}
    </div>
  );
}

function Field({ f, value, error, onChange }: { f: ParamField; value: unknown; error?: string; onChange(v: unknown): void }) {
  const l = label(f.k);
  const tip = tipOf(f.k);
  const name = `p_${f.k}`;
  let c: ReactNode = null;
  switch (f.t) {
    case 'slider':
      c = (
        <>
          <input type="range" min={f.min} max={f.max} step={f.step} value={Number(value)} aria-label={l} onChange={(e) => onChange(Number(e.target.value))} />
          <span className="rv">
            {Number(value)}
            {f.unit ? ` ${f.unit}` : ''}
          </span>
        </>
      );
      break;
    case 'num':
      c = (
        <>
          <input
            type="number"
            min={f.min}
            max={f.max}
            style={{ width: 110 }}
            value={Number.isFinite(value) ? Number(value) : ''}
            aria-label={l}
            aria-invalid={!!error}
            onChange={(e) => onChange(e.target.value === '' ? Number.NaN : Number(e.target.value))}
          />
          <span>{unitOf(f.unit)}</span>
        </>
      );
      break;
    case 'switch':
      c = (
        <span className="switch sm">
          <input type="checkbox" checked={!!value} aria-label={l} onChange={(e) => onChange(e.target.checked)} />
          <i />
        </span>
      );
      break;
    case 'radio':
      c = f.opts.map((o) => (
        <label key={o} className="opt">
          <input type="radio" name={name} value={o} checked={value === o} onChange={() => onChange(o)} />
          {opt(o)}
        </label>
      ));
      break;
    case 'checks': {
      const arr = Array.isArray(value) ? (value as string[]) : [];
      c = f.opts.map((o) => (
        <label key={o} className="opt">
          <input type="checkbox" value={o} checked={arr.includes(o)} onChange={(e) => onChange(e.target.checked ? f.opts.filter((x) => x === o || arr.includes(x)) : arr.filter((x) => x !== o))} />
          {opt(o)}
        </label>
      ));
      break;
    }
    case 'time2': {
      const [a, b] = Array.isArray(value) ? (value as string[]) : ['', ''];
      c = (
        <>
          <input type="time" value={a} aria-label={`${l}${t('params.time.start')}`} onChange={(e) => onChange([e.target.value, b])} />
          <span>～</span>
          <input type="time" value={b} aria-label={`${l}${t('params.time.end')}`} onChange={(e) => onChange([a, e.target.value])} />
        </>
      );
      break;
    }
    case 'text':
      c = <textarea maxLength={f.max} value={String(value ?? '')} aria-label={l} onChange={(e) => onChange(e.target.value)} />;
      break;
    case 'react': {
      const [act, on] = Array.isArray(value) ? (value as [string, boolean]) : ['none', false];
      c = (
        <>
          <select value={act} aria-label={l} onChange={(e) => onChange([e.target.value, on])}>
            {REACT_ACTIONS.map((a) => (
              <option key={a} value={a}>
                {t(`params.react.${a}`)}
              </option>
            ))}
          </select>
          <span>{t('params.interact')}</span>
          <span className="switch sm">
            <input type="checkbox" checked={on} aria-label={`${l}${t('params.interact')}`} onChange={(e) => onChange([act, e.target.checked])} />
            <i />
          </span>
        </>
      );
      break;
    }
  }
  return (
    <div className="prow">
      <label>
        {l}
        {tip && (
          <i title={tip} aria-label={tip}>
            ⓘ
          </i>
        )}
      </label>
      <div className="ctl2">
        {c}
        {error && (
          <span className="err2" role="alert">
            {error}
          </span>
        )}
      </div>
    </div>
  );
}
