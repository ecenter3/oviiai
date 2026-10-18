import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useRef, useState } from 'react';
import { api, ApiError } from '../../api/client';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { formatTime, t } from '../../i18n';
import { useAuth } from '../../stores/auth';
import { useToast } from '../../stores/toast';

type Kind = 'audio' | 'image' | 'text';
export interface Asset {
  id: string;
  kind: Kind;
  name: string;
  note: string | null;
  mime: string | null;
  sizeBytes: number | null;
  durationMs: number | null;
  text: string | null;
  createdByName: string | null;
  createdAt: string;
  url: string | null;
}
interface RobotRow {
  id: string;
  code: string;
  caps: string[];
  live?: { online?: boolean } | null;
}
interface PushResult {
  robotId: string;
  code: string;
  ok: boolean;
  reason?: string;
}

const KINDS: Kind[] = ['audio', 'image', 'text'];
const ACCEPT: Record<'audio' | 'image', string> = { audio: 'audio/mpeg,audio/wav,audio/x-wav,audio/ogg,audio/webm,audio/mp4,audio/aac', image: 'image/png,image/jpeg,image/gif,image/webp' };
const mmss = (ms: number | null) => (ms == null ? '' : `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}`);
const size = (b: number | null) => (b == null ? '' : b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
/** 推送需要的能力：音訊、詞條要能播放（talk／talk_live），警示圖要有螢幕 */
const canTake = (k: Kind, caps: string[]) => (k === 'image' ? caps.includes('screen') : caps.includes('talk') || caps.includes('talk_live'));

/** 讀音檔長度（瀏覽器解得出來才有） */
function audioDuration(file: File): Promise<number | undefined> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const a = new Audio();
    const done = (v?: number) => {
      URL.revokeObjectURL(url);
      resolve(v);
    };
    a.preload = 'metadata';
    a.onloadedmetadata = () => done(Number.isFinite(a.duration) ? Math.round(a.duration * 1000) : undefined);
    a.onerror = () => done(undefined);
    setTimeout(() => done(undefined), 3000);
    a.src = url;
  });
}

/**
 * 音視頻管理（/media，原型「音視頻管理」）：喊話音檔、警示圖、詞條（文字轉語音）。
 * 右側勾選機器人後按「推送」：音訊、詞條在機器人播放，警示圖顯示在機器人螢幕（要有螢幕能力）。
 */
