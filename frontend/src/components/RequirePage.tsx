import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { t } from '../i18n';
import { allowed, type PageDef } from '../routes';
import { useAuth } from '../stores/auth';
import { ChangePasswordDialog } from './ChangePasswordDialog';
import { Toaster } from './Toaster';

/** 未登入導向登入頁；沒有權限的頁面直接輸入網址也導向 403（權限仍以後端檢查為準） */
export function RequirePage({ page, children }: { page: PageDef; children: ReactNode }) {
  const perms = useAuth((s) => s.perms);
  if (!allowed(page, perms)) return <Navigate to="/forbidden" replace />;
  return <>{children}</>;
}

export function RequireLogin({ children }: { children: ReactNode }) {
  const status = useAuth((s) => s.status);
  const mustChange = useAuth((s) => s.mustChangePassword);
  const location = useLocation();
  if (status === 'loading') return <div className="splash">{t('common.loading')}</div>;
  if (status === 'anon') return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  // 管理員建立帳號或重設密碼後：先改密碼，不載入其他畫面（後端也只開放改密碼與登出）
  if (mustChange)
    return (
      <div className="login">
        <ChangePasswordDialog forced onClose={() => useAuth.getState().passwordChanged()} />
        <Toaster />
      </div>
    );
  return <>{children}</>;
}
