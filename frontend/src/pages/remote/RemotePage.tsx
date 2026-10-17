import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../../api/client';
import { FloorMap } from '../../components/FloorMap/FloorMap';
import { MediaControls } from '../../components/media/MediaControls';
import { VideoPlayer } from '../../components/media/VideoPlayer';
import { t, type MessageKey } from '../../i18n';
import { useAuth } from '../../stores/auth';
import { type MediaItem, useMedia } from '../../stores/media';
import { useRealtime } from '../../stores/realtime';
import { useToast } from '../../stores/toast';
import type { RobotRow } from '../robots/RobotsPage';
import { Joystick } from './Joystick';
import { useTeleop } from './useTeleop';

interface Floor {
  id: string;
  name: string;
  planUrl: string | null;
  widthM: number | null;
  heightM: number | null;
}
interface Charger {
  id: string;
  code: string;
  x: number;
  y: number;
}

/** 雲台位置：正規化 -1..1 的絕對位置（轉接器換算成各機型角度）；zoom 0..1 */
interface Ptz {
  pan: number;
  tilt: number;
  zoom: number;
}
const PTZ_STEP = { slow: 0.05, normal: 0.1, fast: 0.2 } as const;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(v * 100) / 100));
const pct = (v: number) => `${Math.round(v * 100)}%`;

const CMD_LABEL: Record<string, MessageKey> = {
  stop: 'robot.act.stop',
  charge: 'remote.act.charge',
  ptz: 'remote.btn.ptz',
  light: 'remote.act.light',
  follow: 'remote.act.follow',
  follow_stop: 'remote.act.follow.stop',
  lift: 'remote.lift',
};

/**
 * 實時遙控（/remote/:id，系統規格書 §4.3、原型「遙控操作」；T-30）。
 * 影像（前鏡頭 WebRTC）＋抓拍錄影、小地圖、搖桿（取遙控鎖，放開即停、斷線 0.5 秒停車）、雲台、燈光、跟隨、去充電。
 * 功能依機器人能力清單（caps）顯示，不做品牌判斷。
 */
