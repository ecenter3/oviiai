import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, ApiError } from '../../api/client';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { formatTime, t, type MessageKey } from '../../i18n';
import { type MediaItem, useMedia } from '../../stores/media';
import { useAuth } from '../../stores/auth';
import { useToast } from '../../stores/toast';

interface Options {
  robots: { id: string; code: string; floorId: string }[];
  cameras: { id: string; code: string; name: string; floorId: string }[];
}
interface Filter {
  from: string;
  to: string;
  /** robot:{id} 或 camera:{id} */
  who: string;
  source: string;
}

const SIZE = 60;
const taipeiDay = (d: Date) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(d);
const addDays = (day: string, n: number) => taipeiDay(new Date(Date.parse(`${day}T12:00:00+08:00`) + n * 86_400_000));
const initial = (): Filter => {
  const today = taipeiDay(new Date());
  return { from: addDays(today, -6), to: today, who: '', source: '' };
};

/** 查詢字串（日期以台北時間整天計） */
export function mediaQuery(kind: 'snapshot' | 'clip', f: Filter, page: number, size = SIZE): string {
  const p = new URLSearchParams({ kind, page: String(page), size: String(size) });
  if (f.from) p.set('from', `${f.from}T00:00:00+08:00`);
  if (f.to) p.set('to', `${addDays(f.to, 1)}T00:00:00+08:00`);
  const [k, id] = f.who.split(':');
  if (k === 'robot') p.set('robot', id);
  if (k === 'camera') p.set('camera', id);
  if (f.source) p.set('source', f.source);
  return p.toString();
}

const whoOf = (m: MediaItem) => m.robotCode ?? (m.cameraCode ? `${m.cameraCode} ${m.cameraName ?? ''}`.trim() : '—');
const duration = (s: number | null) => (s === null ? '—' : `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`);
const SOURCE_TONE: Record<MediaItem['source'], string> = { manual: 'blue', patrol: '', alarm: 'black' };

function useMediaList(kind: 'snapshot' | 'clip', filter: Filter, page: number, size?: number) {
  const qs = mediaQuery(kind, filter, page, size);
  const list = useQuery({ queryKey: ['media', kind, qs], queryFn: () => api<{ items: MediaItem[]; total: number }>(`/media?${qs}`), placeholderData: keepPreviousData });
  // 新的抓拍、錄影（WebSocket media.new）→ 重新查詢
  const version = useMedia((s) => s.version);
  const { refetch } = list;
  useEffect(() => {
    if (version) void refetch();
  }, [version, refetch]);
  return list;
}

/** 下載：取 5 分鐘有效、以附件下載的預簽名網址 */
async function download(id: string) {
  try {
    const { url } = await api<{ url: string }>(`/media/${id}/url?download=1`);
    const a = document.createElement('a');
    a.href = url;
    a.rel = 'noopener';
    document.body.append(a);
    a.click();
    a.remove();
  } catch (e) {
    useToast.getState().show(e instanceof ApiError ? e.message : String(e), 'error');
  }
}

