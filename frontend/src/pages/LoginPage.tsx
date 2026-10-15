import { type FormEvent, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../api/errors';
import { formatTime, t } from '../i18n';
import { homePath } from '../routes';
import { useAuth } from '../stores/auth';

export function LoginPage() {
  const { status, login, expired } = useAuth();
  const navigate = useNavigate();
  const from = (useLocation().state as { from?: string } | null)?.from;
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (status === 'authed') return <Navigate to={from ?? homePath(useAuth.getState().perms)} replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!username.trim() || !password) return setError(t('login.error.required'));
    setBusy(true);
    setError(null);
    try {
      await login(username.trim(), password);
      navigate(from ?? homePath(useAuth.getState().perms), { replace: true });
    } catch (err) {
      setError(loginError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form onSubmit={submit} noValidate>
        <h1>{t('app.name')}</h1>
        {expired && !error && <p className="notice">{t('login.expired')}</p>}
        <label>
          {t('login.username')}
          <input autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
        </label>
        <label>
          {t('login.password')}
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy}>
          {busy ? t('login.submitting') : t('login.submit')}
        </button>
      </form>
    </div>
  );
}

export function loginError(err: unknown): string {
  if (!(err instanceof ApiError)) return t('login.error.network');
  if (err.code === 'ACCOUNT_LOCKED' && typeof err.details.lockedUntil === 'string') {
    return t('login.error.locked', { time: formatTime(err.details.lockedUntil) });
  }
  if (err.code === 'UNAUTHENTICATED' && err.message === '帳號已停用') return t('login.error.disabled');
  if (err.code === 'UNAUTHENTICATED' || err.code === 'VALIDATION_FAILED') return t('login.error.credentials');
  return t('login.error.network');
}