export function AssetsPage() {
  const qc = useQueryClient();
  const canPush = useAuth((s) => s.can('op.remote'));
  const [kind, setKind] = useState<Kind>('audio');
  const [open, setOpen] = useState<string | null>(null);
  const [sel, setSel] = useState<string[]>([]);
  const [seconds, setSeconds] = useState(30);
  const [textForm, setTextForm] = useState<{ name: string; text: string } | null>(null);
  const [deleting, setDeleting] = useState<Asset | null>(null);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const list = useQuery({ queryKey: ['assets', kind], queryFn: () => api<Asset[]>(`/assets?kind=${kind}`) });
  const robots = useQuery({ queryKey: ['robots', 'list'], queryFn: () => api<RobotRow[]>('/robots'), enabled: canPush, retry: false });
  const toast = useToast.getState().show;
  const refresh = () => qc.invalidateQueries({ queryKey: ['assets'] });

  async function upload(f: File) {
    if (kind === 'text') return;
    setBusy(true);
    try {
      const body = new FormData();
      body.append('kind', kind);
      if (kind === 'audio') {
        const d = await audioDuration(f);
        if (d) body.append('durationMs', String(d));
      }
      body.append('file', f, f.name);
      const a = await api<Asset>('/assets', { method: 'POST', body });
      toast(t('assets.uploaded', { name: a.name }), 'ok');
      await refresh();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function saveText(e: FormEvent) {
    e.preventDefault();
    if (!textForm?.name.trim() || !textForm.text.trim()) return toast(t('assets.text.required'), 'error');
    try {
      await api('/assets/text', { method: 'POST', json: { name: textForm.name.trim(), text: textForm.text.trim() } });
      setTextForm(null);
      toast(t('assets.text.added'), 'ok');
      await refresh();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : String(err), 'error');
    }
  }

  async function push(a: Asset) {
    if (!sel.length) return toast(t('assets.pickRobots'), 'warn');
    try {
      const r = await api<PushResult[]>(`/assets/${a.id}/push`, { method: 'POST', json: { robotIds: sel, ...(a.kind === 'image' && { seconds }) } });
      const ok = r.filter((x) => x.ok);
      const bad = r.filter((x) => !x.ok);
      if (ok.length) toast(t('assets.pushed', { name: a.name, n: ok.length }), 'ok');
      if (bad.length) toast(t('assets.pushSkipped', { list: bad.map((x) => `${x.code}（${x.reason}）`).join('、') }), 'warn');
    } catch (e) {
      toast(e instanceof ApiError ? e.message : String(e), 'error');
    }
  }

  async function remove(a: Asset) {
    try {
      await api(`/assets/${a.id}`, { method: 'DELETE' });
      toast(t('assets.deleted', { name: a.name }), 'ok');
      await refresh();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : String(e), 'error');
    }
  }

  const items = list.data ?? [];
  const eligible = (robots.data ?? []).filter((r) => canTake(kind, r.caps));
  return (
    <div className="pg2">
      <section className="panel">
        <div className="pane-head">
          <span className="title">{t(`assets.title.${kind}`)}</span>
          <span className="meta">{t('assets.meta', { n: items.length })}</span>
        </div>
        <div className="scroll">
          <div className="pane-body">
            <div className="tbl-wrap">
              <table className="dtbl">
                <thead>
                  <tr>
                    <th aria-label={t('assets.expand')} />
                    <th>{t('assets.col.name')}</th>
                    <th>{kind === 'text' ? t('assets.col.text') : t('assets.col.info')}</th>
                    <th>{t('assets.col.by')}</th>
                    <th>{t('assets.col.at')}</th>
                    <th>{t('alarm.col.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {list.data && items.length === 0 && (
                    <tr>
                      <td colSpan={6} className="tbl-empty">
                        {t(`assets.empty.${kind}`)}
                      </td>
                    </tr>
                  )}
                  {items.map((a) => [
                    <tr key={a.id}>
                      <td>
                        <button type="button" className="lnk" aria-expanded={open === a.id} aria-label={t('assets.expand')} onClick={() => setOpen(open === a.id ? null : a.id)}>
                          {open === a.id ? '▾' : '▸'}
                        </button>
                      </td>
                      <td>{a.name}</td>
                      <td className={a.kind === 'text' ? '' : 'mono'}>
                        {a.kind === 'text' ? a.text : [a.mime?.split('/')[1], mmss(a.durationMs), size(a.sizeBytes)].filter(Boolean).join(' · ')}
                      </td>
                      <td>{a.createdByName ?? '—'}</td>
                      <td className="mono">{formatTime(a.createdAt).slice(0, 16)}</td>
                      <td>
                        <div className="acts">
                          {canPush && (
                            <button type="button" className="obtn" onClick={() => void push(a)}>
                              {t('assets.push')}
                            </button>
                          )}
                          <button type="button" className="obtn red" onClick={() => setDeleting(a)}>
                            {t('assets.delete')}
                          </button>
                        </div>
                      </td>
                    </tr>,
                    open === a.id && (
                      <tr key={`${a.id}-x`} className="asset-x">
                        <td colSpan={6}>
                          {a.kind === 'audio' && a.url && <audio controls src={a.url} aria-label={t('assets.preview', { name: a.name })} />}
                          {a.kind === 'image' && a.url && <img src={a.url} alt={t('assets.preview', { name: a.name })} />}
                          {a.kind === 'text' && <p>{a.text}</p>}
                        </td>
                      </tr>
                    ),
                  ])}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </section>
      <aside className="panel filt">
        <div className="scroll">
          <div className="filt-in">
            <div className="radios" role="radiogroup" aria-label={t('assets.kind')}>
              {KINDS.map((k) => (
                <label key={k}>
                  <input
                    type="radio"
                    name="mdt"
                    checked={kind === k}
                    onChange={() => {
                      setKind(k);
                      setOpen(null);
                      setTextForm(null);
                    }}
                  />
                  {t(`assets.kind.${k}`)}
                </label>
              ))}
            </div>
            {canPush && (
              <div className="fl">
                {t('assets.robots')}
                <div className="robot-picks">
                  {robots.data && eligible.length === 0 && <span className="fhint">{t(kind === 'image' ? 'assets.noScreen' : 'assets.noSpeaker')}</span>}
                  {eligible.map((r) => (
                    <label key={r.id} className="check">
                      <input type="checkbox" checked={sel.includes(r.id)} onChange={(e) => setSel(e.target.checked ? [...sel, r.id] : sel.filter((x) => x !== r.id))} />
                      <span className="mono">{r.code}</span>
                      {!r.live?.online && <span className="badge2 unreg">{t('robotmgr.status.offline')}</span>}
                    </label>
                  ))}
                </div>
                <span className="fhint">{t('assets.robotsHint')}</span>
              </div>
            )}
            {canPush && kind === 'image' && (
              <label className="fl">
                {t('assets.seconds')}
                <select value={seconds} onChange={(e) => setSeconds(Number(e.target.value))}>
                  {[10, 30, 60, 300, 600].map((s) => (
                    <option key={s} value={s}>
                      {t('assets.secondsN', { n: s })}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {kind === 'text' ? (
              textForm ? (
                <form className="text-form" onSubmit={(e) => void saveText(e)}>
                  <label className="fl">
                    {t('assets.col.name')}
                    <input value={textForm.name} maxLength={40} required onChange={(e) => setTextForm({ ...textForm, name: e.target.value })} />
                  </label>
                  <label className="fl">
                    {t('assets.col.text')}
                    <textarea value={textForm.text} maxLength={200} rows={4} required onChange={(e) => setTextForm({ ...textForm, text: e.target.value })} />
                  </label>
                  <button type="submit" className="go2 warn">
                    {t('assets.text.add')}
                  </button>
                  <button type="button" className="go2" onClick={() => setTextForm(null)}>
                    {t('common.cancel')}
                  </button>
                </form>
              ) : (
                <button type="button" className="go2 warn" onClick={() => setTextForm({ name: '', text: '' })}>
                  {t('assets.text.new')}
                </button>
              )
            ) : (
              <>
                <input
                  ref={file}
                  type="file"
                  hidden
                  accept={ACCEPT[kind]}
                  aria-label={t('assets.file')}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = '';
                    if (f) void upload(f);
                  }}
                />
                <button type="button" className="go2 warn" disabled={busy} onClick={() => file.current?.click()}>
                  {busy ? t('assets.uploading') : t('assets.upload')}
                </button>
              </>
            )}
            <p className="hint">{t(`assets.hint.${kind}`)}</p>
          </div>
        </div>
      </aside>
      {deleting && (
        <ConfirmDialog
          title={t('assets.delete')}
          body={t('assets.deleteConfirm', { name: deleting.name })}
          confirmText={t('assets.delete')}
          danger
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const a = deleting;
            setDeleting(null);
            void remove(a);
          }}
        />
      )}
    </div>
  );
}
