import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { BulkImportDialog, type ImportKind } from '../../components/BulkImportDialog';
import { t } from '../../i18n';
import { useAuth } from '../../stores/auth';
import { SettingsPage } from '../settings/SettingsPage';
import { MapsPage } from './MapsPage';
import { RobotAdminPage } from './RobotAdminPage';

export type StepKey = 'floors' | 'plans' | 'robots' | 'chargers' | 'cameras' | 'calibration' | 'rules';
export interface SetupStatus {
  blank: boolean;
  done: number;
  total: number;
  steps: { key: StepKey; done: boolean; missing: string[] }[];
}

/** 每一步嵌入哪個管理頁（前端頁面「新場域設定精靈」：每步嵌入對應管理頁的表單）與需要的權限 */
const EMBED: Record<StepKey, { page: () => JSX.Element; perm: 'maps' | 'robotmgr' | 'settings'; bulk?: ImportKind }> = {
  floors: { page: MapsPage, perm: 'maps' },
  plans: { page: MapsPage, perm: 'maps' },
  robots: { page: RobotAdminPage, perm: 'robotmgr', bulk: 'robots' },
  chargers: { page: MapsPage, perm: 'maps' },
  cameras: { page: MapsPage, perm: 'maps', bulk: 'cameras' },
  calibration: { page: MapsPage, perm: 'maps' },
  rules: { page: SettingsPage, perm: 'settings' },
};

export const setupStatusQuery = { queryKey: ['site', 'setup-status'], queryFn: () => api<SetupStatus>('/site/setup-status') };

/**
 * 新場域設定精靈（/setup；系統規格書「場域快速設定」、T-46）：
 * 樓層 → 平面圖 → 機器人 → 充電樁 → 攝影機 → 座標校正 → 規則。左側步驟與完成勾選，右側嵌入對應的管理頁；
 * 完成與否由後端即時判斷（GET /site/setup-status），在嵌入的頁面改完資料，勾選就會更新。
 */
export function SetupPage() {
  const qc = useQueryClient();
  const can = useAuth((s) => s.can);
  const status = useQuery({ ...setupStatusQuery, refetchInterval: 5_000 });
  const [current, setCurrent] = useState<StepKey | null>(null);
  const [bulk, setBulk] = useState<ImportKind | null>(null);
  const steps = status.data?.steps ?? [];
  // 預設停在第一個還沒完成的步驟
  const key = current ?? steps.find((s) => !s.done)?.key ?? 'floors';
  const idx = Math.max(0, steps.findIndex((s) => s.key === key));
  const step = steps[idx];
  const embed = EMBED[key];
  const Page = embed.page;

  let body: ReactNode;
  if (!can(embed.perm)) body = <p className="notice">{t('setup.noPerm', { page: t(`setup.page.${embed.perm}`) })}</p>;
  else
    body = (
      <div className="setup-embed">
        <Page />
      </div>
    );

  return (
    <div className="setup">
      <aside className="panel setup-steps">
        <div className="pane-head">
          <span className="title">{t('page.setup')}</span>
          <span className="meta">{status.data ? t('setup.progress', { done: status.data.done, total: status.data.total }) : ''}</span>
        </div>
        <div className="setup-bar" role="progressbar" aria-valuemin={0} aria-valuemax={status.data?.total ?? 7} aria-valuenow={status.data?.done ?? 0}>
          <i style={{ width: `${status.data ? (status.data.done / status.data.total) * 100 : 0}%` }} />
        </div>
        <ol>
          {steps.map((s, i) => (
            <li key={s.key}>
              <button type="button" className={`${s.key === key ? 'on' : ''} ${s.done ? 'done' : ''}`} aria-current={s.key === key ? 'step' : undefined} onClick={() => setCurrent(s.key)}>
                <span className="num" aria-hidden="true">
                  {s.done ? '✓' : i + 1}
                </span>
                <span className="lbl">
                  {t(`setup.step.${s.key}`)}
                  <small>{s.done ? t('setup.done') : t('setup.todo', { n: s.missing.length })}</small>
                </span>
              </button>
            </li>
          ))}
        </ol>
        <p className="hint">
          {t('setup.importHint')} <Link to="/site">{t('page.site')}</Link>
        </p>
      </aside>

      <section className="panel setup-main">
        {step && (
          <>
            <div className="pane-head">
              <span className="title">
                {t('setup.stepN', { n: idx + 1 })}　{t(`setup.step.${step.key}`)}
              </span>
              <span className={`badge2 ${step.done ? 'ok' : 'unreg'}`}>{step.done ? t('setup.done') : t('setup.notDone')}</span>
              <span className="push" />
              {embed.bulk && can(embed.perm) && (
                <button type="button" className="obtn" onClick={() => setBulk(embed.bulk!)}>
                  {t('bulk.open')}
                </button>
              )}
              <button type="button" className="obtn" disabled={idx === 0} onClick={() => setCurrent(steps[idx - 1].key)}>
                {t('setup.prev')}
              </button>
              <button type="button" className="btn primary" disabled={idx >= steps.length - 1} onClick={() => setCurrent(steps[idx + 1].key)}>
                {t('setup.next')}
              </button>
            </div>
            <div className="setup-guide">
              <p>{t(`setup.guide.${step.key}`)}</p>
              {step.missing.length > 0 && (
                <ul className="setup-missing" aria-label={t('setup.missing')}>
                  {step.missing.map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
              )}
            </div>
            {body}
          </>
        )}
      </section>
      {bulk && (
        <BulkImportDialog
          kind={bulk}
          onClose={() => setBulk(null)}
          onDone={() => {
            void qc.invalidateQueries();
          }}
        />
      )}
    </div>
  );
}
