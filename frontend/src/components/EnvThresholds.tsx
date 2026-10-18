import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api/client';
import { t } from '../i18n';
import { useAuth } from '../stores/auth';
import { useToast } from '../stores/toast';

export interface EnvThreshold {
  kind: string;
  name: string;
  unit: string;
  min: number | null;
  max: number | null;
  alarmType: string | null;
  sort: number;
}

export const useEnvThresholds = () =>
  useQuery({
    queryKey: ['env-thresholds'],
    queryFn: () => api<EnvThreshold[]>('/env/thresholds'),
  });

/** 數值顯示到小數一位（整數不補 0） */
export const fmtV = (v: number) => String(Math.round(v * 10) / 10);

/** 閾值文字：「≤ 35 °C」「19.5～23.5 %」 */
export function limitText(th: Pick<EnvThreshold, 'min' | 'max' | 'unit'>): string {
  if (th.min != null && th.max != null) return `${fmtV(th.min)}～${fmtV(th.max)} ${th.unit}`;
  if (th.max != null) return `≤ ${fmtV(th.max)} ${th.unit}`;
  if (th.min != null) return `≥ ${fmtV(th.min)} ${th.unit}`;
  return t('env.noLimit');
}

const num = (s: string): number | null => (s.trim() === '' || !Number.isFinite(Number(s)) ? null : Number(s));

/**
 * 環境數值閾值（環境監測頁側欄、告警設置頁共用）：各項目的下限、上限與超標時發的業務告警。
 * 有 alarmset 權限才能改；其他人只看。
 */
export function EnvThresholds({ compact }: { compact?: boolean }) {
  const qc = useQueryClient();
  const can = useAuth((s) => s.can)('alarmset');
  const q = useEnvThresholds();
  const rules = useQuery({
    queryKey: ['alarm-rules'],
    queryFn: () => api<{ rules: { type: string; category: string; name: string }[] }>('/alarm-rules'),
    enabled: can,
  });
  const [draft, setDraft] = useState<Record<string, { min: string; max: string; alarmType: string }>>({});
  const [saving, setSaving] = useState(false);
  const reset = () =>
    q.data &&
    setDraft(
      Object.fromEntries(
        q.data.map((x) => [
          x.kind,
          {
            min: x.min == null ? '' : String(x.min),
            max: x.max == null ? '' : String(x.max),
            alarmType: x.alarmType ?? '',
          },
        ]),
      ),
    );
  useEffect(reset, [q.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const changed = useMemo(
    () =>
      (q.data ?? []).filter((x) => {
        const d = draft[x.kind];
        return d && (num(d.min) !== x.min || num(d.max) !== x.max || (d.alarmType || null) !== x.alarmType);
      }),
    [q.data, draft],
  );
  const business = (rules.data?.rules ?? []).filter((r) => r.category === 'business');
  const alarmName = (type: string | null) => (type ? (business.find((r) => r.type === type)?.name ?? type) : t('env.noAlarm'));

  async function save() {
    setSaving(true);
    try {
      const r = await api<EnvThreshold[]>('/env/thresholds', {
        method: 'PUT',
        json: changed.map((x) => ({
          kind: x.kind,
          min: num(draft[x.kind].min),
          max: num(draft[x.kind].max),
          alarmType: draft[x.kind].alarmType || null,
        })),
      });
      qc.setQueryData(['env-thresholds'], r);
      await qc.invalidateQueries({ queryKey: ['env'] });
      useToast.getState().show(t('env.th.saved'), 'ok');
    } catch (e) {
      useToast.getState().show(e instanceof ApiError ? e.message : String(e), 'error');
    } finally {
      setSaving(false);
    }
  }

  if (!q.data) return null;
  return (
    <div className={compact ? 'env-th compact' : 'env-th'}>
      <div className="tbl-wrap">
        <table className="dtbl">
          <thead>
            <tr>
              <th>{t('env.th.kind')}</th>
              <th>{t('env.th.min')}</th>
              <th>{t('env.th.max')}</th>
              {!compact && <th>{t('env.th.alarm')}</th>}
            </tr>
          </thead>
          <tbody>
            {q.data.map((x) => {
              const d = draft[x.kind] ?? { min: '', max: '', alarmType: '' };
              const set = (p: Partial<typeof d>) => setDraft((o) => ({ ...o, [x.kind]: { ...d, ...p } }));
              return (
                <tr key={x.kind}>
                  <td>
                    {x.name}
                    <div className="sub mono">{x.unit}</div>
                  </td>
                  {(['min', 'max'] as const).map((k) => (
                    <td key={k}>
                      {can ? (
                        <input
                          className="num-in"
                          type="number"
                          step="any"
                          aria-label={`${x.name} ${t(k === 'min' ? 'env.th.min' : 'env.th.max')}`}
                          value={d[k]}
                          placeholder="—"
                          onChange={(e) => set({ [k]: e.target.value })}
                        />
                      ) : (
                        <span className="mono">{x[k] == null ? '—' : fmtV(x[k]!)}</span>
                      )}
                    </td>
                  ))}
                  {!compact && (
                    <td>
                      {can ? (
                        <select aria-label={`${x.name} ${t('env.th.alarm')}`} value={d.alarmType} onChange={(e) => set({ alarmType: e.target.value })}>
                          <option value="">{t('env.noAlarm')}</option>
                          {business.map((r) => (
                            <option key={r.type} value={r.type}>
                              {r.name}
                            </option>
                          ))}
                        </select>
                      ) : (
                        alarmName(x.alarmType)
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {can && (
        <div className="save-bar">
          {changed.length > 0 && <span className="err">{t('alarmset.dirty')}</span>}
          <button type="button" className="btn" disabled={!changed.length || saving} onClick={reset}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn primary" disabled={!changed.length || saving} onClick={() => void save()}>
            {t('env.th.apply')}
          </button>
        </div>
      )}
      <p className="hint">{t(can ? 'env.th.hint' : 'env.th.readonly')}</p>
    </div>
  );
}
