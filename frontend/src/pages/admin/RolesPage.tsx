import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, ApiError } from '../../api/client';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { t } from '../../i18n';
import { useAuth } from '../../stores/auth';
import { useToast } from '../../stores/toast';

export interface Role {
  id: string;
  name: string;
  description: string | null;
  perms: string[];
  isSystem: boolean;
  noIdleLogout: boolean;
  memberCount: number;
}
interface PermGroup {
  name: string;
  children: { code: string; name: string }[];
}
interface Form {
  name: string;
  description: string;
  perms: string[];
  noIdleLogout: boolean;
}

const empty: Form = { name: '', description: '', perms: ['monitor', 'help'], noIdleLogout: false };

/**
 * 角色管理（原型「角色管理」）：列表＋右側新增／編輯（名稱、說明、權限勾選、不自動登出）。
 * 權限比自己高的角色、系統角色（非系統管理員）唯讀——後端同樣擋（安全收尾 c）。
 * 「不自動登出」給需要常駐顯示的角色（例：監看大屏）；其他人照規則頁的分鐘數閒置登出（PR #16 審查第 1 點）。
 */
export function RolesPage() {
  const qc = useQueryClient();
  const me = useAuth((s) => s.user);
  const myPerms = useAuth((s) => s.perms);
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api<Role[]>('/roles') });
  const tree = useQuery({ queryKey: ['permissions'], queryFn: () => api<PermGroup[]>('/permissions'), staleTime: Infinity });
  const [editing, setEditing] = useState<Role | null>(null);
  const [form, setForm] = useState<Form>(empty);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<Role | null>(null);

  const list = roles.data ?? [];
  const mySystem = list.some((r) => r.isSystem && r.id === me?.role.id);
  /** 能不能動這個角色：系統角色只有系統管理員；其他角色的權限不能超出自己 */
  const canManage = (r: Role) => (r.isSystem ? mySystem : r.perms.every((p) => myPerms.includes(p)));
  const readOnly = !!editing && !canManage(editing);
  const permName = new Map((tree.data ?? []).flatMap((g) => g.children.map((c) => [c.code, c.name] as const)));

  function startEdit(r: Role | null) {
    setEditing(r);
    setError(null);
    setForm(r ? { name: r.name, description: r.description ?? '', perms: r.perms, noIdleLogout: r.noIdleLogout } : empty);
  }

  async function save() {
    if (!form.name.trim()) return setError(t('roles.err.name'));
    setSaving(true);
    setError(null);
    try {
      const json = { name: form.name.trim(), description: form.description.trim() || null, noIdleLogout: form.noIdleLogout, ...(editing?.isSystem ? {} : { perms: form.perms }) };
      const saved = await api<Role>(editing ? `/roles/${editing.id}` : '/roles', { method: editing ? 'PATCH' : 'POST', json });
      useToast.getState().show(t(editing ? 'roles.saved' : 'roles.created', { name: saved.name }), 'ok');
      await qc.invalidateQueries({ queryKey: ['roles'] });
      startEdit(saved);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function remove(r: Role) {
    try {
      await api(`/roles/${r.id}`, { method: 'DELETE' });
      useToast.getState().show(t('roles.deleted', { name: r.name }), 'ok');
      if (editing?.id === r.id) startEdit(null);
      await qc.invalidateQueries({ queryKey: ['roles'] });
    } catch (e) {
      useToast.getState().show(e instanceof ApiError ? e.message : String(e), 'error');
    }
  }

  const togglePerm = (code: string, on: boolean) => setForm((f) => ({ ...f, perms: on ? [...f.perms, code] : f.perms.filter((p) => p !== code) }));
  const toggleGroup = (g: PermGroup, on: boolean) =>
    setForm((f) => {
      const codes = g.children.map((c) => c.code).filter((c) => !on || myPerms.includes(c));
      return { ...f, perms: on ? [...new Set([...f.perms, ...codes])] : f.perms.filter((p) => !codes.includes(p)) };
    });

  return (
    <div className="pg2">
      <section className="panel">
        <div className="pane-head">
          <span className="title">{t('page.roles')}</span>
          <span className="meta">{t('roles.meta', { n: list.length })}</span>
        </div>
        <div className="scroll">
          <div className="pane-body">
            <div className="tbl-wrap">
              <table className="dtbl">
                <thead>
                  <tr>
                    <th>{t('alarm.col.no')}</th>
                    <th>{t('roles.col.name')}</th>
                    <th>{t('roles.col.desc')}</th>
                    <th>{t('roles.col.perms')}</th>
                    <th>{t('roles.col.members')}</th>
                    <th>{t('roles.col.idle')}</th>
                    <th>{t('alarm.col.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((r, i) => (
                    <tr key={r.id} data-role={r.name} className={editing?.id === r.id ? 'sel' : ''}>
                      <td>{i + 1}</td>
                      <td>
                        {r.name}
                        {r.isSystem && <span className="badge2 sub">{t('roles.system')}</span>}
                      </td>
                      <td>{r.description || '—'}</td>
                      <td className="num">{r.perms.length}</td>
                      <td className="num">{r.memberCount}</td>
                      <td>{r.noIdleLogout ? <span className="badge2 ok">{t('roles.idle.never')}</span> : t('roles.idle.default')}</td>
                      <td>
                        <div className="acts">
                          <button type="button" className="obtn" onClick={() => startEdit(r)}>
                            {canManage(r) ? t('roles.edit') : t('roles.view')}
                          </button>
                          {!r.isSystem && canManage(r) && (
                            <button type="button" className="obtn red" onClick={() => setDeleting(r)}>
                              {t('roles.delete')}
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
            {t('roles.add')}
          </button>
          <button type="button" className={editing ? 'on' : ''} disabled={!editing}>
            {editing ? t('roles.editing', { name: editing.name }) : t('roles.editTab')}
          </button>
        </div>
        <form
          className="scroll filt-in"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          {readOnly && <p className="notice">{editing?.isSystem ? t('roles.readonly.system') : t('roles.readonly.higher')}</p>}
          <fieldset disabled={readOnly} className="contents">
            <div className="fl">
              <label>
                {t('roles.f.name')}
                <input value={form.name} maxLength={32} required onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </label>
            </div>
            <div className="fl">
              <label>
                {t('roles.f.desc')}
                <input value={form.description} maxLength={200} onChange={(e) => setForm({ ...form, description: e.target.value })} />
              </label>
            </div>
            <label className="check">
              <input type="checkbox" checked={form.noIdleLogout} onChange={(e) => setForm({ ...form, noIdleLogout: e.target.checked })} /> {t('roles.f.noIdle')}
            </label>
            <span className="fhint">{t('roles.f.noIdleHint')}</span>
            <div className="fl">
              {t('roles.f.perms', { n: form.perms.length })}
              {editing?.isSystem ? (
                <span className="fhint">{t('roles.f.systemPerms')}</span>
              ) : (
                <div className="ptree">
                  {(tree.data ?? []).map((g) => {
                    const n = g.children.filter((c) => form.perms.includes(c.code)).length;
                    return (
                      <div key={g.name} className="pgrp">
                        <label className="pg">
                          <input
                            type="checkbox"
                            checked={n === g.children.length}
                            ref={(el) => {
                              if (el) el.indeterminate = n > 0 && n < g.children.length;
                            }}
                            onChange={(e) => toggleGroup(g, e.target.checked)}
                          />
                          {g.name}
                        </label>
                        {g.children.map((c) => {
                          const mine = myPerms.includes(c.code);
                          return (
                            <label key={c.code} className="pc" title={mine ? undefined : t('roles.f.notMine')}>
                              <input type="checkbox" checked={form.perms.includes(c.code)} disabled={!mine && !form.perms.includes(c.code)} onChange={(e) => togglePerm(c.code, e.target.checked)} />
                              {c.name}
                            </label>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            {error && (
              <p className="ferr" role="alert">
                {error}
              </p>
            )}
            <button type="submit" className="go2 warn" disabled={saving || readOnly}>
              {editing ? t('common.save') : t('roles.add')}
            </button>
          </fieldset>
          {editing && (
            <button type="button" className="go2" onClick={() => startEdit(null)}>
              {t('common.cancel')}
            </button>
          )}
          {editing && !editing.isSystem && editing.perms.some((p) => !permName.has(p)) && <p className="hint">{t('roles.unknownPerms')}</p>}
          <p className="hint">{t('roles.hint')}</p>
        </form>
      </aside>

      {deleting && (
        <ConfirmDialog
          title={t('roles.delete')}
          body={t('roles.deleteConfirm', { name: deleting.name })}
          confirmText={t('roles.delete')}
          danger
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const r = deleting;
            setDeleting(null);
            void remove(r);
          }}
        />
      )}
    </div>
  );
}
