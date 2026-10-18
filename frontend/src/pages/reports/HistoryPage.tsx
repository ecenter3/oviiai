import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../../api/client';
import { formatTime, t } from '../../i18n';
import { useToast } from '../../stores/toast';
import { dayRange, taipeiDate, tr } from './time';

interface Options {
  robots: { id: string; code: string; floorId: string }[];
  cameras: { id: string; code: string; name: string; floorId: string }[];
}
interface Media {
  id: string;
  kind: 'clip' | 'snapshot';
  source: string;
  createdAt: string;
  durationS: number | null;
  url: string;
  alarmId: string | null;
}
interface AlarmMark {
  id: string;
  code: string;
  type: string;
  category: string;
  level: number;
  message: string;
  status: string;
  at: string;
}
export interface HistoryResp {
  clips: Media[];
  snapshots: Media[];
  alarms: AlarmMark[];
}

type Sel = { kind: 'robot' | 'camera'; id: string };
/** 時間軸上的事件：錄影開始、抓拍、告警（上一個、下一個事件用） */
type Ev = { t: number; kind: 'clip' | 'snapshot' | 'alarm'; ref: Media | AlarmMark };

const pad2 = (n: number) => String(n).padStart(2, '0');
const hms = (ms: number) => {
  const d = new Date(ms + 8 * 3600_000);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
};

/**
 * 歷史視頻（/history，原型「歷史視頻」）：選機器人或攝影機、日期與時段，時間軸列出已有的錄影片段與抓拍，
 * 標出告警時間點；點時間軸或片段播放、上一個／下一個事件、下載。本平台不做全天候錄影，只顯示有的片段。
 */
