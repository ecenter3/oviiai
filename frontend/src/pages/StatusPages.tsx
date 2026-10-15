import { Link } from 'react-router-dom';
import { t } from '../i18n';
import type { PageDef } from '../routes';

export function ForbiddenPage() {
  return (
    <div className="status-page">
      <h1>403 {t('page.forbidden.title')}</h1>
      <p>{t('page.forbidden.body')}</p>
      <Link className="btn" to="/">
        {t('page.back')}
      </Link>
    </div>
  );
}

export function NotFoundPage() {
  return (
    <div className="status-page">
      <h1>404 {t('page.notFound.title')}</h1>
      <Link className="btn" to="/">
        {t('page.back')}
      </Link>
    </div>
  );
}

/** 尚未實作的頁面：標出負責的工作項目 */
export function PlaceholderPage({ page }: { page: PageDef }) {
  return (
    <div className="page">
      <h1 className="page-h">{t(page.title)}</h1>
      <p className="muted">
        {page.phase === 2 ? t('page.placeholder.phase2') : t('page.placeholder.planned', { task: page.task })}
      </p>
    </div>
  );
}
