import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { t } from '../i18n';
import { allowed, type PageDef } from '../routes';
import { useAuth } from '../stores/auth';

/** 未登入導向登入頁；沒有權限的頁面直接輸入網址也導向 403（權限仍以後端檢查為準） */
export function RequirePage({ page, children }: { page: PageDef; children: ReactNode }) {
  const perms = useAuth((s) => s.perms);
  if (!allowed(page, perms)) return <Navigate to="/forbidden" replace />;
  return <>{children}</>;
}

export function RequireLogin({ children }: { children: ReactNode }) {
  const status = useAuth((s) => s.status);
  const location = useLocation();
  if (status === 'loading') return <div className="splash">{t('common.loading')}</div>;
  if (status === 'anon') return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <>{children}</>;
}
