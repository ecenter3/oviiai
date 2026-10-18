import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { formatTime, t, type MessageKey } from '../../i18n';
import { dayRange, duration, taipeiDate, tr } from './time';

interface RobotRow {
  id: string;
  code: string;
}
interface Floor {
  id: string;
  name: string;
}
interface Entry {
  at: string;
  end: string | null;
  state: string;
  reason: string | null;
  durationMs: number;
  carried: boolean;
}
export interface RunlogResp {
  code: string;
  floorId: string;
  entries: Entry[];
  totals: Record<string, number>;
  truncated: boolean;
}

/** 原型：待命、離線、充電顯示「○○時間」，其他「持續時間」 */
const DUR_LABEL: Record<string, MessageKey> = { idle: 'runlog.dur.idle', offline: 'runlog.dur.offline', charging: 'runlog.dur.charging' };

const stateLabel = (s: string) => tr(`state.${s}`, s);
const reasonLabel = (r: string | null) => (r ? tr(`runlog.reason.${r}`, r) : t('runlog.reason.auto'));

/**
 * 機器人運行日誌（/runlog，原型「機器人運行日誌」）：選日期、時段、機器人，列出狀態時間軸（新的在前），
 * 每段顯示起訖、持續時間、原因、所在地圖；上方彙總各狀態總時長。資料來自 robot_state_log。
 */
export function RunlogPage() {
  const robots = useQuery({ queryKey: ['robots', 'list'], queryFn: () => api<RobotRow[]>('/robots') });
  const floors = useQuery({ queryKey: ['floors'], queryFn: () => api<Floor[]>('/floors') });
  const [draft, setDraft] = useState({ date: taipeiDate(), from: '00:00', to: '23:59', robotId: '' });
  const [q, setQ] = useState(draft);

  useEffect(() => {
    if (!draft.robotId && robots.data?.length) {
      const robotId = robots.data[0].id;
      setDraft((d) => ({ ...d, robotId }));
      setQ((d) => ({ ...d, robotId }));
    }
  }, [robots.data, draft.robotId]);

  const range = dayRange(q.date, q.from, q.to);
  const data = useQuery({
    queryKey: ['runlog', q.robotId, range.from, range.to],
    queryFn: () => api<RunlogResp>(`/runlog/${q.robotId}?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`),
    enabled: !!q.robotId,
  });
  const d = data.data;
  const mapName = floors.data?.find((f) => f.id === d?.floorId)?.name ?? '—';
  const totals = d ? Object.entries(d.totals).sort((a, b) => b[1] - a[1]) : [];

  return (
    <div className="pg2">
      <section className="panel">
        <div className="pane-head">
          <span className="title">{t('page.runlog')}</span>
          <span className="meta">{d && t('runlog.meta', { code: d.code, date: q.date, n: d.entries.length })}</span>
        </div>
        <div className="scroll">
          {totals.length > 0 && (
            <div className="rl-totals" aria-label={t('runlog.totals')}>
              {totals.map(([s, ms]) => (
                <span key={s} className={`rl-tot st-${s}`}>
                  {stateLabel(s)} <b>{duration(ms)}</b>
                </span>
              ))}
            </div>
          )}
          <div className="tl">
            {d && d.entries.length === 0 && <p className="empty-state">{t('runlog.empty')}</p>}
            {d?.entries.map((e, i) => (
              <div key={`${e.at}-${i}`} className="tl-item">
                <span className="tl-n">{i + 1}</span>
                <div>
                  <div className="tl-top">
                    <span>
                      {e.carried ? t('runlog.carried', { t: formatTime(e.at) }) : formatTime(e.at)} —— {e.end ? formatTime(e.end) : t('runlog.ongoing')}
                    </span>
                    <span className="tl-dur">
                      {t(DUR_LABEL[e.state] ?? 'runlog.dur.other')}：{duration(e.durationMs)}
                    </span>
                    <span className="tl-op">{t('runlog.reason', { r: reasonLabel(e.reason) })}</span>
                  </div>
                  <div className={`tl-box st-${e.state}`}>
                    <b>{stateLabel(e.state)}</b>
                    <span>{t('runlog.map', { name: mapName })}</span>
                  </div>
                </div>
              </div>
            ))}
            {d?.truncated && <p className="hint">{t('runlog.truncated')}</p>}
          </div>
        </div>
      </section>
      <aside className="panel filt">
        <form
          className="scroll filt-in"
          onSubmit={(e) => {
            e.preventDefault();
            setQ(draft);
          }}
        >
          <label className="fl">
            {t('energy.date')}
            <input type="date" value={draft.date} max={taipeiDate()} onChange={(e) => e.target.value && setDraft({ ...draft, date: e.target.value })} />
          </label>
          <div className="fl">
            {t('runlog.time')}
            <div className="trange">
              <input type="time" aria-label={t('energy.time.from')} value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value || '00:00' })} />
              <span>~</span>
              <input type="time" aria-label={t('energy.time.to')} value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value || '23:59' })} />
            </div>
          </div>
          <label className="fl">
            {t('energy.robot')}
            <select
              value={draft.robotId}
              onChange={(e) => {
                const next = { ...draft, robotId: e.target.value };
                setDraft(next);
                setQ(next);
              }}
            >
              {robots.data?.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.code}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="go2">
            {t('runlog.search')}
          </button>
        </form>
      </aside>
    </div>
  );
}
