import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, ApiError, download } from '../../api/client';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { t, type MessageKey } from '../../i18n';
import { useAuth } from '../../stores/auth';
import { useToast } from '../../stores/toast';

type Action = 'add' | 'update' | 'delete' | 'disable' | 'keep';
interface Change {
  key: string;
  action: Action;
  fields?: string[];
  note?: string;
}
export interface Preview {
  version: number;
  summary: Record<Action, number>;
  sections: { entity: string; changes: Change[] }[];
  warnings: string[];
  applied: boolean;
}

const ACTIONS: Action[] = ['add', 'update', 'delete', 'disable', 'keep'];
const TONE: Record<Action, string> = { add: 'ok', update: 'blue', delete: 'black', disable: 'unreg', keep: '' };
const tr = (prefix: string, k: string) => {
  const key = `${prefix}.${k}` as MessageKey;
  const s = t(key);
  return s === key ? k : s;
};

async function send(file: File, dryRun: boolean): Promise<Preview> {
  const body = new FormData();
  body.append('file', file);
  return api<Preview>(`/site/import${dryRun ? '?dryRun=true' : ''}`, { method: 'POST', body });
}

/**
 * 場域匯出／匯入（/site，前端頁面「場域快速設定」；T-44）。原型沒有這頁，沿用管理頁樣式。
 * 匯出：下載 zip（site.json＋平面圖），不含秘密。匯入：先顯示差異表（新增／修改／刪除），確認才套用。
 */
export function SitePage() {
  const qc = useQueryClient();
  const canApply = useAuth((s) => s.can('op.config'));
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);

  async function exportZip() {
    setBusy(true);
    try {
      const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(new Date()).replace(/-/g, '');
      await download('/site/export', `oviiai-site-${day}.zip`);
    } catch (e) {
      useToast.getState().show(e instanceof ApiError ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function run(dryRun: boolean) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const p = await send(file, dryRun);
      setPreview(p);
      if (!dryRun) {
        useToast.getState().show(t('site.applied', p.summary), 'ok');
        // 全部資料都可能變了
        await qc.invalidateQueries();
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }

  const changed = preview?.sections.filter((s) => s.changes.length) ?? [];
  const destructive = (preview?.summary.delete ?? 0) + (preview?.summary.disable ?? 0);

  return (
    <div className="page">
      <h1 className="page-h">{t('page.site')}</h1>
      <div className="sgrid">
        <section className="dcard">
          <h3>{t('site.export')}</h3>
          <p className="hint">{t('site.export.body')}</p>
          <ul className="site-list">
            <li>{t('site.export.has')}</li>
            <li>{t('site.export.not')}</li>
          </ul>
          <div className="row">
            <button type="button" className="btn primary" disabled={busy} onClick={() => void exportZip()}>
              {t('site.export.btn')}
            </button>
          </div>
        </section>

        <section className="dcard">
          <h3>{t('site.import')}</h3>
          <p className="hint">{t('site.import.body')}</p>
          <input
            type="file"
            accept=".zip,.json,application/zip,application/json"
            aria-label={t('site.import.file')}
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setPreview(null);
              setError(null);
            }}
          />
          {!canApply && <p className="notice">{t('site.import.noPerm')}</p>}
          <div className="row">
            <button type="button" className="btn" disabled={!file || busy} onClick={() => void run(true)}>
              {t('site.preview')}
            </button>
            {canApply && (
              <button type="button" className="btn primary" disabled={!preview || preview.applied || busy} onClick={() => setConfirm(true)}>
                {t('site.apply')}
              </button>
            )}
          </div>
          {error && (
            <p className="err" role="alert">
              {error}
            </p>
          )}
        </section>

        {preview && (
          <section className="dcard wide" aria-label={preview.applied ? t('site.diff.applied') : t('site.diff')}>
            <h3>
              {preview.applied ? t('site.diff.applied') : t('site.diff')}
              <span className="chips">
                {ACTIONS.filter((a) => preview.summary[a]).map((a) => (
                  <span key={a} className={`badge2 ${TONE[a]}`}>
                    {t(`site.action.${a}`)} {preview.summary[a]}
                  </span>
                ))}
              </span>
            </h3>
            {preview.warnings.length > 0 && (
              <ul className="site-warn">
                {preview.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}
            {changed.length === 0 ? (
              <p className="empty-state">{t('site.noChange')}</p>
            ) : (
              changed.map((s) => (
                <div key={s.entity} className="site-sec">
                  <h4>
                    {tr('site.entity', s.entity)}（{s.changes.length}）
                  </h4>
                  <div className="tbl-wrap">
                    <table className="dtbl">
                      <thead>
                        <tr>
                          <th>{t('site.col.item')}</th>
                          <th>{t('site.col.action')}</th>
                          <th>{t('site.col.detail')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {s.changes.map((c) => (
                          <tr key={c.key}>
                            <td>{c.key}</td>
                            <td>
                              <span className={`badge2 ${TONE[c.action]}`}>{t(`site.action.${c.action}`)}</span>
                            </td>
                            <td>{c.fields ? c.fields.map((f) => tr('site.field', f)).join('、') : (c.note ?? '')}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))
            )}
          </section>
        )}
      </div>
      {confirm && preview && (
        <ConfirmDialog
          title={t('site.apply')}
          body={t('site.confirm', { ...preview.summary, extra: destructive ? t('site.confirm.destructive') : '' })}
          confirmText={t('site.apply')}
          danger={destructive > 0}
          onCancel={() => setConfirm(false)}
          onConfirm={() => {
            setConfirm(false);
            void run(false);
          }}
        />
      )}
    </div>
  );
}
