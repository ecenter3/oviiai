import { useEffect, useRef, useState } from 'react';
import { api, ApiError, download } from '../api/client';
import { t } from '../i18n';
import { useToast } from '../stores/toast';

export type ImportKind = 'cameras' | 'robots';
interface RowResult {
  rowNo: number;
  code: string;
  action: 'create' | 'update' | null;
  errors: { field: string; message: string }[];
}
export interface ImportResult {
  total: number;
  valid: number;
  invalid: number;
  imported: number;
  rows: RowResult[];
}

/** multipart 上傳（api() 只送 JSON；FormData 讓瀏覽器自己帶 boundary） */
async function upload(kind: ImportKind, file: File, dryRun: boolean): Promise<ImportResult> {
  const body = new FormData();
  body.append('file', file);
  return api<ImportResult>(`/${kind}/import${dryRun ? '?dryRun=true' : ''}`, { method: 'POST', body });
}

/**
 * 批次匯入（前端頁面「批次匯入」：下載範本、上傳、逐列結果表、只匯入正確列；T-45）。
 * 先檢查（dryRun）列出每列結果，確認後才匯入正確的列。
 */
export function BulkImportDialog({ kind, onClose, onDone }: { kind: ImportKind; onClose(): void; onDone(): void }) {
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => close.current?.focus(), []);
  const what = t(`bulk.kind.${kind}`);

  async function run(dryRun: boolean) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const r = await upload(kind, file, dryRun);
      setResult(r);
      if (!dryRun) {
        useToast.getState().show(t('bulk.done', { n: r.imported, what, skipped: r.invalid }), r.invalid ? 'warn' : 'ok');
        onDone();
        onClose();
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const tpl = (format: 'xlsx' | 'csv') =>
    void download(`/import/templates/${kind}?format=${format}`, `${what}${t('bulk.template')}.${format}`).catch((e) => setError(e instanceof ApiError ? e.message : String(e)));

  return (
    <div className="modal-bg" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="modal wide2" role="dialog" aria-modal="true" aria-label={t('bulk.title', { what })}>
        <h2>{t('bulk.title', { what })}</h2>
        <ol className="bulk-steps">
          <li>
            {t('bulk.step1')}
            <span className="row">
              <button type="button" className="obtn" onClick={() => tpl('xlsx')}>
                {t('bulk.tplXlsx')}
              </button>
              <button type="button" className="obtn" onClick={() => tpl('csv')}>
                {t('bulk.tplCsv')}
              </button>
            </span>
          </li>
          <li>
            {t('bulk.step2')}
            <input
              type="file"
              accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              aria-label={t('bulk.file')}
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setResult(null);
                setError(null);
              }}
            />
          </li>
          <li>{t('bulk.step3')}</li>
        </ol>
        {error && (
          <p className="err" role="alert">
            {error}
          </p>
        )}
        {result && (
          <>
            <p className={result.invalid ? 'warn-text' : 'ok-text'}>{t('bulk.summary', { total: result.total, valid: result.valid, invalid: result.invalid })}</p>
            <div className="tbl-wrap bulk-result">
              <table className="dtbl">
                <thead>
                  <tr>
                    <th>{t('bulk.col.row')}</th>
                    <th>{t('bulk.col.code')}</th>
                    <th>{t('bulk.col.result')}</th>
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((r) => (
                    <tr key={r.rowNo} className={r.errors.length ? 'bad' : ''}>
                      <td>{r.rowNo}</td>
                      <td>{r.code || '—'}</td>
                      <td>
                        {r.errors.length ? (
                          <ul className="row-errs">
                            {r.errors.map((e) => (
                              <li key={e.field}>{e.message}</li>
                            ))}
                          </ul>
                        ) : (
                          <span className={`badge2 ${r.action === 'create' ? 'ok' : 'blue'}`}>{t(`bulk.action.${r.action ?? 'create'}`)}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        <div className="row">
          <button ref={close} type="button" className="btn" onClick={onClose}>
            {t('common.close')}
          </button>
          <button type="button" className="btn" disabled={!file || busy} onClick={() => void run(true)}>
            {t('bulk.check')}
          </button>
          <button type="button" className="btn primary" disabled={!result?.valid || busy} onClick={() => void run(false)}>
            {t('bulk.apply', { n: result?.valid ?? 0 })}
          </button>
        </div>
      </div>
    </div>
  );
}
