import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../../api/client';
import { LevelTag } from '../../components/AlarmTags';
import { EnvThresholds } from '../../components/EnvThresholds';
import { t, type MessageKey } from '../../i18n';
import type { AlarmCategory } from '../../stores/alarms';
import { useToast } from '../../stores/toast';

export interface AlarmRule {
  type: string;
  category: AlarmCategory;
  name: string;
  level: 1 | 2 | 3;
  popup: boolean;
  sound: boolean;
  needHandle: boolean;
  smsUserIds: string[];
  dedupSec: number;
}
interface RuleUser {
  id: string;
  username: string;
  displayName: string;
  hasPhone: boolean;
}

/**
 * 告警設置（/alarms/settings，原型「告警設置」）。手冊以告警項目為單位（alarm_rules）：
 * 各項目的等級、音效提醒、彈窗提醒、處理事件（需處理）、合併秒數、簡訊接收人（穿梭框）。
 * 下方是環境數值門檻（T-41，與環境監測頁側欄共用）。
 */
export function AlarmSettingsPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['alarm-rules'], queryFn: () => api<{ rules: AlarmRule[]; users: RuleUser[] }>('/alarm-rules') });
  const [draft, setDraft] = useState<AlarmRule[]>([]);
  const [recv, setRecv] = useState<AlarmRule | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (q.data) setDraft(q.data.rules);
  }, [q.data]);

  const changed = useMemo(() => {
    const orig = new Map((q.data?.rules ?? []).map((r) => [r.type, JSON.stringify(r)]));
    return draft.filter((r) => orig.get(r.type) !== JSON.stringify(r));
  }, [draft, q.data]);

  const patch = (type: string, p: Partial<AlarmRule>) => setDraft((list) => list.map((r) => (r.type === type ? { ...r, ...p } : r)));

  async function save() {
    setSaving(true);
    try {
      const r = await api<{ rules: AlarmRule[] }>('/alarm-rules', {
        method: 'PUT',
        json: { rules: changed.map(({ category: _c, name: _n, ...rest }) => rest) },
      });
      qc.setQueryData(['alarm-rules'], (old: { rules: AlarmRule[]; users: RuleUser[] } | undefined) => (old ? { ...old, rules: r.rules } : old));
      useToast.getState().show(t('alarmset.saved'), 'ok');
    } catch (e) {
      useToast.getState().show(e instanceof ApiError ? e.message : String(e), 'error');
    } finally {
      setSaving(false);
    }
  }

  const groups: AlarmCategory[] = ['system', 'business'];
  let no = 0;

  return (
    <div className="pg1">
      <section className="panel">
        <div className="pane-head">
          <span className="title">{t('page.alarmset')}</span>
          <span className="meta">{t('alarmset.meta')}</span>
        </div>
        <div className="scroll">
          <div className="pane-body">
            {q.isError && <p className="error">{q.error instanceof ApiError ? q.error.message : String(q.error)}</p>}
            <div className="tbl-wrap">
              <table className="dtbl">
                <thead>
                  <tr>
                    <th>{t('alarm.col.no')}</th>
                    <th>{t('alarmset.col.name')}</th>
                    <th>{t('alarmset.col.level')}</th>
                    <th>{t('alarmset.col.sound')}</th>
                    <th>{t('alarmset.col.popup')}</th>
                    <th>{t('alarmset.col.handle')}</th>
                    <th>{t('alarmset.col.dedup')}</th>
                    <th>{t('alarmset.col.sms')}</th>
                  </tr>
                </thead>
                {groups.map((g) => (
                  <tbody key={g}>
                    <tr className="sub">
                      <td colSpan={8}>{t(`alarm.cat.${g}` as MessageKey)}</td>
                    </tr>
                    {draft
                      .filter((r) => r.category === g)
                      .map((r) => (
                        <tr key={r.type} data-rule={r.type}>
                          <td>{++no}</td>
                          <td>
                            {r.name}
                            <div className="sub mono">{r.type}</div>
                          </td>
                          <td>
                            <div className="acts">
                              <LevelTag level={r.level} />
                              <select
                                aria-label={`${r.name} ${t('alarmset.col.level')}`}
                                value={r.level}
                                onChange={(e) => patch(r.type, { level: Number(e.target.value) as 1 | 2 | 3 })}
                              >
                                {[1, 2, 3].map((l) => (
                                  <option key={l} value={l}>
                                    {t(`alarm.level.${l}` as MessageKey)}
                                  </option>
                                ))}
                              </select>
                            </div>
                          </td>
                          {(['sound', 'popup', 'needHandle'] as const).map((k) => (
                            <td key={k}>
                              <span className="switch sm">
                                <input
                                  type="checkbox"
                                  aria-label={`${r.name} ${t(k === 'needHandle' ? 'alarmset.col.handle' : k === 'sound' ? 'alarmset.col.sound' : 'alarmset.col.popup')}`}
                                  checked={r[k]}
                                  onChange={(e) => patch(r.type, { [k]: e.target.checked })}
                                />
                                <i />
                              </span>
                            </td>
                          ))}
                          <td>
                            <input
                              className="num-in"
                              type="number"
                              min={0}
                              max={3600}
                              aria-label={`${r.name} ${t('alarmset.col.dedup')}`}
                              value={r.dedupSec}
                              onChange={(e) => patch(r.type, { dedupSec: Math.max(0, Math.min(3600, Math.round(Number(e.target.value) || 0))) })}
                            />
                          </td>
                          <td>
                            <button type="button" className="lnk" onClick={() => setRecv(r)}>
                              {t('alarmset.recv', { n: r.smsUserIds.length })}
                            </button>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                ))}
              </table>
            </div>
            <p className="hint">{t('alarmset.hint')}</p>
            <div className="save-bar">
              {changed.length > 0 && <span className="err">{t('alarmset.dirty')}</span>}
              <button type="button" className="btn" disabled={!changed.length || saving} onClick={() => q.data && setDraft(q.data.rules)}>
                {t('common.cancel')}
              </button>
              <button type="button" className="btn primary" disabled={!changed.length || saving} onClick={() => void save()}>
                {t('common.save')}
              </button>
            </div>
            <h3 className="vs-h">{t('alarmset.envTitle')}</h3>
            <p className="hint">{t('alarmset.envHint')}</p>
            <EnvThresholds />
          </div>
        </div>
      </section>
      {recv && q.data && (
        <RecipientsDialog
          rule={recv}
          users={q.data.users}
          onClose={() => setRecv(null)}
          onOk={(ids) => {
            patch(recv.type, { smsUserIds: ids });
            setRecv(null);
          }}
        />
      )}
    </div>
  );
}

/** 簡訊接收人穿梭框（原型 recvModal） */
function RecipientsDialog({ rule, users, onClose, onOk }: { rule: AlarmRule; users: RuleUser[]; onClose(): void; onOk(ids: string[]): void }) {
  const [right, setRight] = useState(() => new Set(rule.smsUserIds));
  const [selL, setSelL] = useState<Set<string>>(new Set());
  const [selR, setSelR] = useState<Set<string>>(new Set());
  const left = users.filter((u) => !right.has(u.id));
  const chosen = users.filter((u) => right.has(u.id));
  const toggle = (set: Set<string>, id: string) => {
    const n = new Set(set);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  };
  const row = (u: RuleUser, sel: Set<string>, setSel: (s: Set<string>) => void) => (
    <label key={u.id}>
      <input type="checkbox" checked={sel.has(u.id)} onChange={() => setSel(toggle(sel, u.id))} />
      {u.displayName}
      <small>
        {u.username}
        {u.hasPhone ? '' : ` · ${t('alarmset.recv.noPhone')}`}
      </small>
    </label>
  );
  return (
    <div className="modal-bg" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="modal wide-modal" role="dialog" aria-modal="true" aria-label={t('alarmset.recv.title', { name: rule.name })}>
        <h2>{t('alarmset.recv.title', { name: rule.name })}</h2>
        <div className="xfer">
          <div className="box3">
            <h4>{t('alarmset.recv.left', { n: left.length })}</h4>
            {left.map((u) => row(u, selL, setSelL))}
          </div>
          <div className="mid">
            <button
              type="button"
              className="obtn"
              aria-label={t('alarmset.recv.add')}
              disabled={!selL.size}
              onClick={() => {
                setRight(new Set([...right, ...selL]));
                setSelL(new Set());
              }}
            >
              ›
            </button>
            <button
              type="button"
              className="obtn"
              aria-label={t('alarmset.recv.remove')}
              disabled={!selR.size}
              onClick={() => {
                setRight(new Set([...right].filter((id) => !selR.has(id))));
                setSelR(new Set());
              }}
            >
              ‹
            </button>
          </div>
          <div className="box3">
            <h4>{t('alarmset.recv.right', { n: chosen.length })}</h4>
            {chosen.map((u) => row(u, selR, setSelR))}
          </div>
        </div>
        <p className="hint">{t('alarmset.recv.hint')}</p>
        <div className="row">
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn primary" onClick={() => onOk([...right])}>
            {t('common.ok')}
          </button>
        </div>
      </div>
    </div>
  );
}