export function RemotePage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const can = useAuth((s) => s.can);
  const robots = useQuery({ queryKey: ['robots', 'list'], queryFn: () => api<RobotRow[]>('/robots'), refetchInterval: 10_000 });
  const floors = useQuery({ queryKey: ['floors'], queryFn: () => api<Floor[]>('/floors') });
  const list = robots.data ?? [];
  const row = list.find((r) => r.id === id) ?? (id ? undefined : list[0]);
  const rid = row?.id ?? null;
  const floor = floors.data?.find((f) => f.id === row?.floorId);
  const chargers = useQuery({
    queryKey: ['chargers', row?.floorId],
    queryFn: () => api<Charger[]>(`/chargers?floor=${row?.floorId}`),
    enabled: !!row?.floorId,
    retry: false,
  });

  // 即時狀態只訂閱這台的樓層
  const setWatch = useRealtime((s) => s.setWatch);
  useEffect(() => {
    if (!row?.floorId) return;
    setWatch([row.floorId]);
    return () => setWatch([]);
  }, [row?.floorId, setWatch]);
  const live = useRealtime((s) => (row ? Object.values(s.robots).find((r) => r.code === row.code) : undefined)) ?? row?.live ?? null;
  const online = !!live?.online;
  const estop = live?.state === 'estop';

  const tele = useTeleop(rid, () => row && useToast.getState().show(t('remote.idle.released', { code: row.code }), 'warn'));
  const held = tele.lock.s === 'held';
  const [panel, setPanel] = useState<'joy' | 'ptz' | null>(null);
  const [ptz, setPtz] = useState<Ptz>({ pan: 0, tilt: 0, zoom: 0 });
  const [ptzSpeed, setPtzSpeed] = useState<keyof typeof PTZ_STEP>('normal');
  const [lights, setLights] = useState<Record<string, boolean>>({});
  const [person, setPerson] = useState('');
  const [following, setFollowing] = useState<string | null>(null);
  const [lift, setLift] = useState(0);

  // 換到另一台：面板、雲台、燈光等畫面狀態重來（第一次載入清單不算）
  const prevRid = useRef(rid);
  useEffect(() => {
    if (prevRid.current && prevRid.current !== rid) {
      setPanel(null);
      setPtz({ pan: 0, tilt: 0, zoom: 0 });
      setLights({});
      setFollowing(null);
    }
    prevRid.current = rid;
  }, [rid]);

  // 只對這個畫面送出的指令提示失敗（雲台一按一筆，成功不提示）
  const mine = useRef(new Set<string>());
  const results = useRealtime((s) => s.cmdResults);
  const shown = useRef(new Set<string>());
  useEffect(() => {
    for (const r of results) {
      if (!mine.current.has(r.cmdId) || shown.current.has(r.cmdId)) continue;
      if (r.status === 'rejected' || r.status === 'failed') {
        shown.current.add(r.cmdId);
        const type = CMD_LABEL[r.type] ? t(CMD_LABEL[r.type]) : r.type;
        useToast.getState().show(t(r.status === 'rejected' ? 'robot.cmd.rejected' : 'robot.cmd.failed', { code: r.code, type, reason: r.error?.msg ?? r.error?.code ?? '' }), 'error');
      }
    }
  }, [results]);

  async function command(type: string, args: Record<string, unknown> = {}): Promise<boolean> {
    if (!rid) return false;
    try {
      const r = await api<{ cmdId: string }>(`/robots/${rid}/commands`, { method: 'POST', json: { type, args } });
      mine.current.add(r.cmdId);
      return true;
    } catch (e) {
      useToast.getState().show(e instanceof ApiError ? e.message : String(e), 'error');
      return false;
    }
  }

  const caps = new Set(row?.caps ?? []);
  const sendPtz = (next: Ptz) => {
    setPtz(next);
    void command('ptz', { ...next });
  };
  const nudge = (dp: number, dt: number) => {
    const s = PTZ_STEP[ptzSpeed];
    sendPtz({ ...ptz, pan: clamp(ptz.pan + dp * s, -1, 1), tilt: clamp(ptz.tilt + dt * s, -1, 1) });
  };
  // 開關先切換，送不出去再切回來
  const setLight = async (mode: string, on: boolean) => {
    setLights((l) => ({ ...l, [mode]: on }));
    if (!(await command('light', { on, mode }))) setLights((l) => ({ ...l, [mode]: !on }));
  };

  async function snapshot() {
    if (!row) return;
    try {
      await api('/media/snapshot', { method: 'POST', json: { streamKey: `robot/${row.code}/front` } });
      useToast.getState().show(t('remote.act.shot.ok'), 'ok');
    } catch (e) {
      useToast.getState().show(e instanceof ApiError ? e.message : String(e), 'error');
    }
  }

  async function stopNow() {
    tele.setVector(0, 0);
    if (await command('stop')) useToast.getState().show(t('remote.stop.sent'));
  }

  async function closePanel() {
    if (panel === 'joy' && held) await tele.release();
    setPanel(null);
  }

  if (!robots.isLoading && !list.length) return <p className="empty-state">{t('remote.noRobot')}</p>;

  const stateLabel = online ? t(`state.${live!.state}` as MessageKey) : t('remote.offline');
  const name = row ? t('remote.video', { code: row.code }) : '';
  const streamKey = row ? `robot/${row.code}/front` : '';

  return (
    <div className="remote">
      <div className="rbar">
        <label className="rsel">
          <span>{t('remote.robot')}</span>
          <select value={rid ?? ''} onChange={(e) => navigate(`/remote/${e.target.value}`)}>
            {list.map((r) => (
              <option key={r.id} value={r.id}>
                {r.code}
                {r.live?.online ? '' : `（${t('remote.offline')}）`}
              </option>
            ))}
          </select>
        </label>
        <div className="rstat">
          <span>
            {t('remote.speed')}
            <b>{online && live?.speed != null ? `${live.speed.toFixed(1)} m/s` : '—'}</b>
          </span>
          <span>
            {t('remote.state')}
            <b className={!online || estop ? 'warn' : ''}>{stateLabel}</b>
          </span>
          <span>
            {t('remote.battery')}
            <b>{online ? `${Math.round(live!.battery)}%` : '—'}</b>
          </span>
          <span>
            {t('remote.floor')}
            <b>{floor?.name ?? '—'}</b>
          </span>
          <span>
            {t('remote.task')}
            <b>{row?.task?.code ?? '—'}</b>
          </span>
          {row?.teleop && (
            <span>
              {t('remote.holder')}
              <b>{row.teleop.username}</b>
            </span>
          )}
        </div>
      </div>

      <div className="rgrid2">
        <section className="panel video-wrap">
          {row && (
            <VideoPlayer key={row.code} streamKey={streamKey} label={name}>
              <MediaControls streamKey={streamKey} name={name} />
            </VideoPlayer>
          )}
          {can('captures') && row && <RecentShots robotId={row.id} />}
        </section>

        <aside className="panel rside">
          <div className="scroll">
            <div className="rside-in">
              <div className="rmini">
                <div className="rmini-stage">
                  {floor && live && (
                    <FloorMap
                      viewKey={floor.id}
                      widthM={floor.widthM}
                      heightM={floor.heightM}
                      planUrl={floor.planUrl}
                      robots={[{ id: row!.id, code: row!.code, x: live.x, y: live.y, yaw: live.yaw, state: live.state, online, battery: live.battery }]}
                      chargers={chargers.data ?? []}
                      selectedRobotId={row!.id}
                    />
                  )}
                </div>
                <div className="rmini-btns">
                  <button type="button" className={`rbtn${panel === 'joy' ? ' on' : ''}`} aria-pressed={panel === 'joy'} onClick={() => (panel === 'joy' ? void closePanel() : setPanel('joy'))}>
                    <i>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                        <circle cx="12" cy="12" r="8" />
                        <circle cx="12" cy="12" r="2.5" />
                        <path d="M12 4v5.5M4.5 14l5.3-1.2M19.5 14l-5.3-1.2" />
                      </svg>
                    </i>
                    {t('remote.btn.joy')}
                  </button>
                  <button type="button" className={`rbtn${panel === 'ptz' ? ' on' : ''}`} aria-pressed={panel === 'ptz'} disabled={!caps.has('ptz')} title={caps.has('ptz') ? undefined : t('remote.ptz.none')} onClick={() => setPanel(panel === 'ptz' ? null : 'ptz')}>
                    <i>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                        <circle cx="12" cy="12" r="7" />
                        <circle cx="12" cy="12" r="2.5" />
                        <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
                      </svg>
                    </i>
                    {t('remote.btn.ptz')}
                  </button>
                </div>
              </div>

              {!tele.connected && <div className="rwarn">{t('remote.disconnected')}</div>}
              {held && tele.idleLeft !== null && (
                <div className="rwarn idle" role="alert">
                  {t('remote.idle.warn', { n: tele.idleLeft })}
                  <button type="button" className="mini" onClick={tele.keepAlive}>
                    {t('remote.idle.keep')}
                  </button>
                </div>
              )}

              {panel === 'joy' && (
                <div className="ctl" aria-label={t('remote.btn.joy')}>
                  <div className="ctl-head">
                    <button type="button" className="stopbtn" disabled={!online} onClick={() => void stopNow()}>
                      {t('remote.stop')}
                    </button>
                    {held && (
                      <button type="button" className="pillbtn" onClick={() => void tele.release()}>
                        {t('remote.lock.release')}
                      </button>
                    )}
                    <button type="button" className="xbtn" aria-label={t('remote.close')} onClick={() => void closePanel()}>
                      ×
                    </button>
                  </div>
                  <LockInfo lock={tele.lock} online={online} estop={estop} onAcquire={(force) => void tele.acquire(force)} />
                  <Joystick enabled={held && online && !estop && tele.connected} onChange={tele.setVector} />
                  <p className="ctl-hint">{held ? t('remote.lock.held') : t('remote.joy.hint')}</p>
                  {caps.has('lift') && (
                    <div className="lift">
                      <b>{t('remote.lift')}</b>
                      <div className="lift-row">
                        <input type="number" min={0} max={500} step={10} value={lift} aria-label={t('remote.lift.height')} onChange={(e) => setLift(Number(e.target.value))} />
                        <span>mm</span>
                        <button type="button" className="mini yes" disabled={!held} onClick={() => void command('lift', { height: lift })}>
                          {t('remote.lift.go')}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {panel === 'ptz' && (
                <div className="ctl" aria-label={t('remote.btn.ptz')}>
                  <div className="ctl-head">
                    <button type="button" className="pillbtn" disabled={!online} onClick={() => sendPtz({ pan: 0, tilt: 0, zoom: ptz.zoom })}>
                      {t('remote.ptz.center')}
                    </button>
                    <button type="button" className="xbtn" aria-label={t('remote.close')} onClick={() => setPanel(null)}>
                      ×
                    </button>
                  </div>
                  <div className="dpad">
                    <span />
                    <button type="button" aria-label={t('remote.ptz.up')} disabled={!online} onClick={() => nudge(0, 1)}>
                      ↑
                    </button>
                    <span />
                    <button type="button" aria-label={t('remote.ptz.left')} disabled={!online} onClick={() => nudge(-1, 0)}>
                      ←
                    </button>
                    <button type="button" aria-label={t('remote.ptz.center')} disabled={!online} onClick={() => sendPtz({ pan: 0, tilt: 0, zoom: ptz.zoom })}>
                      ⟳
                    </button>
                    <button type="button" aria-label={t('remote.ptz.right')} disabled={!online} onClick={() => nudge(1, 0)}>
                      →
                    </button>
                    <span />
                    <button type="button" aria-label={t('remote.ptz.down')} disabled={!online} onClick={() => nudge(0, -1)}>
                      ↓
                    </button>
                    <span />
                  </div>
                  <p className="ctl-hint">{t('remote.ptz.hint')}</p>
                  <div className="ptzkv">
                    <span>
                      {t('remote.ptz.pan')} <b>{pct(ptz.pan)}</b>
                    </span>
                    <span>
                      {t('remote.ptz.tilt')} <b>{pct(ptz.tilt)}</b>
                    </span>
                    <span>
                      {t('remote.ptz.zoom')} <b>{pct(ptz.zoom)}</b>
                    </span>
                  </div>
                  <div className="trow">
                    <span>{t('remote.ptz.zoom')}</span>
                    <div className="seg">
                      <button type="button" aria-label={t('remote.ptz.zoomOut')} disabled={!online} onClick={() => sendPtz({ ...ptz, zoom: clamp(ptz.zoom - 0.25, 0, 1) })}>
                        －
                      </button>
                      <button type="button" aria-label={t('remote.ptz.zoomIn')} disabled={!online} onClick={() => sendPtz({ ...ptz, zoom: clamp(ptz.zoom + 0.25, 0, 1) })}>
                        ＋
                      </button>
                    </div>
                  </div>
                  <div className="trow">
                    <span>{t('remote.ptz.speed')}</span>
                    <div className="seg" role="radiogroup" aria-label={t('remote.ptz.speed')}>
                      {(Object.keys(PTZ_STEP) as (keyof typeof PTZ_STEP)[]).map((k) => (
                        <button key={k} type="button" role="radio" aria-checked={ptzSpeed === k} className={ptzSpeed === k ? 'on' : ''} onClick={() => setPtzSpeed(k)}>
                          {t(`remote.ptz.${k}`)}
                        </button>
                      ))}
                    </div>
                  </div>
                  {caps.has('light') && (
                    <label className="trow">
                      <span>{t('remote.fill')}</span>
                      <span className="switch">
                        <input type="checkbox" checked={!!lights.fill} disabled={!online} aria-label={t('remote.fill')} onChange={(e) => void setLight('fill', e.target.checked)} />
                        <i />
                      </span>
                    </label>
                  )}
                </div>
              )}

              <div className="acts-list">
                <div className="arow">
                  <span className="ai">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></svg>
                  </span>
                  <span className="al">{t('remote.act.shot')}</span>
                  <button type="button" className="abtn" disabled={!row} onClick={() => void snapshot()}>
                    {t('remote.act.shot')}
                  </button>
                </div>
                <div className="arow">
                  <span className="ai">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="3" y="7" width="16" height="10" rx="2" /><path d="M22 11v2M11.5 8.5l-2 4h4l-2 3" /></svg>
                  </span>
                  <span className="al">{t('remote.act.charge')}</span>
                  <button
                    type="button"
                    className="abtn"
                    disabled={!online || estop}
                    onClick={() => void command('charge').then((ok) => ok && useToast.getState().show(t('remote.act.charge.ok', { code: row!.code })))}
                  >
                    {t('remote.act.charge.go')}
                  </button>
                </div>
                {caps.has('light') && (
                  <label className="arow">
                    <span className="ai">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M6 19h12M8 19v-6a4 4 0 0 1 8 0v6M12 3v2M4.5 6.5l1.4 1.4M19.5 6.5l-1.4 1.4" /></svg>
                  </span>
                    <span className="al">{t('remote.act.light')}</span>
                    <span className="switch">
                      <input type="checkbox" checked={!!lights.alert} disabled={!online} onChange={(e) => void setLight('alert', e.target.checked)} aria-label={t('remote.act.light')} />
                      <i />
                    </span>
                  </label>
                )}
                {caps.has('follow') && (
                  <div className="arow">
                    <span className="ai">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="12" cy="5" r="2" /><path d="M10 22l1.5-7L9 12l1-4h4l2 4h3M14 22l-1.5-6" /></svg>
                  </span>
                    <span className="al">
                      {t('remote.act.follow')}
                      <small>{following ?? t('remote.act.follow.hint')}</small>
                      {!following && (
                        <span className="follow-row">
                          <input value={person} maxLength={64} placeholder="P-0001" aria-label={t('remote.act.follow.person')} onChange={(e) => setPerson(e.target.value)} />
                        </span>
                      )}
                    </span>
                    {following ? (
                      <button type="button" className="abtn active" disabled={!online} onClick={() => void command('follow_stop').then((ok) => ok && setFollowing(null))}>
                        {t('remote.act.follow.stop')}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="abtn"
                        disabled={!online || estop || !person.trim()}
                        onClick={() =>
                          void command('follow', { personId: person.trim() }).then((ok) => {
                            if (!ok) return;
                            setFollowing(person.trim());
                            useToast.getState().show(t('remote.act.follow.ok', { code: row!.code, person: person.trim() }));
                          })
                        }
                      >
                        {t('remote.act.follow.start')}
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function LockInfo(props: { lock: ReturnType<typeof useTeleop>['lock']; online: boolean; estop: boolean; onAcquire(force: boolean): void }) {
  const { lock } = props;
  if (!props.online) return <p className="lockinfo">{t('remote.offline')}</p>;
  if (props.estop) return <p className="lockinfo">{t('remote.estop')}</p>;
  if (lock.s === 'held') return null;
  if (lock.s === 'acquiring') return <p className="lockinfo">{t('remote.lock.taking')}</p>;
  if (lock.s === 'locked')
    return (
      <div className="lockinfo">
        <b>{t('remote.lock.by', { name: lock.holder })}</b>
        {lock.canForce && (
          <div className="row2">
            <button type="button" className="mini danger" onClick={() => props.onAcquire(true)}>
              {t('remote.lock.force')}
            </button>
          </div>
        )}
      </div>
    );
  return (
    <div className="lockinfo">
      {lock.s === 'error' ? <b>{lock.message}</b> : t('remote.lock.none')}
      <div className="row2">
        <button type="button" className="btn primary" onClick={() => props.onAcquire(false)}>
          {lock.s === 'error' ? t('remote.lock.retry') : t('remote.lock.take')}
        </button>
      </div>
    </div>
  );
}

/** 這台最近 8 張抓拍（原型「最近截圖」）；新抓拍經 media.new 即時出現 */
function RecentShots({ robotId }: { robotId: string }) {
  const version = useMedia((s) => s.version);
  const q = useQuery({
    queryKey: ['media', 'snapshot', 'recent', robotId, version],
    queryFn: () => api<{ items: MediaItem[] }>(`/media?kind=snapshot&robot=${robotId}&page=1&size=8`),
    retry: false,
  });
  const items = q.data?.items ?? [];
  return (
    <div className="shots">
      <span>{t('remote.shots')}</span>
      <div className="shot-list">
        {items.length ? (
          items.map((m) => (
            <a key={m.id} className="shot" href={m.url} target="_blank" rel="noreferrer" title={new Date(m.createdAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}>
              <img src={m.url} alt={m.robotCode ?? ''} />
              <span>{new Date(m.createdAt).toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false })}</span>
            </a>
          ))
        ) : (
          <span className="empty-inline">{t('remote.shots.empty')}</span>
        )}
      </div>
      <Link className="obtn" to="/captures">
        {t('remote.shots.all')}
      </Link>
    </div>
  );
}
