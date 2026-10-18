import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { formatTime, t } from '../../i18n';
import { tr } from '../reports/time';

export interface VersionsResp {
  backend: { version: string; commit: string | null; node: string; startedAt: string };
  adapters: { name: string; version: string | null; alive: boolean | null; lastSeen: string | null; robots: string[] }[];
  robots: { id: string; code: string; brand: string; model: string; serialNo: string | null; adapter: string; enabled: boolean; online: boolean }[];
}

/**
 * 版本管理（/versions，原型「版本管理」）：平台（後端、前端）、各轉接器（心跳回報的版本、連線狀態、管理的機器人）、
 * 機器人清單。機器人韌體版本與韌體推送要等各家 SDK 提供，目前不做（原型的「上傳版本」）。
 */
export function VersionsPage() {
  const v = useQuery({ queryKey: ['versions'], queryFn: () => api<VersionsResp>('/versions'), refetchInterval: 15_000 });
  const d = v.data;
  return (
    <div className="pg2">
      <section className="panel">
        <div className="pane-head">
          <span className="title">{t('page.versions')}</span>
          <span className="meta">{d && t('versions.meta', { a: d.adapters.length, r: d.robots.length })}</span>
        </div>
        <div className="scroll">
          <div className="pane-body vs-body">
            <h3 className="vs-h">{t('versions.platform')}</h3>
            <div className="tbl-wrap">
              <table className="dtbl">
                <thead>
                  <tr>
                    <th>{t('versions.col.component')}</th>
                    <th>{t('versions.col.version')}</th>
                    <th>{t('versions.col.detail')}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>{t('versions.backend')}</td>
                    <td className="mono">{d?.backend.version ?? '—'}</td>
                    <td className="mono">{d && t('versions.backendDetail', { node: d.backend.node, at: formatTime(d.backend.startedAt), commit: d.backend.commit ?? '—' })}</td>
                  </tr>
                  <tr>
                    <td>{t('versions.frontend')}</td>
                    <td className="mono">{__APP_VERSION__}</td>
                    <td className="mono">{t('versions.frontendDetail', { at: formatTime(__BUILD_TIME__) })}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <h3 className="vs-h">{t('versions.adapters')}</h3>
            <div className="tbl-wrap">
              <table className="dtbl">
                <thead>
                  <tr>
                    <th>{t('versions.col.adapter')}</th>
                    <th>{t('versions.col.version')}</th>
                    <th>{t('versions.col.status')}</th>
                    <th>{t('versions.col.lastSeen')}</th>
                    <th>{t('versions.col.robots')}</th>
                  </tr>
                </thead>
                <tbody>
                  {d?.adapters.length === 0 && (
                    <tr>
                      <td colSpan={5} className="tbl-empty">
                        {t('versions.noAdapters')}
                      </td>
                    </tr>
                  )}
                  {d?.adapters.map((a) => (
                    <tr key={a.name}>
                      <td className="mono">{a.name}</td>
                      <td className="mono">{a.version ?? '—'}</td>
                      <td>
                        {a.alive ? (
                          <span className="badge2 ok">{t('versions.alive')}</span>
                        ) : a.alive === false ? (
                          <span className="badge2 bad">{t('versions.down')}</span>
                        ) : (
                          <span className="badge2">{t('versions.never')}</span>
                        )}
                      </td>
                      <td className="mono">{a.lastSeen ? formatTime(a.lastSeen) : '—'}</td>
                      <td className="mono">{a.robots.join('、') || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <h3 className="vs-h">{t('versions.robots')}</h3>
            <div className="tbl-wrap">
              <table className="dtbl">
                <thead>
                  <tr>
                    <th>{t('robotmgr.col.code')}</th>
                    <th>{t('robotmgr.col.model')}</th>
                    <th>{t('robotmgr.col.serial')}</th>
                    <th>{t('robotmgr.col.adapter')}</th>
                    <th>{t('versions.col.firmware')}</th>
                    <th>{t('robotmgr.col.status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {d?.robots.map((r) => (
                    <tr key={r.id} className={r.enabled ? '' : 'off'}>
                      <td className="mono">{r.code}</td>
                      <td>
                        {tr(`brand.${r.brand}`, r.brand)} {r.model}
                      </td>
                      <td className="mono">{r.serialNo ?? '—'}</td>
                      <td className="mono">{r.adapter}</td>
                      <td className="muted">{t('versions.firmwarePending')}</td>
                      <td>
                        {!r.enabled ? (
                          <span className="badge2">{t('robotmgr.status.disabled')}</span>
                        ) : r.online ? (
                          <span className="badge2 ok">{t('robotmgr.status.online')}</span>
                        ) : (
                          <span className="badge2 unreg">{t('robotmgr.status.offline')}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </section>
      <aside className="panel filt">
        <div className="scroll">
          <div className="filt-in">
            <p className="hint">{t('versions.hint')}</p>
            <p className="hint">{t('versions.hintFirmware')}</p>
          </div>
        </div>
      </aside>
    </div>
  );
}
