import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, ApiError } from '../../api/client';
import { formatTime, t } from '../../i18n';
import { useToast } from '../../stores/toast';

const SUBSYSTEMS = ['motion', 'video', 'interaction', 'system'] as const;
type Subsystem = (typeof SUBSYSTEMS)[number];
export interface RobotLog {
  id: string;
  robotId: string;
  robotCode: string;
  subsystem: Subsystem;
  status: 'requested' | 'uploaded' | 'failed';
  sizeBytes: number | null;
  error: string | null;
  requestedByName: string | null;
  createdAt: string;
  uploadedAt: string | null;
  fileName: string;
}
interface RobotRow {
  id: string;
  code: string;
}
const size = (b: number | null) => (b == null ? '—' : b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${(b / 1024).toFixed(1)} KB`);
const SIZE = 20;

/**
 * 日誌管理（/logs，原型「日誌管理」）：選機器人與子系統按「獲取文件」，機器人上傳完成後出現在列表可下載；
 * 上傳中每 3 秒更新。保存 30 天。
 */
export function LogsPage() {
  const qc = useQueryClient();
  const robots = useQuery({ queryKey: ['robots', 'list'], queryFn: () => api<RobotRow[]>('/robots'), retry: false });
  const [robotId, setRobotId] = useState('');
  const [sub, setSub] = useState<Subsystem>('motion');
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const qs = new URLSearchParams({ page: String(page), size: String(SIZE) });
  if (robotId) qs.set('robotId', robotId);
  const list = useQuery({
    queryKey: ['robot-logs', qs.toString()],
    queryFn: () => api<{ items: RobotLog[]; total: number }>(`/robot-logs?${qs}`),
    refetchInterval: (q) => (q.state.data?.items.some((i) => i.status === 'requested') ? 3000 : false),
  });
  const toast = useToast.getState().show;
  const target = robotId;
  const pages = Math.max(1, Math.ceil((list.data?.total ?? 0) / SIZE));

  async function request() {
    if (!target) return;
    setBusy(true);
    try {
      const r = await api<RobotLog>('/robot-logs', { method: 'POST', json: { robotId: target, subsystem: sub } });
      toast(t('logs.requested', { code: r.robotCode, sub: t(`logs.sub.${sub}`) }), 'ok');
      await qc.invalidateQueries({ queryKey: ['robot-logs'] });
    } catch (e) {
      toast(e instanceof ApiError ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function download(l: RobotLog) {
    try {
      const { url } = await api<{ url: string }>(`/robot-logs/${l.id}/url`);
      const a = document.createElement('a');
      a.href = url;
      a.rel = 'noopener';
      document.body.append(a);
      a.click();
      a.remove();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : String(e), 'error');
    }
  }

  return (
    <div className="pg2">
      <section className="panel">
        <div className="pane-head">
          <span className="title">{t('page.logs')}</span>
          <span className="meta">{t('logs.meta', { n: list.data?.total ?? 0 })}</span>
        </div>
        <div className="scroll">
          <div className="pane-body">
            <div className="tbl-wrap">
              <table className="dtbl">
                <thead>
                  <tr>
                    <th>{t('alarm.col.no')}</th>
                    <th>{t('logs.col.robot')}</th>
                    <th>{t('logs.col.sub')}</th>
                    <th>{t('logs.col.file')}</th>
                    <th>{t('logs.col.size')}</th>
                    <th>{t('logs.col.at')}</th>
                    <th>{t('logs.col.by')}</th>
                    <th>{t('logs.col.status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {list.data?.items.length === 0 && (
                    <tr>
                      <td colSpan={8} className="tbl-empty">
                        {t('logs.empty')}
                      </td>
                    </tr>
                  )}
                  {list.data?.items.map((l, i) => (
                    <tr key={l.id}>
                      <td>{(page - 1) * SIZE + i + 1}</td>
                      <td className="mono">{l.robotCode}</td>
                      <td>{t(`logs.sub.${l.subsystem}`)}</td>
                      <td className="mono">{l.fileName}</td>
                      <td className="num">{size(l.sizeBytes)}</td>
                      <td className="mono">{formatTime(l.createdAt)}</td>
                      <td>{l.requestedByName ?? '—'}</td>
                      <td>
                        {l.status === 'uploaded' ? (
                          <button type="button" className="obtn" onClick={() => void download(l)}>
                            {t('logs.download')}
                          </button>
                        ) : l.status === 'requested' ? (
                          <span className="badge2 blue">{t('logs.uploading')}</span>
                        ) : (
                          <span className="badge2 bad" title={l.error ?? ''}>
                            {t('logs.failed')}
                            {l.error ? `：${l.error}` : ''}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {list.data && list.data.total > SIZE && (
              <div className="pager">
                <span>{t('alarm.pager', { total: list.data.total })}</span>
                <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} aria-label={t('alarm.pager.prev')}>
                  ‹
                </button>
                <span className="mono">
                  {page} / {pages}
                </span>
                <button type="button" disabled={page >= pages} onClick={() => setPage((p) => p + 1)} aria-label={t('alarm.pager.next')}>
                  ›
                </button>
              </div>
            )}
          </div>
        </div>
      </section>
      <aside className="panel filt">
        <div className="scroll">
          <div className="filt-in">
            <label className="fl">
              {t('logs.robot')}
              <select
                value={robotId}
                onChange={(e) => {
                  setRobotId(e.target.value);
                  setPage(1);
                }}
              >
                <option value="">{t('report.allRobots')}</option>
                {robots.data?.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.code}
                  </option>
                ))}
              </select>
            </label>
            <label className="fl">
              {t('logs.col.sub')}
              <select value={sub} onChange={(e) => setSub(e.target.value as Subsystem)}>
                {SUBSYSTEMS.map((s) => (
                  <option key={s} value={s}>
                    {t(`logs.sub.${s}`)}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="go2 warn" disabled={busy || !target} onClick={() => void request()}>
              {t('logs.get')}
            </button>
            {!robotId && <p className="fhint">{t('logs.pickRobot')}</p>}
            <p className="hint">{t('logs.hint')}</p>
          </div>
        </div>
      </aside>
    </div>
  );
}
