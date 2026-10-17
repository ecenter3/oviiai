import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, ApiError } from '../../api/client';
import { BulkImportDialog } from '../../components/BulkImportDialog';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { formatTime, t, type MessageKey } from '../../i18n';
import { useToast } from '../../stores/toast';

export const BRANDS = ['anbot', 'unitree', 'deep'] as const;
export const CAPS = ['ptz', 'light', 'talk', 'talk_live', 'follow', 'lift', 'env'] as const;

export interface ManagedRobot {
  id: string;
  code: string;
  brand: (typeof BRANDS)[number];
  model: string;
  serialNo: string | null;
  floorId: string;
  adapter: string;
  conn: { host?: string; port?: number; username?: string };
  hasSecret: boolean;
  caps: string[];
  enabled: boolean;
  online: boolean;
  createdAt: string;
}
interface Floor {
  id: string;
  name: string;
}

interface Form {
  code: string;
  brand: (typeof BRANDS)[number];
  model: string;
  serialNo: string;
  floorId: string;
  adapter: string;
  host: string;
  port: string;
  username: string;
  secret: string;
  clearSecret: boolean;
  caps: string[];
}

/** 品牌預設機型與轉接器名稱（只是表單預填，可改） */
const DEFAULTS: Record<Form['brand'], { model: string; adapter: string }> = {
  anbot: { model: 'ANBOT-Y', adapter: 'anbot' },
  unitree: { model: 'B2', adapter: 'unitree' },
  deep: { model: 'X30', adapter: 'deep' },
};

const empty = (floorId = ''): Form => ({
  code: '',
  brand: 'anbot',
  model: DEFAULTS.anbot.model,
  serialNo: '',
  floorId,
  adapter: DEFAULTS.anbot.adapter,
  host: '',
  port: '',
  username: '',
  secret: '',
  clearSecret: false,
  caps: [],
});

const fromRobot = (r: ManagedRobot): Form => ({
  code: r.code,
  brand: r.brand,
  model: r.model,
  serialNo: r.serialNo ?? '',
  floorId: r.floorId,
  adapter: r.adapter,
  host: r.conn.host ?? '',
  port: r.conn.port ? String(r.conn.port) : '',
  username: r.conn.username ?? '',
  secret: '',
  clearSecret: false,
  caps: r.caps,
});

/**
 * 機器人管理（/robot-admin，原型「機器人管理」：主表格＋右側新增欄；T-25）。
 * 新增後機器人立即被平台接受（一送遙測就出現在監控頁），轉接器從後端設定取得新清單（模擬器 10 秒內出現）。
 * 連線密碼只寫不讀，加密存放。停用不刪資料（歷史紀錄仍參照），可再啟用。
 */
