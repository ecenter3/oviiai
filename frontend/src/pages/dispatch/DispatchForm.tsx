import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { api, ApiError } from '../../api/client';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import type { Pt } from '../../components/FloorMap/geometry';
import { PermGate } from '../../components/PermGate';
import { PickPointDialog } from '../../components/PickPointDialog';
import { t, type MessageKey } from '../../i18n';
import type { DispatchMode, Task } from '../../stores/tasks';
import { useToast } from '../../stores/toast';

export interface Floor {
  id: string;
  name: string;
  widthM: number | null;
  heightM: number | null;
  planUrl: string | null;
}
interface Poi {
  id: string;
  floorId: string;
  name: string;
  x: number;
  y: number;
}
export interface Template {
  id: string;
  name: string;
  kind: string;
  priority: Task['priority'];
  floorId: string | null;
  target: { poiId: string } | { pathId: string } | { x: number; y: number } | null;
}
interface RobotRow {
  id: string;
  code: string;
  floorId: string;
}

export const KINDS = ['inspect', 'env', 'security', 'equipment', 'gas'] as const;
const KIND_ICON: Record<string, string> = { inspect: '🔍', env: '🌡️', security: '🛡️', equipment: '⚙️', gas: '🧪' };
const PRIOS = ['P3', 'P1', 'P2', 'P4'] as const; // 原型：預設 P3 排第一

/** 目標的選項值：poi:<id> 或 xy:<floor>:<x>:<y> */
type TargetValue = string;

interface FormState {
  target: TargetValue;
  kind: string;
  priority: Task['priority'];
  robotId: string;
  note: string;
}
const EMPTY: FormState = { target: '', kind: 'inspect', priority: 'P3', robotId: '', note: '' };

export function kindLabel(kind: string): string {
  const key = `dispatch.kind.${kind}` as MessageKey;
  return t(key) === key ? kind : t(key);
}

/**
 * 派工管理頁上方（原型）：手動派工表單、任務範本。點範本帶入表單（不直接建單）；
 * 目標可選興趣點，或在地圖上點選座標。
 */
