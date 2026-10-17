import { type FormEvent, useState } from 'react';
import { api, ApiError } from '../api/client';
import { t } from '../i18n';
import { useAuth } from '../stores/auth';
import { useToast } from '../stores/toast';

const STRONG = /^(?=.*[A-Za-z])(?=.*\d).{8,128}$/;

/**
 * 修改密碼（PUT /auth/password）。規則與後端相同：至少 8 碼，含英文與數字。
 * forced：管理員建立帳號或重設密碼後必須先改，不能取消（只能登出），onClose 只在改好後呼叫。
 */
export function ChangePasswordDialog({ onClose, forced = false }: { onClose(): void; forced?: boolean }) {
  const [oldPassword, setOld] = useState('');
  const [newPassword, setNew] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (newPassword !== confirm) return setError(t('password.mismatch'));
    if (!STRONG.test(newPassword)) return setError(t('password.weak'));
    if (newPassword === oldPassword) return setError(t('password.same'));
    setBusy(true);
    try {
      await api('/auth/password', { method: 'PUT', json: { oldPassword, newPassword } });
      useToast.getState().show(t('password.done'), 'ok');
      onClose();
    } catch (err) {
      const fields = err instanceof ApiError ? (err.details.fields as Record<string, string> | undefined) : undefined;
      setError(fields?.newPassword ?? (fields ? t('password.wrongOld') : t('login.error.network')));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-bg" onKeyDown={(e) => !forced && e.key === 'Escape' && onClose()}>
      <form className="modal" role="dialog" aria-modal="true" aria-label={t('password.title')} onSubmit={submit}>
        <h2>{t('password.title')}</h2>
        {forced && <p className="notice">{t('password.forced')}</p>}
        <label>
          {t('password.old')}
          <input type="password" autoComplete="current-password" value={oldPassword} onChange={(e) => setOld(e.target.value)} autoFocus />
        </label>
        <label>
          {t('password.new')}
          <input type="password" autoComplete="new-password" value={newPassword} onChange={(e) => setNew(e.target.value)} />
        </label>
        <label>
          {t('password.confirm')}
          <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </label>
        <p className="muted">{t('password.rule')}</p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="row">
          {forced ? (
            <button type="button" className="btn" onClick={() => void useAuth.getState().logout()}>
              {t('menu.logout')}
            </button>
          ) : (
            <button type="button" className="btn" onClick={onClose}>
              {t('common.cancel')}
            </button>
          )}
          <button type="submit" className="btn primary" disabled={busy || !oldPassword}>
            {t('common.save')}
          </button>
        </div>
      </form>
    </div>
  );
}