/** 右側篩選欄（原型：日期、機器人、方式、搜索） */
function FilterAside({ draft, setDraft, onSearch, sourceLabel, kind }: { draft: Filter; setDraft(f: Filter): void; onSearch(): void; sourceLabel: MessageKey; kind: 'snapshot' | 'clip' }) {
  const options = useQuery({ queryKey: ['media', 'options'], queryFn: () => api<Options>('/media/options') });
  const set = (k: keyof Filter) => (e: { target: { value: string } }) => setDraft({ ...draft, [k]: e.target.value });
  return (
    <aside className="panel filt">
      <form
        className="scroll filt-in"
        onSubmit={(e) => {
          e.preventDefault();
          onSearch();
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
          {t('media.filter.who')}
          <select value={draft.who} onChange={set('who')}>
            <option value="">{t('media.filter.allWho')}</option>
            <optgroup label={t('media.filter.robots')}>
              {options.data?.robots.map((r) => (
                <option key={r.id} value={`robot:${r.id}`}>
                  {r.code}
                </option>
              ))}
            </optgroup>
            <optgroup label={t('media.filter.cameras')}>
              {options.data?.cameras.map((c) => (
                <option key={c.id} value={`camera:${c.id}`}>
                  {c.code} {c.name}
                </option>
              ))}
            </optgroup>
          </select>
        </label>
        <label className="fl">
          {t(sourceLabel)}
          <select value={draft.source} onChange={set('source')}>
            <option value="">{t('alarm.filter.all')}</option>
            {(['manual', 'patrol', 'alarm'] as const).map((s) => (
              <option key={s} value={s}>
                {t(`media.source.${kind}.${s}` as MessageKey)}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="go2">
          {t('alarm.filter.search')}
        </button>
      </form>
    </aside>
  );
}

/**
 * 抓拍圖片（/captures，原型「抓拍圖片」：縮圖牆、全選、刪除；右側日期、機器人、抓拍方式；T-28）。
 * 點縮圖看大圖、下載。最新抓拍經 WebSocket media.new 即時出現（3 秒內）。
 */
export function CapturesPage() {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Filter>(initial);
  const [filter, setFilter] = useState<Filter>(draft);
  const list = useMediaList('snapshot', filter, 1);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [view, setView] = useState<MediaItem | null>(null);
  const [confirm, setConfirm] = useState(false);
  const canDelete = useAuth((st) => st.can('op.media'));
  const items = list.data?.items ?? [];
  // 告警證據不能手動刪（後端回 409），不讓它被選取
  const deletable = items.filter((i) => !i.alarmId);
  const toggle = (id: string) => setSel((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set(s).add(id)));

  async function remove() {
    try {
      const r = await api<{ deleted: number }>('/media/delete', { method: 'POST', json: { ids: [...sel] } });
      useToast.getState().show(t('media.deleted', { n: r.deleted }), 'ok');
      setSel(new Set());
      await qc.invalidateQueries({ queryKey: ['media', 'snapshot'] });
    } catch (e) {
      useToast.getState().show(e instanceof ApiError ? e.message : String(e), 'error');
    }
  }

  return (
    <div className="pg2">
      <section className="panel">
        <div className="pane-head">
          <span className="title">{t('page.captures')}</span>
          <span className="meta">{t('media.captures.meta', { n: list.data?.total ?? 0 })}</span>
          {canDelete && (
            <>
              <button type="button" className="obtn" disabled={!deletable.length} onClick={() => setSel(sel.size && sel.size === deletable.length ? new Set() : new Set(deletable.map((i) => i.id)))}>
                {sel.size && sel.size === deletable.length ? t('media.unselectAll') : t('media.selectAll')}
              </button>
              <button type="button" className="obtn red" disabled={!sel.size} onClick={() => setConfirm(true)}>
                {t('media.delete', { n: sel.size })}
              </button>
            </>
          )}
        </div>
        <div className="scroll">
          {items.length === 0 ? (
            <p className="empty-state">{t('media.captures.empty')}</p>
          ) : (
            <div className="gallery">
              {items.map((m) => (
                <div key={m.id} className={`fcard pcard${sel.has(m.id) ? ' sel' : ''}`} data-media={m.id}>
                  <button type="button" className="thumb" aria-label={t('media.view', { who: whoOf(m) })} onClick={() => setView(m)}>
                    <img src={m.url} alt={`${whoOf(m)} ${formatTime(m.createdAt)}`} loading="lazy" />
                  </button>
                  {canDelete &&
                    (m.alarmId ? (
                      <span className="tick lock" title={t('media.evidence')} aria-label={t('media.evidence')}>
                        🔒
                      </span>
                    ) : (
                      <button type="button" className="tick" aria-label={t('media.select')} aria-pressed={sel.has(m.id)} onClick={() => toggle(m.id)}>
                        {sel.has(m.id) ? '✓' : ''}
                      </button>
                    ))}
                  <div className="cap">
                    <b>{whoOf(m)}</b>
                    <span className={`badge2 ${SOURCE_TONE[m.source]}`}>{t(`media.source.snapshot.${m.source}` as MessageKey)}</span>
                  </div>
                  <div className="sub2">{formatTime(m.createdAt)}</div>
                </div>
              ))}
              {(list.data?.total ?? 0) > SIZE && <p className="hint wide">{t('media.captures.more', { n: SIZE })}</p>}
            </div>
          )}
        </div>
      </section>
      <FilterAside draft={draft} setDraft={setDraft} onSearch={() => setFilter(draft)} sourceLabel="media.filter.snapMode" kind="snapshot" />

      {view && (
        <div className="lightbox" role="dialog" aria-modal="true" aria-label={whoOf(view)} onClick={() => setView(null)} onKeyDown={(e) => e.key === 'Escape' && setView(null)}>
          <figure onClick={(e) => e.stopPropagation()}>
            <img src={view.url} alt={whoOf(view)} />
            <figcaption>
              {whoOf(view)} · {formatTime(view.createdAt)} · {t(`media.source.snapshot.${view.source}` as MessageKey)}
              {view.createdByName ? ` · ${view.createdByName}` : ''}
            </figcaption>
            <div className="row">
              <button type="button" className="btn" onClick={() => void download(view.id)}>
                {t('media.download')}
              </button>
              <button type="button" className="btn" onClick={() => setView(null)}>
                {t('common.close')}
              </button>
            </div>
          </figure>
        </div>
      )}
      {confirm && (
        <ConfirmDialog
          title={t('media.delete', { n: sel.size })}
          body={t('media.deleteConfirm', { n: sel.size })}
          confirmText={t('maps.delete')}
          danger
          onCancel={() => setConfirm(false)}
          onConfirm={() => {
            setConfirm(false);
            void remove();
          }}
        />
      )}
    </div>
  );
}

/** 錄像回放（/records，原型「錄像回放」：序號、機器人、鏡頭、開始、結束、時長、觸發方式、播放；T-28） */
export function RecordsPage() {
  const [draft, setDraft] = useState<Filter>(initial);
  const [filter, setFilter] = useState<Filter>(draft);
  const [page, setPage] = useState(1);
  const list = useMediaList('clip', filter, page, 20);
  const [play, setPlay] = useState<MediaItem | null>(null);
  const items = list.data?.items ?? [];
  const pages = Math.max(1, Math.ceil((list.data?.total ?? 0) / 20));

  return (
    <div className="pg2">
      <section className="panel">
        <div className="pane-head">
          <span className="title">{t('page.records')}</span>
          <span className="meta">{t('media.records.meta', { n: list.data?.total ?? 0 })}</span>
        </div>
        <div className="scroll">
          <div className="pane-body">
            <div className="tbl-wrap">
              <table className="dtbl">
                <thead>
                  <tr>
                    <th>{t('alarm.col.no')}</th>
                    <th>{t('media.col.who')}</th>
                    <th>{t('media.col.start')}</th>
                    <th>{t('media.col.end')}</th>
                    <th>{t('media.col.duration')}</th>
                    <th>{t('media.col.size')}</th>
                    <th>{t('media.filter.recMode')}</th>
                    <th>{t('alarm.col.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {items.length === 0 && (
                    <tr>
                      <td colSpan={8} className="tbl-empty">
                        {t('media.records.empty')}
                      </td>
                    </tr>
                  )}
                  {items.map((m, i) => (
                    <tr key={m.id} data-media={m.id}>
                      <td>{(page - 1) * 20 + i + 1}</td>
                      <td>{whoOf(m)}</td>
                      <td className="mono">{formatTime(m.createdAt)}</td>
                      <td className="mono">{m.endedAt ? formatTime(m.endedAt).slice(-8) : '—'}</td>
                      <td className="mono">{duration(m.durationS)}</td>
                      <td className="mono">{m.sizeBytes ? `${(m.sizeBytes / 1048576).toFixed(1)} MB` : '—'}</td>
                      <td>
                        <span className={`badge2 ${SOURCE_TONE[m.source]}`}>{t(`media.source.clip.${m.source}` as MessageKey)}</span>
                      </td>
                      <td>
                        <div className="acts">
                          <button type="button" className="obtn" onClick={() => setPlay(m)}>
                            {t('media.play')}
                          </button>
                          <button type="button" className="obtn" onClick={() => void download(m.id)}>
                            {t('media.download')}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {(list.data?.total ?? 0) > 20 && (
              <div className="pager">
                <span>{t('alarm.pager', { total: list.data!.total })}</span>
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
      <FilterAside
        draft={draft}
        setDraft={setDraft}
        onSearch={() => {
          setFilter(draft);
          setPage(1);
        }}
        sourceLabel="media.filter.recMode"
        kind="clip"
      />

      {play && (
        <div className="modal-bg" onKeyDown={(e) => e.key === 'Escape' && setPlay(null)}>
          <div className="modal wide-modal" role="dialog" aria-modal="true" aria-label={t('media.playTitle', { who: whoOf(play) })}>
            <h2>{t('media.playTitle', { who: whoOf(play) })}</h2>
            <video className="clip-player" src={play.url} controls autoPlay playsInline />
            <p className="hint">
              {formatTime(play.createdAt)} · {duration(play.durationS)}
              {play.createdByName ? ` · ${play.createdByName}` : ''}
            </p>
            <div className="row">
              <button type="button" className="btn" onClick={() => void download(play.id)}>
                {t('media.download')}
              </button>
              <button type="button" className="btn" onClick={() => setPlay(null)}>
                {t('common.close')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
