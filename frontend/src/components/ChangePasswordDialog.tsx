import { type FormEvent, useState } from 'react';
import { api, ApiError } from '../api/client';
import { t } from '../i18n';
import { useToast } from '../stores/toast';

const STRONG = /^(?=.*[A-Za-z])(?=.*\d).{8,128}$/;

/** 修改密碼（PUT /auth/password）。規則與後端相同：至少 8 碼，含英文與數字 */
export function ChangePasswordDialog({ onClose }: { onClose(): void }) {
  const [oldPassword, setOld] = useState('');
  const [newPassword, setNew] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (newPassword !== confirm) return setError(t('password.mismatch'));
    if (!STRONG.test(newPassword)) return setError(t('password.weak'));
    setBusy(true);
    try {
      await api('/auth/password', { method: 'PUT', json: { oldPassword, newPassword } });
      useToast.getState().show(t('password.done'), 'ok');
      onClose();
    } catch (err) {
      setError(err instanceof ApiError && err.details.fields ? t('password.wrongOld') : t('login.error.network'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-bg" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <form className="modal" role="dialog" aria-modal="true" aria-label={t('password.title')} onSubmit={submit}>
        <h2>{t('password.title')}</h2>
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
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn primary" disabled={busy || !oldPassword}>
            {t('common.save')}
          </button>
        </div>
      </form>
    </div>
  );
}
