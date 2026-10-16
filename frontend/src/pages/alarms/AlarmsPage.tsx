import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, ApiError, download } from '../../api/client';
import { LevelTag, StatusTag } from '../../components/AlarmTags';
import { formatTime, t, type MessageKey } from '../../i18n';
import { ACTIONS, type Alarm, type AlarmCategory, STATUSES, useAlarms } from '../../stores/alarms';
import { useToast } from '../../stores/toast';
import { AlarmDialog, type FloorInfo } from './AlarmDialog';

interface Options {
  robots: { id: string; code: string; floorId: string }[];
  types: { type: string; name: string; category: AlarmCategory }[];
}
interface Filter {
  from: string;
  to: string;
  floor: string;
  robot: string;
  type: string;
  status: string;
  level: string;
  q: string;
}

const SIZE = 20;
const taipeiDay = (d: Date) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(d);
const addDays = (day: string, n: number) => taipeiDay(new Date(Date.parse(`${day}T12:00:00+08:00`) + n * 86_400_000));

/** 篩選條件 → 查詢字串（日期以台北時間整天計） */
export function alarmQuery(category: AlarmCategory, f: Filter, page: number): string {
  const p = new URLSearchParams({ category, page: String(page), size: String(SIZE) });
  if (f.from) p.set('from', `${f.from}T00:00:00+08:00`);
  if (f.to) p.set('to', `${addDays(f.to, 1)}T00:00:00+08:00`);
  for (const k of ['floor', 'robot', 'type', 'status', 'level', 'q'] as const) if (f[k].trim()) p.set(k, f[k].trim());
  return p.toString();
}

const initial = (): Filter => {
  const today = taipeiDay(new Date());
  return { from: addDays(today, -6), to: today, floor: '', robot: '', type: '', status: '', level: '', q: '' };
};

/**
 * 系統告警（/alarms/system）、業務告警（/alarms/business）：版面依原型「主區＋右側 290 px 篩選欄」。
 * 表格：序號、時間、告警名稱、機器人、處理時間、處理狀態、告警級別、操作（處理／查看 → 告警處理視窗）。
 * 篩選：日期、樓層、機器人、告警項目、處理狀態、級別、關鍵字；匯出符合條件的全部紀錄（CSV，Excel 可開）。
 * ?id=<告警 id> 直接開啟處理視窗（監控頁告警快訊、P1 彈窗「處理」跳過來）。
 */