export function RobotAdminPage() {
  const qc = useQueryClient();
  const [bulk, setBulk] = useState(false);
  const floors = useQuery({ queryKey: ['floors'], queryFn: () => api<Floor[]>('/floors') });
  const list = useQuery({ queryKey: ['robots', 'manage'], queryFn: () => api<ManagedRobot[]>('/robots/manage'), refetchInterval: 10_000 });
  const [editing, setEditing] = useState<ManagedRobot | null>(null);
  const [form, setForm] = useState<Form>(() => empty());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [disabling, setDisabling] = useState<ManagedRobot | null>(null);
  const floorName = (id: string) => floors.data?.find((f) => f.id === id)?.name ?? id;

  useEffect(() => {
    if (!form.floorId && floors.data?.[0]) setForm((f) => ({ ...f, floorId: floors.data![0].id }));
  }, [floors.data, form.floorId]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));

  function startEdit(r: ManagedRobot | null) {
    setEditing(r);
    setErrors({});
    setForm(r ? fromRobot(r) : empty(floors.data?.[0]?.id ?? ''));
  }

  async function save() {
    setSaving(true);
    setErrors({});
    const conn = {
      ...(form.host.trim() && { host: form.host.trim() }),
      ...(form.port.trim() && { port: Number(form.port) }),
      ...(form.username.trim() && { username: form.username.trim() }),
    };
    const body = {
      model: form.model.trim(),
      serialNo: form.serialNo.trim() || null,
      floorId: form.floorId,
      adapter: form.adapter.trim(),
      conn,
      caps: form.caps,
      ...(form.secret ? { secret: form.secret } : form.clearSecret ? { secret: null } : {}),
    };
    try {
      if (editing) {
        await api(`/robots/${editing.id}`, { method: 'PATCH', json: body });
        useToast.getState().show(t('robotmgr.saved', { code: editing.code }), 'ok');
      } else {
        await api('/robots', { method: 'POST', json: { ...body, code: form.code.trim().toUpperCase(), brand: form.brand } });
        useToast.getState().show(t('robotmgr.created', { code: form.code.trim().toUpperCase() }), 'ok');
      }
      startEdit(null);
      await qc.invalidateQueries({ queryKey: ['robots'] });
    } catch (e) {
      if (e instanceof ApiError) {
        setErrors((e.details.fields as Record<string, string> | undefined) ?? {});
        useToast.getState().show(e.message, 'error');
      } else useToast.getState().show(String(e), 'error');
    } finally {
      setSaving(false);
    }
  }

  async function setEnabled(r: ManagedRobot, enabled: boolean) {
    try {
      if (enabled) await api(`/robots/${r.id}`, { method: 'PATCH', json: { enabled: true } });
      else await api(`/robots/${r.id}`, { method: 'DELETE' });
      useToast.getState().show(t(enabled ? 'robotmgr.enabled' : 'robotmgr.disabled', { code: r.code }), 'ok');
      await qc.invalidateQueries({ queryKey: ['robots'] });
    } catch (e) {
      useToast.getState().show(e instanceof ApiError ? e.message : String(e), 'error');
    }
  }

  const robots = list.data ?? [];
  return (
    <div className="pg2">
      {bulk && <BulkImportDialog kind="robots" onClose={() => setBulk(false)} onDone={() => void qc.invalidateQueries({ queryKey: ['robots'] })} />}
      <section className="panel">
        <div className="pane-head">
          <span className="title">{t('page.robotmgr')}</span>
          <span className="meta">{t('robotmgr.meta', { n: robots.length, on: robots.filter((r) => r.enabled).length })}</span>
          <button type="button" className="obtn bulk" onClick={() => setBulk(true)}>
            {t('bulk.open')}
          </button>
        </div>
        <div className="scroll">
          <div className="pane-body">
            <div className="tbl-wrap">
              <table className="dtbl">
                <thead>
                  <tr>
                    <th>{t('alarm.col.no')}</th>
                    <th>{t('robotmgr.col.code')}</th>
                    <th>{t('robotmgr.col.model')}</th>
                    <th>{t('robotmgr.col.serial')}</th>
                    <th>{t('robotmgr.col.floor')}</th>
                    <th>{t('robotmgr.col.adapter')}</th>
                    <th>{t('robotmgr.col.caps')}</th>
                    <th>{t('robotmgr.col.status')}</th>
                    <th>{t('robotmgr.col.created')}</th>
                    <th>{t('alarm.col.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {robots.length === 0 && (
                    <tr>
                      <td colSpan={10} className="tbl-empty">
                        {t('robotmgr.empty')}
                      </td>
                    </tr>
                  )}
                  {robots.map((r, i) => (
                    <tr key={r.id} data-robot={r.code} className={r.enabled ? '' : 'off'}>
                      <td>{i + 1}</td>
                      <td className="mono">{r.code}</td>
                      <td>
                        {t(`brand.${r.brand}` as MessageKey)} {r.model}
                      </td>
                      <td className="mono">{r.serialNo ?? '—'}</td>
                      <td>{floorName(r.floorId)}</td>
                      <td className="mono">
                        {r.adapter}
                        {r.conn.host && <div className="sub">{`${r.conn.host}${r.conn.port ? `:${r.conn.port}` : ''}`}</div>}
                      </td>
                      <td>{r.caps.length ? r.caps.map((c) => t(`cap.${c}` as MessageKey)).join('、') : '—'}</td>
                      <td>
                        {!r.enabled ? (
                          <span className="badge2">{t('robotmgr.status.disabled')}</span>
                        ) : r.online ? (
                          <span className="badge2 ok">{t('robotmgr.status.online')}</span>
                        ) : (
                          <span className="badge2 unreg">{t('robotmgr.status.offline')}</span>
                        )}
                      </td>
                      <td className="mono">{formatTime(r.createdAt).slice(0, 10)}</td>
                      <td>
                        <div className="acts">
                          <button type="button" className="obtn" onClick={() => startEdit(r)}>
                            {t('robotmgr.edit')}
                          </button>
                          {r.enabled ? (
                            <button type="button" className="obtn red" onClick={() => setDisabling(r)}>
                              {t('robotmgr.disable')}
                            </button>
                          ) : (
                            <button type="button" className="obtn" onClick={() => void setEnabled(r, true)}>
                              {t('robotmgr.enable')}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </section>

      <aside className="panel filt">
        <div className="tabs2">
          <button type="button" className={editing ? '' : 'on'} onClick={() => startEdit(null)}>
            {t('robotmgr.add')}
          </button>
          <button type="button" className={editing ? 'on' : ''} disabled={!editing}>
            {editing ? t('robotmgr.editing', { code: editing.code }) : t('robotmgr.editTab')}
          </button>
        </div>
        <form
          className="scroll filt-in"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          {!editing && (
            <>
              <Field label={t('robotmgr.f.code')} error={errors.code}>
                <input value={form.code} required maxLength={32} placeholder="B2-003" onChange={(e) => set('code', e.target.value.toUpperCase())} />
              </Field>
              <Field label={t('robotmgr.f.brand')}>
                <select
                  value={form.brand}
                  onChange={(e) => {
                    const b = e.target.value as Form['brand'];
                    setForm((f) => ({ ...f, brand: b, model: DEFAULTS[b].model, adapter: DEFAULTS[b].adapter }));
                  }}
                >
                  {BRANDS.map((b) => (
                    <option key={b} value={b}>
                      {t(`brand.${b}` as MessageKey)}
                    </option>
                  ))}
                </select>
              </Field>
            </>
          )}
          <Field label={t('robotmgr.f.model')} error={errors.model}>
            <input value={form.model} required maxLength={32} onChange={(e) => set('model', e.target.value)} />
          </Field>
          <Field label={t('robotmgr.f.serial')} error={errors.serialNo}>
            <input value={form.serialNo} maxLength={64} onChange={(e) => set('serialNo', e.target.value)} />
          </Field>
          <Field label={t('robotmgr.f.floor')} error={errors.floorId}>
            <select value={form.floorId} onChange={(e) => set('floorId', e.target.value)}>
              {floors.data?.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('robotmgr.f.adapter')} error={errors.adapter} hint={t('robotmgr.f.adapterHint')}>
            <input value={form.adapter} required maxLength={32} pattern="[a-z0-9_\-]+" onChange={(e) => set('adapter', e.target.value)} />
          </Field>
          <div className="fl">
            {t('robotmgr.f.conn')}
            <div className="trange">
              <input aria-label={t('robotmgr.f.host')} placeholder={t('robotmgr.f.host')} value={form.host} maxLength={253} onChange={(e) => set('host', e.target.value)} />
              <span>:</span>
              <input aria-label={t('robotmgr.f.port')} placeholder={t('robotmgr.f.port')} value={form.port} inputMode="numeric" pattern="[0-9]*" maxLength={5} style={{ maxWidth: 80 }} onChange={(e) => set('port', e.target.value)} />
            </div>
          </div>
          <Field label={t('robotmgr.f.username')}>
            <input value={form.username} maxLength={64} autoComplete="off" onChange={(e) => set('username', e.target.value)} />
          </Field>
          <Field label={t('robotmgr.f.secret')} hint={editing?.hasSecret ? t('robotmgr.f.secretKeep') : t('robotmgr.f.secretHint')}>
            <input type="password" value={form.secret} maxLength={200} autoComplete="new-password" onChange={(e) => set('secret', e.target.value)} />
          </Field>
          {editing?.hasSecret && (
            <label className="check">
              <input type="checkbox" checked={form.clearSecret} onChange={(e) => set('clearSecret', e.target.checked)} /> {t('robotmgr.f.clearSecret')}
            </label>
          )}
          <div className="fl">
            {t('robotmgr.f.caps')}
            <div className="radios">
              {CAPS.map((c) => (
                <label key={c}>
                  <input type="checkbox" checked={form.caps.includes(c)} onChange={(e) => set('caps', e.target.checked ? [...form.caps, c] : form.caps.filter((x) => x !== c))} />
                  {t(`cap.${c}` as MessageKey)}
                </label>
              ))}
            </div>
          </div>
          <button type="submit" className="go2 warn" disabled={saving}>
            {editing ? t('common.save') : t('robotmgr.add')}
          </button>
          {editing && (
            <button type="button" className="go2" onClick={() => startEdit(null)}>
              {t('common.cancel')}
            </button>
          )}
          <p className="hint">{t('robotmgr.hint')}</p>
        </form>
      </aside>

      {disabling && (
        <ConfirmDialog
          title={t('robotmgr.disable')}
          body={t('robotmgr.disableConfirm', { code: disabling.code })}
          confirmText={t('robotmgr.disable')}
          danger
          onCancel={() => setDisabling(null)}
          onConfirm={() => {
            const r = disabling;
            setDisabling(null);
            void setEnabled(r, false);
          }}
        />
      )}
    </div>
  );
}

function Field({ label, error, hint, children }: { label: string; error?: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="fl">
      <label>
        {label}
        {children}
      </label>
      {error && <span className="ferr">{error}</span>}
      {hint && <span className="fhint">{hint}</span>}
    </div>
  );
}