export function HistoryPage() {
  const opts = useQuery({ queryKey: ['media', 'options'], queryFn: () => api<Options>('/media/options') });
  const [sel, setSel] = useState<Sel | null>(null);
  const [date, setDate] = useState(taipeiDate());
  const [from, setFrom] = useState('00:00');
  const [to, setTo] = useState('23:59');
  const [cursor, setCursor] = useState<number | null>(null);
  const [playing, setPlaying] = useState<{ clip: Media; offset: number } | null>(null);
  const [still, setStill] = useState<Media | null>(null);
  const video = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (!sel && opts.data) {
      const r = opts.data.robots[0] ?? null;
      const c = opts.data.cameras[0] ?? null;
      if (r) setSel({ kind: 'robot', id: r.id });
      else if (c) setSel({ kind: 'camera', id: c.id });
    }
  }, [opts.data, sel]);

  const range = dayRange(date, from, to);
  const r0 = Date.parse(range.from);
  const r1 = Date.parse(range.to);
  const data = useQuery({
    queryKey: ['history', sel?.kind, sel?.id, range.from, range.to],
    queryFn: () => api<HistoryResp>(`/media/history?${sel!.kind}=${sel!.id}&from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`),
    enabled: !!sel,
  });
  const d = data.data;
  const events = useMemo<Ev[]>(
    () =>
      d
        ? [
            ...d.clips.map((c) => ({ t: Math.max(r0, Date.parse(c.createdAt)), kind: 'clip' as const, ref: c })),
            ...d.snapshots.map((s) => ({ t: Date.parse(s.createdAt), kind: 'snapshot' as const, ref: s })),
            ...d.alarms.map((a) => ({ t: Date.parse(a.at), kind: 'alarm' as const, ref: a })),
          ].sort((a, b) => a.t - b.t)
        : [],
    [d, r0],
  );

  // 換來源、日期：停止播放
  useEffect(() => {
    setPlaying(null);
    setStill(null);
    setCursor(null);
  }, [sel?.id, date]);

  const clipAt = (ms: number) => d?.clips.find((c) => ms >= Date.parse(c.createdAt) && ms <= Date.parse(c.createdAt) + (c.durationS ?? 0) * 1000);

  /** 跳到某個時間：在錄影片段內就從那裡播放；附近（±1%）有抓拍就顯示抓拍 */
  function seek(ms: number) {
    setCursor(ms);
    const c = clipAt(ms);
    if (c) {
      setStill(null);
      setPlaying({ clip: c, offset: (ms - Date.parse(c.createdAt)) / 1000 });
      return;
    }
    const near = d?.snapshots.find((s) => Math.abs(Date.parse(s.createdAt) - ms) <= (r1 - r0) * 0.01);
    setPlaying(null);
    setStill(near ?? null);
  }
  function jump(dir: 1 | -1) {
    const now = cursor ?? (dir > 0 ? r0 - 1 : r1 + 1);
    const ev = dir > 0 ? events.find((e) => e.t > now + 500) : [...events].reverse().find((e) => e.t < now - 500);
    if (!ev) return useToast.getState().show(t(dir > 0 ? 'history.noNext' : 'history.noPrev'), 'warn');
    if (ev.kind === 'snapshot') {
      setCursor(ev.t);
      setPlaying(null);
      setStill(ev.ref as Media);
    } else seek(ev.t);
  }

  useEffect(() => {
    const v = video.current;
    if (!v || !playing) return;
    const go = () => {
      v.currentTime = playing.offset;
      void v.play().catch(() => undefined);
    };
    if (v.readyState >= 1) go();
    else v.addEventListener('loadedmetadata', go, { once: true });
  }, [playing]);

  /** 播完接著放下一段 */
  function onEnded() {
    const cur = playing?.clip;
    const next = cur && d?.clips.find((c) => Date.parse(c.createdAt) > Date.parse(cur.createdAt));
    if (next) seek(Date.parse(next.createdAt));
    else useToast.getState().show(t('history.lastClip'), 'ok');
  }

  async function downloadMedia(m: Media) {
    try {
      const { url } = await api<{ url: string }>(`/media/${m.id}/url?download=1`);
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

  const P = (ms: number) => `${(((Math.min(r1, Math.max(r0, ms)) - r0) / (r1 - r0)) * 100).toFixed(3)}%`;
  const hours = Math.max(1, Math.round((r1 - r0) / 3600_000));
  const step = hours <= 2 ? 0.25 : hours <= 6 ? 1 : 2;
  const ticks: number[] = [];
  for (let h = Math.ceil(((r0 + 8 * 3600_000) % 86400_000) / 3600_000 / step) * step; ; h += step) {
    const ms = r0 - ((r0 + 8 * 3600_000) % 86400_000) + h * 3600_000;
    if (ms > r1) break;
    ticks.push(ms);
  }
  const shown = playing?.clip ?? still;
  const curTime = cursor ?? r0;
  const sources = [...(opts.data?.robots ?? []).map((r) => ({ v: `robot:${r.id}`, l: r.code })), ...(opts.data?.cameras ?? []).map((c) => ({ v: `camera:${c.id}`, l: `${c.code} ${c.name}` }))];

  return (
    <div className="pg2">
      <section className="panel">
        <div className="hv">
          <div className="hv-screen">
            {playing ? (
              <video ref={video} key={playing.clip.id} src={playing.clip.url} controls muted playsInline onEnded={onEnded} aria-label={t('history.player')} />
            ) : still ? (
              <img src={still.url} alt={t('history.snapshotAt', { t: formatTime(still.createdAt) })} />
            ) : (
              <div className="nosig">{d && !d.clips.length && !d.snapshots.length ? t('history.noMedia') : t('history.pick')}</div>
            )}
            {shown && <div className="hv-badge">{shown.kind === 'clip' ? t('history.clip') : t('history.snapshot')} · {formatTime(shown.createdAt)}</div>}
          </div>
          <div className="hv-ctl">
            <span className="hv-time" aria-label={t('history.cursor')}>
              {hms(curTime)}
            </span>
            <button type="button" className="cbtn" onClick={() => jump(-1)} aria-label={t('history.prev')}>
              ⏮
            </button>
            <button type="button" className="cbtn" onClick={() => jump(1)} aria-label={t('history.next')}>
              ⏭
            </button>
            <button type="button" className="cbtn" disabled={!shown} onClick={() => shown && void downloadMedia(shown)} aria-label={t('history.download')}>
              ⤓
            </button>
            <div className="hv-legend">
              <span>
                <i className="lg-clip" />
                {t('history.legend.clip')}
              </span>
              <span>
                <i className="lg-snap" />
                {t('history.legend.snapshot')}
              </span>
              <span>
                <i className="lg-alarm" />
                {t('history.legend.alarm')}
              </span>
            </div>
          </div>
          <div
            className="tline"
            role="slider"
            tabIndex={0}
            aria-label={t('history.timeline')}
            aria-valuemin={r0}
            aria-valuemax={r1}
            aria-valuenow={curTime}
            aria-valuetext={hms(curTime)}
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              seek(r0 + ((e.clientX - rect.left) / rect.width) * (r1 - r0));
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight') jump(1);
              if (e.key === 'ArrowLeft') jump(-1);
            }}
          >
            <div className="rail" />
            {d?.clips.map((c) => (
              <div
                key={c.id}
                className={`seg${playing?.clip.id === c.id ? ' on' : ''}`}
                style={{ left: P(Date.parse(c.createdAt)), width: `calc(${P(Date.parse(c.createdAt) + (c.durationS ?? 1) * 1000)} - ${P(Date.parse(c.createdAt))})` }}
                title={`${t('history.clip')} ${formatTime(c.createdAt)}（${c.durationS ?? 0} ${t('history.sec')}）`}
              />
            ))}
            {d?.snapshots.map((s) => <i key={s.id} className="ev snap" style={{ left: P(Date.parse(s.createdAt)) }} title={`${t('history.snapshot')} ${formatTime(s.createdAt)}`} />)}
            {d?.alarms.map((a) => (
              <i key={a.id} className={`ev alarm lv${a.level}`} style={{ left: P(Date.parse(a.at)) }} title={`${t('history.alarm')} ${formatTime(a.at)} ${a.message}`} />
            ))}
            {cursor != null && <div className="head" style={{ left: P(cursor) }} />}
            <div className="hrs">
              {ticks.map((ms) => (
                <span key={ms} style={{ left: P(ms) }}>
                  {hms(ms).slice(0, 5)}
                </span>
              ))}
            </div>
          </div>
          <div className="hv-list">
            {events.length === 0 && d && <p className="hint">{t('history.empty')}</p>}
            {events.map((e) => (
              <button
                key={`${e.kind}-${e.ref.id}`}
                type="button"
                className={`hv-ev ${e.kind}${(playing?.clip.id ?? still?.id) === e.ref.id ? ' on' : ''}`}
                onClick={() => (e.kind === 'snapshot' ? (setCursor(e.t), setPlaying(null), setStill(e.ref as Media)) : seek(e.t))}
              >
                <span className="mono">{hms(e.t)}</span>
                {e.kind === 'alarm' ? (
                  <span>
                    {t('history.alarm')} · {(e.ref as AlarmMark).message}（{tr(`alarm.status.${(e.ref as AlarmMark).status}`, (e.ref as AlarmMark).status)}）
                  </span>
                ) : e.kind === 'clip' ? (
                  <span>
                    {t('history.clip')} · {(e.ref as Media).durationS ?? 0} {t('history.sec')}
                    {(e.ref as Media).alarmId ? ` · ${t('history.evidence')}` : ''}
                  </span>
                ) : (
                  <span>{t('history.snapshot')}</span>
                )}
              </button>
            ))}
          </div>
        </div>
      </section>
      <aside className="panel filt">
        <div className="scroll">
          <div className="filt-in">
            <label className="fl">
              {t('history.source')}
              <select
                value={sel ? `${sel.kind}:${sel.id}` : ''}
                onChange={(e) => {
                  const [kind, id] = e.target.value.split(':') as ['robot' | 'camera', string];
                  setSel({ kind, id });
                }}
              >
                <optgroup label={t('history.robots')}>
                  {sources
                    .filter((s) => s.v.startsWith('robot:'))
                    .map((s) => (
                      <option key={s.v} value={s.v}>
                        {s.l}
                      </option>
                    ))}
                </optgroup>
                <optgroup label={t('history.cameras')}>
                  {sources
                    .filter((s) => s.v.startsWith('camera:'))
                    .map((s) => (
                      <option key={s.v} value={s.v}>
                        {s.l}
                      </option>
                    ))}
                </optgroup>
              </select>
            </label>
            <label className="fl">
              {t('energy.date')}
              <input type="date" value={date} max={taipeiDate()} onChange={(e) => e.target.value && setDate(e.target.value)} />
            </label>
            <div className="fl">
              {t('history.range')}
              <div className="trange">
                <input type="time" aria-label={t('energy.time.from')} value={from} onChange={(e) => setFrom(e.target.value || '00:00')} />
                <span>~</span>
                <input type="time" aria-label={t('energy.time.to')} value={to} onChange={(e) => setTo(e.target.value || '23:59')} />
              </div>
            </div>
            {d && <p className="hint">{t('history.count', { c: d.clips.length, s: d.snapshots.length, a: d.alarms.length })}</p>}
            <button type="button" className="go2 warn" disabled={!shown} onClick={() => shown && void downloadMedia(shown)}>
              {t('history.downloadSel')}
            </button>
            <p className="hint">{t('history.hint')}</p>
          </div>
        </div>
      </aside>
    </div>
  );
}