export function AlarmsPage({ category }: { category: AlarmCategory }) {
  const [params, setParams] = useSearchParams();
  const [draft, setDraft] = useState<Filter>(initial);
  const [filter, setFilter] = useState<Filter>(draft);
  const [page, setPage] = useState(1);
  const openId = params.get('id');

  const floors = useQuery({ queryKey: ['floors'], queryFn: () => api<FloorInfo[]>('/floors') });
  const options = useQuery({ queryKey: ['alarms', 'options'], queryFn: () => api<Options>('/alarms/options') });
  const qs = alarmQuery(category, filter, page);
  const list = useQuery({
    queryKey: ['alarms', 'list', qs],
    queryFn: () => api<{ items: Alarm[]; total: number; unhandled: number }>(`/alarms?${qs}`),
    placeholderData: keepPreviousData,
  });

  // 有新告警或狀態變化（WebSocket）→ 重新查詢
  const version = useAlarms((s) => s.version);
  const { refetch } = list;
  useEffect(() => {
    if (version) void refetch();
  }, [version, refetch]);

  const robots = useMemo(
    () => (options.data?.robots ?? []).filter((r) => !draft.floor || r.floorId === draft.floor),
    [options.data, draft.floor],
  );
  const types = (options.data?.types ?? []).filter((x) => x.category === category);
  const floorName = (id: string | null) => (id ? (floors.data?.find((f) => f.id === id)?.name ?? id) : '—');
  const pages = Math.max(1, Math.ceil((list.data?.total ?? 0) / SIZE));
  const title = category === 'system' ? t('page.sysalarm') : t('page.bizalarm');

  const set = (k: keyof Filter) => (e: { target: { value: string } }) => setDraft((d) => ({ ...d, [k]: e.target.value, ...(k === 'floor' ? { robot: '' } : {}) }));
  function search() {
    setFilter(draft);
    setPage(1);
  }
  function open(id: string | null) {
    const next = new URLSearchParams(params);
    if (id) next.set('id', id);
    else next.delete('id');
    setParams(next, { replace: true });
  }
  async function exportCsv() {
    try {
      const stamp = taipeiDay(new Date()).replace(/-/g, '');
      await download(`/alarms?${alarmQuery(category, filter, 1)}&format=csv`, `${title}-${stamp}.csv`);
    } catch (e) {
      useToast.getState().show(e instanceof ApiError ? e.message : String(e), 'error');
    }
  }

  return (
    <div className="pg2">
      <section className="panel">
        <div className="pane-head">
          <span className="title">{title}</span>
          <span className="meta">{list.data ? t('alarm.meta', { n: list.data.unhandled }) : ''}</span>
          <button type="button" className="obtn" onClick={() => void exportCsv()}>
            {t('alarm.export')}
          </button>
        </div>
        <div className="scroll">
          <div className="pane-body">
            {list.isError && <p className="error">{list.error instanceof ApiError ? list.error.message : String(list.error)}</p>}
            <div className="tbl-wrap">
              <table className="dtbl">
                <thead>
                  <tr>
                    <th>{t('alarm.col.no')}</th>
                    <th>{t('alarm.col.time')}</th>
                    <th>{t('alarm.col.name')}</th>
                    <th>{t('alarm.col.robot')}</th>
                    <th>{t('alarm.col.handledAt')}</th>
                    <th>{t('alarm.col.status')}</th>
                    <th>{t('alarm.col.level')}</th>
                    <th>{t('alarm.col.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {list.data?.items.length === 0 && (
                    <tr>
                      <td colSpan={8} className="tbl-empty">
                        {t('alarm.empty')}
                      </td>
                    </tr>
                  )}
                  {list.data?.items.map((a, i) => (
                    <tr key={a.id} data-alarm={a.code}>
                      <td>{(page - 1) * SIZE + i + 1}</td>
                      <td className="mono">{formatTime(a.occurredAt)}</td>
                      <td title={a.message}>
                        {a.name}
                        {a.repeatCount > 1 && <small className="muted"> ×{a.repeatCount}</small>}
                        <div className="sub">{a.message}</div>
                      </td>
                      <td className="mono">{a.robotCode ?? floorName(a.floorId)}</td>
                      <td className="mono">{a.handledAt ? formatTime(a.handledAt) : t('alarm.notHandled')}</td>
                      <td>
                        <StatusTag status={a.status} />
                      </td>
                      <td>
                        <LevelTag level={a.level} />
                      </td>
                      <td>
                        <button type="button" className="obtn" onClick={() => open(a.id)}>
                          {ACTIONS[a.status].length ? t('alarm.act.process') : t('alarm.act.view')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {list.data && list.data.total > 0 && (
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
        <form
          className="scroll filt-in"
          onSubmit={(e) => {
            e.preventDefault();
            search();
          }}
        >
          <div className="fl">
            {t('alarm.filter.range')}
            <div className="trange">
              <input type="date" aria-label={`${t('alarm.filter.range')}（起）`} value={draft.from} max={draft.to || undefined} onChange={set('from')} />
              <span>~</span>
              <input type="date" aria-label={`${t('alarm.filter.range')}（迄）`} value={draft.to} min={draft.from || undefined} onChange={set('to')} />
            </div>
          </div>
          <label className="fl">
            {t('alarm.filter.floor')}
            <select value={draft.floor} onChange={set('floor')}>
              <option value="">{t('alarm.filter.allFloors')}</option>
              {floors.data?.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>
          <label className="fl">
            {t('alarm.filter.robot')}
            <select value={draft.robot} onChange={set('robot')}>
              <option value="">{t('alarm.filter.allRobots')}</option>
              {robots.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.code}
                </option>
              ))}
            </select>
          </label>
          <label className="fl">
            {t('alarm.col.name')}
            <select value={draft.type} onChange={set('type')}>
              <option value="">{t('alarm.filter.all')}</option>
              {types.map((x) => (
                <option key={x.type} value={x.type}>
                  {x.name}
                </option>
              ))}
            </select>
          </label>
          <label className="fl">
            {t('alarm.filter.status')}
            <select value={draft.status} onChange={set('status')}>
              <option value="">{t('alarm.filter.all')}</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`alarm.status.${s}` as MessageKey)}
                </option>
              ))}
            </select>
          </label>
          <label className="fl">
            {t('alarm.filter.level')}
            <select value={draft.level} onChange={set('level')}>
              <option value="">{t('alarm.filter.all')}</option>
              {[1, 2, 3].map((l) => (
                <option key={l} value={l}>
                  {t(`alarm.level.${l}` as MessageKey)}
                </option>
              ))}
            </select>
          </label>
          <label className="fl">
            {t('alarm.filter.keyword')}
            <input value={draft.q} maxLength={64} placeholder={t('alarm.filter.keywordPh')} onChange={set('q')} />
          </label>
          <button type="submit" className="go2">
            {t('alarm.filter.search')}
          </button>
        </form>
      </aside>

      {openId && <AlarmDialog id={openId} onClose={() => open(null)} />}
    </div>
  );
}