export function DispatchForm(props: { floors: Floor[]; mode: DispatchMode | undefined }) {
  const qc = useQueryClient();
  const pois = useQuery({ queryKey: ['pois'], queryFn: () => api<Poi[]>('/pois') });
  const templates = useQuery({ queryKey: ['task-templates'], queryFn: () => api<Template[]>('/task-templates') });
  const robots = useQuery({ queryKey: ['robots', 'list'], queryFn: () => api<RobotRow[]>('/robots'), retry: false });
  const [form, setForm] = useState<FormState>(EMPTY);
  const [picked, setPicked] = useState<{ floor: string; p: Pt } | null>(null);
  const [picking, setPicking] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<Template | null>(null);

  const floorName = (id: string) => props.floors.find((f) => f.id === id)?.name ?? id;
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));

  /** 目前選的目標 → API 的 floorId 與 target */
  function resolve(v: TargetValue): { floorId: string; target: Template['target'] } | null {
    if (v.startsWith('poi:')) {
      const poi = pois.data?.find((p) => p.id === v.slice(4));
      return poi ? { floorId: poi.floorId, target: { poiId: poi.id } } : null;
    }
    if (v.startsWith('xy:')) {
      const [, floor, x, y] = v.split(':');
      return { floorId: floor, target: { x: Number(x), y: Number(y) } };
    }
    return null;
  }
  const resolved = resolve(form.target);
  const floorRobots = (robots.data ?? []).filter((r) => r.floorId === resolved?.floorId);

  function onTargetChange(v: string) {
    if (v.startsWith('pick:')) {
      setPicking(v.slice(5));
      return;
    }
    set('target', v);
    set('robotId', '');
  }

  function applyTemplate(tpl: Template) {
    let target = '';
    if (tpl.target && 'poiId' in tpl.target) target = `poi:${tpl.target.poiId}`;
    else if (tpl.target && 'x' in tpl.target && tpl.floorId) {
      target = `xy:${tpl.floorId}:${tpl.target.x}:${tpl.target.y}`;
      setPicked({ floor: tpl.floorId, p: { x: tpl.target.x, y: tpl.target.y } });
    }
    setForm({ target, kind: tpl.kind, priority: tpl.priority, robotId: '', note: tpl.name });
    useToast.getState().show(t('dispatch.tpl.applied', { name: tpl.name }));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!resolved) return useToast.getState().show(t('dispatch.manual.needTarget'), 'warn');
    setBusy(true);
    try {
      const r = await api<{ code: string; status: string }>('/tasks', {
        method: 'POST',
        json: {
          kind: form.kind,
          priority: form.priority,
          floorId: resolved.floorId,
          target: resolved.target,
          robotId: form.robotId || null,
          note: form.note.trim() || null,
        },
      });
      useToast
        .getState()
        .show(r.status === 'pending_approval' ? t('dispatch.manual.sentPending', { code: r.code }) : t('dispatch.manual.sent', { code: r.code }), 'ok');
      setForm(EMPTY);
      setPicked(null);
      await qc.invalidateQueries({ queryKey: ['tasks'] });
    } catch (err) {
      useToast.getState().show(err instanceof ApiError ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function saveTemplate() {
    if (!resolved) return useToast.getState().show(t('dispatch.manual.needTarget'), 'warn');
    const name = (form.note.trim() || kindLabel(form.kind)).slice(0, 32);
    try {
      await api('/task-templates', {
        method: 'POST',
        json: { name, kind: form.kind, priority: form.priority, floorId: resolved.floorId, target: resolved.target },
      });
      useToast.getState().show(t('dispatch.manual.templateSaved', { name }), 'ok');
      await qc.invalidateQueries({ queryKey: ['task-templates'] });
    } catch (err) {
      useToast.getState().show(err instanceof ApiError ? err.message : String(err), 'error');
    }
  }

  async function removeTemplate(tpl: Template) {
    try {
      await api(`/task-templates/${tpl.id}`, { method: 'DELETE' });
      useToast.getState().show(t('dispatch.tpl.deleted', { name: tpl.name }), 'warn');
      await qc.invalidateQueries({ queryKey: ['task-templates'] });
    } catch (err) {
      useToast.getState().show(err instanceof ApiError ? err.message : String(err), 'error');
    }
  }

  const tplTarget = (tpl: Template) => {
    const f = tpl.floorId ? floorName(tpl.floorId) : '';
    if (tpl.target && 'poiId' in tpl.target) return `${f} ${pois.data?.find((p) => p.id === (tpl.target as { poiId: string }).poiId)?.name ?? ''}`;
    if (tpl.target && 'x' in tpl.target) return `${f} (${tpl.target.x}, ${tpl.target.y})`;
    return f;
  };
  const pickFloor = props.floors.find((f) => f.id === picking);

  return (
    <>
      <form className="dcard" onSubmit={submit} aria-label={t('dispatch.manual.title')}>
        <h3>{t('dispatch.manual.title')}</h3>
        <div className="field">
          <label htmlFor="mLoc">{t('dispatch.manual.target')}</label>
          <select id="mLoc" value={form.target} onChange={(e) => onTargetChange(e.target.value)}>
            <option value="">{t('dispatch.manual.targetPick')}</option>
            {picked && (
              <option value={`xy:${picked.floor}:${picked.p.x}:${picked.p.y}`}>
                {t('dispatch.manual.picked', { floor: floorName(picked.floor), x: picked.p.x, y: picked.p.y })}
              </option>
            )}
            {props.floors.map((f) => (
              <optgroup key={f.id} label={f.name}>
                {(pois.data ?? [])
                  .filter((p) => p.floorId === f.id)
                  .map((p) => (
                    <option key={p.id} value={`poi:${p.id}`}>
                      {f.name} - {p.name}
                    </option>
                  ))}
                <option value={`pick:${f.id}`}>
                  {f.name} - {t('dispatch.manual.pickOnMap')}
                </option>
              </optgroup>
            ))}
          </select>
        </div>
        <div className="field two-col">
          <span>
            <label htmlFor="mKind">{t('dispatch.manual.kind')}</label>
            <select id="mKind" value={form.kind} onChange={(e) => set('kind', e.target.value)}>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {kindLabel(k)}
                </option>
              ))}
            </select>
          </span>
          <span>
            <label htmlFor="mPrio">{t('dispatch.manual.priority')}</label>
            <select id="mPrio" value={form.priority} onChange={(e) => set('priority', e.target.value as Task['priority'])}>
              {PRIOS.map((p) => (
                <option key={p} value={p}>
                  {t(`dispatch.prio.${p}` as MessageKey)}
                </option>
              ))}
            </select>
          </span>
        </div>
        <div className="field">
          <label htmlFor="mRobot">{t('dispatch.manual.robot')}</label>
          <select id="mRobot" value={form.robotId} onChange={(e) => set('robotId', e.target.value)} disabled={!resolved}>
            <option value="">{t('dispatch.manual.robotAuto')}</option>
            {floorRobots.map((r) => (
              <option key={r.id} value={r.id}>
                {r.code}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="mNote">{t('dispatch.manual.note')}</label>
          <textarea id="mNote" value={form.note} maxLength={200} placeholder={t('dispatch.manual.notePh')} onChange={(e) => set('note', e.target.value)} />
        </div>
        <PermGate perms={['op.dispatch']}>
          <button className="go" type="submit" disabled={busy}>
            {t('dispatch.manual.submit')}
          </button>
        </PermGate>
        <button type="button" className="mini push-top" onClick={() => void saveTemplate()} disabled={!resolved}>
          {t('dispatch.manual.saveTemplate')}
        </button>
        <p className="hint">{t(props.mode?.approval ? 'dispatch.manual.hintApproval' : 'dispatch.manual.hintAuto')}</p>
      </form>

      <section className="dcard" aria-label={t('dispatch.tpl.title')}>
        <h3>{t('dispatch.tpl.title')}</h3>
        {(templates.data ?? []).length === 0 ? (
          <p className="muted">{t('dispatch.tpl.empty')}</p>
        ) : (
          <div className="tpl-grid">
            {(templates.data ?? []).map((tpl) => (
              <div key={tpl.id} className="tpl-wrap">
                <button type="button" className="tpl" onClick={() => applyTemplate(tpl)} data-template={tpl.name}>
                  <div className="e" aria-hidden="true">
                    {KIND_ICON[tpl.kind] ?? '📌'}
                  </div>
                  <strong>{tpl.name}</strong>
                  <span>
                    {tplTarget(tpl)} · {tpl.priority}
                  </span>
                </button>
                <button type="button" className="tpl-del" aria-label={`${t('dispatch.tpl.delete')} ${tpl.name}`} onClick={() => setDeleting(tpl)}>
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {pickFloor && (
        <PickPointDialog
          floor={pickFloor}
          onClose={() => setPicking(null)}
          onPick={(p) => {
            setPicked({ floor: pickFloor.id, p });
            set('target', `xy:${pickFloor.id}:${p.x}:${p.y}`);
            set('robotId', '');
            setPicking(null);
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={t('dispatch.tpl.delete')}
          body={t('dispatch.tpl.deleteConfirm', { name: deleting.name })}
          confirmText={t('dispatch.tpl.delete')}
          danger
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const tpl = deleting;
            setDeleting(null);
            void removeTemplate(tpl);
          }}
        />
      )}
    </>
  );
}
