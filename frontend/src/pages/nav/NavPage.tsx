import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../../api/client';
import { FloorMap, type FloorMapHandle, type MapMark } from '../../components/FloorMap/FloorMap';
import { PermGate } from '../../components/PermGate';
import { t, type MessageKey } from '../../i18n';
import { useAuth } from '../../stores/auth';
import { useRealtime } from '../../stores/realtime';
import { useToast } from '../../stores/toast';

interface Floor {
  id: string;
  name: string;
  planUrl: string | null;
  widthM: number | null;
  heightM: number | null;
}
type Pt = { x: number; y: number };
export interface Poi {
  id: string;
  floorId: string;
  name: string;
  x: number;
  y: number;
  yaw: number | null;
  kind: 'poi' | 'parking';
}
export interface Zone {
  id: string;
  floorId: string;
  name: string;
  kind: ZoneKind;
  polygon: [number, number][];
}
export interface NavPath {
  id: string;
  floorId: string;
  name: string;
  points: (Pt & { dwellSec?: number })[];
  lengthM: number;
  schedules: number;
}
export interface Schedule {
  id: string;
  name: string;
  pathId: string;
  pathName: string;
  floorId: string;
  robotId: string | null;
  robotCode: string | null;
  startTime: string;
  repeat: Repeat;
  onceDate: string | null;
  loops: number;
  priority: 'P1' | 'P2' | 'P3' | 'P4';
  enabled: boolean;
  lastRunAt: string | null;
  lastTask: { id: string; code: string; status: string } | null;
  nextRunAt: string | null;
}
interface Charger {
  id: string;
  code: string;
  x: number;
  y: number;
  occupiedBy: { code: string } | null;
}

type ZoneKind = 'forbidden' | 'slow' | 'silent';
type Repeat = 'daily' | 'weekdays' | 'weekends' | 'once';
type Section = 'menu' | 'paths' | 'patrols' | 'pois' | 'parking' | 'zones';

/** 地圖上正在做的事：放點、畫路徑、畫區域 */
type Draft =
  | { kind: 'point'; poiKind: Poi['kind']; id: string | null; name: string; pt: Pt | null }
  | { kind: 'path'; id: string | null; name: string; points: Pt[] }
  | { kind: 'zone'; id: string | null; name: string; zoneKind: ZoneKind; points: Pt[] };

interface ScheduleForm {
  id: string | null;
  name: string;
  pathId: string;
  robotId: string;
  startTime: string;
  repeat: Repeat;
  onceDate: string;
  loops: string;
  priority: Schedule['priority'];
}

const REPEATS: Repeat[] = ['daily', 'weekdays', 'weekends', 'once'];
const ZONE_KINDS: ZoneKind[] = ['forbidden', 'slow', 'silent'];
/** 原型的導航設定選單：後五項待原廠介面確認，以「規劃中」顯示（前端頁面 §3） */
const MENU: [Section | string, MessageKey, boolean][] = [
  ['paths', 'nav.menu.paths', false],
  ['patrols', 'nav.menu.patrols', false],
  ['pois', 'nav.menu.pois', false],
  ['parking', 'nav.menu.parking', false],
  ['zones', 'nav.menu.zones', false],
  ['teleport', 'nav.menu.teleport', true],
  ['special', 'nav.menu.special', true],
  ['group', 'nav.menu.group', true],
  ['rail', 'nav.menu.rail', true],
  ['tour', 'nav.menu.tour', true],
];

const round2 = (v: number) => Math.round(v * 100) / 100;
export const pathLength = (pts: Pt[]) => Math.round(pts.slice(1).reduce((s, p, i) => s + Math.hypot(p.x - pts[i].x, p.y - pts[i].y), 0) * 10) / 10;
/** 多邊形面積（平方公尺，鞋帶公式） */
export const polygonArea = (pts: Pt[]) =>
  Math.round((Math.abs(pts.reduce((s, p, i) => s + p.x * pts[(i + 1) % pts.length].y - pts[(i + 1) % pts.length].x * p.y, 0)) / 2) * 10) / 10;
const taipeiDay = (d: Date) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(d);
const shortTime = (iso: string) =>
  new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));

/**
 * 導航管理（/nav，原型「導航管理」：左平面圖、右側導航設定；T-24）。
 * 在平面圖上建立興趣點、待命點（充電讓位時開往）、特殊區域、路徑（點興趣點會吸附），以及巡邏排程。
 * 原型中待原廠介面確認的項目（傳送點、特殊點、任務分組、虛擬軌道、講解任務）以「規劃中」顯示。
 */
export function NavPage() {
  const qc = useQueryClient();
  const can = useAuth((s) => s.can);
  const floors = useQuery({ queryKey: ['floors'], queryFn: () => api<Floor[]>('/floors') });
  const [floorId, setFloorId] = useState<string | null>(null);
  const floor = floors.data?.find((f) => f.id === floorId) ?? floors.data?.[0];
  const fid = floor?.id;
  const byFloor = <T,>(path: string) => ({ queryKey: ['nav', path, fid], queryFn: () => api<T>(`/${path}?floor=${fid}`), enabled: !!fid });
  const pois = useQuery(byFloor<Poi[]>('pois'));
  const zones = useQuery(byFloor<Zone[]>('zones'));
  const paths = useQuery(byFloor<NavPath[]>('paths'));
  const schedules = useQuery(byFloor<Schedule[]>('patrol-schedules'));
  const options = useQuery({
    queryKey: ['nav', 'options', fid],
    queryFn: () => api<{ robots: { id: string; code: string }[] }>(`/patrol-schedules/options?floor=${fid}`),
    enabled: !!fid,
  });
  const showLive = can('monitor') || can('robots') || can('maps');
  const chargers = useQuery({ queryKey: ['chargers', fid], queryFn: () => api<Charger[]>(`/chargers?floor=${fid}`), enabled: !!fid && showLive });

  // 即時位置（有看機器人狀態的權限才訂閱）
  const setWatch = useRealtime((s) => s.setWatch);
  const live = useRealtime((s) => s.robots);
  useEffect(() => {
    if (!fid || !(can('monitor') || can('robots') || can('remote'))) return;
    setWatch([fid]);
    return () => setWatch([]);
  }, [fid, setWatch, can]);
  const robots = useMemo(() => Object.values(live).filter((r) => r.floor === fid), [live, fid]);

  const [section, setSection] = useState<Section>('menu');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [selPath, setSelPath] = useState<string | null>(null);
  const [selPoi, setSelPoi] = useState<string | null>(null);
  const [zoneKind, setZoneKind] = useState<ZoneKind>('forbidden');
  const [form, setForm] = useState<ScheduleForm | null>(null);
  const [busy, setBusy] = useState(false);
  const mapRef = useRef<FloorMapHandle>(null);
  const toast = useToast.getState().show;

  useEffect(() => {
    setDraft(null);
    setForm(null);
    setSelPath(null);
    setSelPoi(null);
  }, [fid]);

  const refresh = (what: string) => qc.invalidateQueries({ queryKey: ['nav', what] });
  const fail = (e: unknown) => toast(e instanceof ApiError ? e.message : String(e), 'error');
  async function call(fn: () => Promise<unknown>, ok: string, ...what: string[]) {
    setBusy(true);
    try {
      await fn();
      toast(ok, 'ok');
      await Promise.all(what.map(refresh));
      return true;
    } catch (e) {
      fail(e);
      return false;
    } finally {
      setBusy(false);
    }
  }

  // ===== 地圖點選 =====
  function onPick(p: Pt) {
    if (!draft) return;
    if (draft.kind === 'point') setDraft({ ...draft, pt: p });
    else setDraft({ ...draft, points: [...draft.points, p] });
  }

  // ===== 儲存 =====
  async function savePoint() {
    if (!draft || draft.kind !== 'point' || !draft.pt || !fid) return;
    const body = { name: draft.name.trim(), x: draft.pt.x, y: draft.pt.y, kind: draft.poiKind };
    const ok = await call(
      () => (draft.id ? api(`/pois/${draft.id}`, { method: 'PATCH', json: body }) : api('/pois', { method: 'POST', json: { ...body, floorId: fid } })),
      t('nav.saved', { name: body.name }),
      'pois',
    );
    if (ok) setDraft(null);
  }
  async function savePath() {
    if (!draft || draft.kind !== 'path' || !fid) return;
    const body = { name: draft.name.trim(), points: draft.points };
    const ok = await call(
      () => (draft.id ? api(`/paths/${draft.id}`, { method: 'PATCH', json: body }) : api('/paths', { method: 'POST', json: { ...body, floorId: fid } })),
      t('nav.saved', { name: body.name }),
      'paths',
    );
    if (ok) setDraft(null);
  }
  async function saveZone() {
    if (!draft || draft.kind !== 'zone' || !fid) return;
    const body = { name: draft.name.trim(), kind: draft.zoneKind, polygon: draft.points.map((p) => [p.x, p.y]) };
    const ok = await call(
      () => (draft.id ? api(`/zones/${draft.id}`, { method: 'PATCH', json: body }) : api('/zones', { method: 'POST', json: { ...body, floorId: fid } })),
      t('nav.saved', { name: body.name }),
      'zones',
    );
    if (ok) setDraft(null);
  }
  async function saveSchedule() {
    if (!form) return;
    const body = {
      name: form.name.trim(),
      pathId: form.pathId,
      robotId: form.robotId || null,
      startTime: form.startTime,
      repeat: form.repeat,
      onceDate: form.repeat === 'once' ? form.onceDate : null,
      loops: Number(form.loops) || 1,
      priority: form.priority,
    };
    const ok = await call(
      () => (form.id ? api(`/patrol-schedules/${form.id}`, { method: 'PATCH', json: body }) : api('/patrol-schedules', { method: 'POST', json: body })),
      t('nav.saved', { name: body.name }),
      'patrol-schedules',
      'paths',
    );
    if (ok) setForm(null);
  }
  const remove = (path: string, id: string, name: string, what: string) =>
    call(() => api(`/${path}/${id}`, { method: 'DELETE' }), t('nav.deleted', { name }), what, 'paths');

  // ===== 地圖圖層 =====
  const fpaths = paths.data ?? [];
  const selected = fpaths.find((p) => p.id === selPath);
  const drawingPath = draft?.kind === 'path' ? draft : null;
  const drawingZone = draft?.kind === 'zone' ? draft : null;
  const numbered = drawingPath?.points ?? selected?.points ?? [];
  const marks: MapMark[] = numbered.map((p, i) => ({ id: `wp${i}`, x: p.x, y: p.y, label: String(i + 1), tone: drawingPath ? 'draft' : 'ok' }));
  if (draft?.kind === 'point' && draft.pt) marks.push({ id: 'pt', x: draft.pt.x, y: draft.pt.y, label: '+', tone: 'draft' });
  if (drawingZone) drawingZone.points.forEach((p, i) => marks.push({ id: `zp${i}`, x: p.x, y: p.y, label: String(i + 1), tone: 'draft' }));

  const mapPaths = [
    ...fpaths.filter((p) => p.id !== drawingPath?.id).map((p) => ({ id: p.id, points: p.points, tone: (selPath ? (p.id === selPath ? 'sel' : 'faint') : undefined) as 'sel' | 'faint' | undefined })),
    ...(drawingPath && drawingPath.points.length > 1 ? [{ id: 'draft', points: drawingPath.points, tone: 'draft' as const }] : []),
  ];
  const mapZones = [
    ...(zones.data ?? []).filter((z) => z.id !== drawingZone?.id).map((z) => ({ id: z.id, kind: z.kind, name: z.name, polygon: z.polygon.map(([x, y]) => ({ x, y })) })),
    ...(drawingZone && drawingZone.points.length > 1 ? [{ id: 'draft', kind: drawingZone.zoneKind, polygon: drawingZone.points, draft: true }] : []),
  ];
  const banner =
    draft?.kind === 'point'
      ? t(draft.poiKind === 'parking' ? 'nav.banner.parking' : 'nav.banner.poi')
      : draft?.kind === 'path'
        ? t('nav.banner.path', { n: draft.points.length, m: pathLength(draft.points) })
        : draft?.kind === 'zone'
          ? t('nav.banner.zone', { n: draft.points.length })
          : null;

  const pointList = (kind: Poi['kind']) => (pois.data ?? []).filter((p) => p.kind === kind);
  const startPoint = (kind: Poi['kind'], p?: Poi) => {
    setSelPath(null);
    setDraft({ kind: 'point', poiKind: kind, id: p?.id ?? null, name: p?.name ?? '', pt: p ? { x: p.x, y: p.y } : null });
  };

  return (
    <div className="navp">
      <section className="panel navmap">
        <div className="nav-tools">
          <div className="seg2" role="tablist">
            {floors.data?.map((f) => (
              <button key={f.id} type="button" role="tab" aria-selected={f.id === fid} className={f.id === fid ? 'on' : ''} onClick={() => setFloorId(f.id)}>
                {f.name}
              </button>
            ))}
          </div>
          <span className="push-left" />
          <button type="button" className="pbtn" aria-label={t('monitor.map.zoomIn')} onClick={() => mapRef.current?.zoomIn()}>
            ＋
          </button>
          <button type="button" className="pbtn" aria-label={t('monitor.map.zoomOut')} onClick={() => mapRef.current?.zoomOut()}>
            －
          </button>
          <button type="button" className="pbtn" onClick={() => mapRef.current?.fit()}>
            {t('monitor.map.fit')}
          </button>
        </div>
        <div className="stage">
          {floor && (
            <FloorMap
              ref={mapRef}
              widthM={floor.widthM}
              heightM={floor.heightM}
              planUrl={floor.planUrl}
              pois={(pois.data ?? []).filter((p) => !(draft?.kind === 'point' && draft.id === p.id)).map((p) => ({ ...p, selected: p.id === selPoi }))}
              zones={mapZones}
              paths={mapPaths}
              marks={marks}
              chargers={(chargers.data ?? []).map((c) => ({ id: c.id, code: c.code, x: c.x, y: c.y, occupiedBy: c.occupiedBy?.code ?? null }))}
              robots={robots.map((r) => ({ id: r.robotId, code: r.code, x: r.x, y: r.y, yaw: r.yaw, state: r.state, online: r.online, battery: r.battery }))}
              onPoiClick={(id) => setSelPoi((s) => (s === id ? null : id))}
              pickMode={!!draft}
              onPick={onPick}
              viewKey={fid}
            />
          )}
          {banner && (
            <div className="mode-banner" role="status">
              <span>{banner}</span>
              {draft && draft.kind !== 'point' && (
                <button type="button" className="mini" disabled={!draft.points.length} onClick={() => setDraft({ ...draft, points: draft.points.slice(0, -1) })}>
                  {t('nav.undo')}
                </button>
              )}
              <button type="button" className="mini" onClick={() => setDraft(null)}>
                {t('common.cancel')}
              </button>
            </div>
          )}
          {floor && <div className="map-name">{floor.name}</div>}
        </div>
      </section>

      <aside className="panel navside">
        <div className="panel-head">
          {section === 'menu' ? (
            <>
              {t('nav.title')} <span className="meta">{floor?.name}</span>
            </>
          ) : (
            <>
              {t(MENU.find((m) => m[0] === section)![1])}
              <button
                type="button"
                className="xbtn"
                aria-label={t('nav.back')}
                onClick={() => {
                  setSection('menu');
                  setDraft(null);
                  setForm(null);
                  setSelPath(null);
                }}
              >
                ×
              </button>
            </>
          )}
        </div>
        <div className="scroll">
          {section === 'menu' && (
            <div className="nmenu">
              {MENU.map(([k, label, tbd]) => (
                <button key={k} type="button" className="nm" disabled={tbd} onClick={() => !tbd && setSection(k as Section)}>
                  {t(label)}
                  {tbd && <small>{t('nav.tbd')}</small>}
                </button>
              ))}
            </div>
          )}

          {section === 'paths' && (
            <div className="nsec">
              <button type="button" className="bluebtn" onClick={() => (setSelPath(null), setDraft({ kind: 'path', id: null, name: '', points: [] }))}>
                {t('nav.path.new')}
              </button>
              {drawingPath && (
                <div className="box">
                  <b>{drawingPath.id ? t('nav.path.edit') : t('nav.path.new')}</b>
                  <label>
                    {t('nav.path.name')}
                    <input value={drawingPath.name} maxLength={32} onChange={(e) => setDraft({ ...drawingPath, name: e.target.value })} />
                  </label>
                  <span>{t('nav.path.stat', { n: drawingPath.points.length, m: pathLength(drawingPath.points) })}</span>
                  <div className="r">
                    <button type="button" className="mini" disabled={!drawingPath.points.length} onClick={() => setDraft({ ...drawingPath, points: drawingPath.points.slice(0, -1) })}>
                      {t('nav.undo')}
                    </button>
                    <button type="button" className="mini yes" disabled={busy || drawingPath.points.length < 2 || !drawingPath.name.trim()} onClick={() => void savePath()}>
                      {t('nav.finish')}
                    </button>
                    <button type="button" className="mini no" onClick={() => setDraft(null)}>
                      {t('common.cancel')}
                    </button>
                  </div>
                </div>
              )}
              {fpaths.length === 0 && <p className="empty">{t('nav.path.empty')}</p>}
              {fpaths.map((p) => (
                <div key={p.id} className={`litem${selPath === p.id ? ' sel' : ''}`} data-path={p.name} onClick={() => setSelPath((s) => (s === p.id ? null : p.id))}>
                  <div className="nm2">
                    <strong>{p.name}</strong>
                    <span>{t('nav.path.item', { n: p.points.length, m: p.lengthM, s: p.schedules })}</span>
                  </div>
                  <button
                    type="button"
                    className="ib"
                    aria-label={t('nav.edit')}
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelPath(null);
                      setDraft({ kind: 'path', id: p.id, name: p.name, points: p.points.map(({ x, y }) => ({ x, y })) });
                    }}
                  >
                    ✎
                  </button>
                  <DelButton label={p.name} onConfirm={() => void remove('paths', p.id, p.name, 'paths')} />
                </div>
              ))}
              <p className="hint">{t('nav.path.hint')}</p>
            </div>
          )}

          {section === 'patrols' && (
            <div className="nsec">
              <button
                type="button"
                className="bluebtn"
                disabled={!fpaths.length}
                onClick={() =>
                  setForm({ id: null, name: '', pathId: fpaths[0]?.id ?? '', robotId: '', startTime: '08:00', repeat: 'daily', onceDate: taipeiDay(new Date(Date.now() + 86_400_000)), loops: '1', priority: 'P3' })
                }
              >
                {t('nav.patrol.new')}
              </button>
              {!fpaths.length && <p className="empty">{t('nav.patrol.needPath')}</p>}
              {form && (
                <form
                  className="box"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void saveSchedule();
                  }}
                >
                  <b>{form.id ? t('nav.patrol.edit') : t('nav.patrol.new')}</b>
                  <label>
                    {t('nav.patrol.name')}
                    <input value={form.name} required maxLength={32} placeholder={t('nav.patrol.namePh')} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                  </label>
                  <label>
                    {t('nav.patrol.path')}
                    <select value={form.pathId} onChange={(e) => setForm({ ...form, pathId: e.target.value })}>
                      {fpaths.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}（{t('nav.path.item', { n: p.points.length, m: p.lengthM, s: p.schedules })}）
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    {t('nav.patrol.robot')}
                    <select value={form.robotId} onChange={(e) => setForm({ ...form, robotId: e.target.value })}>
                      <option value="">{t('nav.patrol.anyRobot')}</option>
                      {options.data?.robots.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.code}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="r2">
                    <label>
                      {t('nav.patrol.time')}
                      <input type="time" required value={form.startTime} onChange={(e) => setForm({ ...form, startTime: e.target.value })} />
                    </label>
                    <label>
                      {t('nav.patrol.repeat')}
                      <select value={form.repeat} onChange={(e) => setForm({ ...form, repeat: e.target.value as Repeat })}>
                        {REPEATS.map((r) => (
                          <option key={r} value={r}>
                            {t(`nav.repeat.${r}` as MessageKey)}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  {form.repeat === 'once' && (
                    <label>
                      {t('nav.patrol.date')}
                      <input type="date" required value={form.onceDate} onChange={(e) => setForm({ ...form, onceDate: e.target.value })} />
                    </label>
                  )}
                  <div className="r2">
                    <label>
                      {t('nav.patrol.loops')}
                      <input type="number" min={1} max={100} value={form.loops} onChange={(e) => setForm({ ...form, loops: e.target.value })} />
                    </label>
                    <label>
                      {t('nav.patrol.priority')}
                      <select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value as Schedule['priority'] })}>
                        {(['P1', 'P2', 'P3', 'P4'] as const).map((p) => (
                          <option key={p}>{p}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div className="r">
                    <button type="submit" className="mini yes" disabled={busy}>
                      {t('common.save')}
                    </button>
                    <button type="button" className="mini no" onClick={() => setForm(null)}>
                      {t('common.cancel')}
                    </button>
                  </div>
                </form>
              )}
              {(schedules.data ?? []).length === 0 && <p className="empty">{t('nav.patrol.empty')}</p>}
              {schedules.data?.map((s) => (
                <div key={s.id} className={`litem${selPath === s.pathId ? ' sel' : ''}`} data-schedule={s.name} onClick={() => setSelPath((x) => (x === s.pathId ? null : s.pathId))}>
                  <div className="nm2">
                    <strong>{s.name}</strong>
                    <span>
                      {s.pathName} · {s.robotCode ?? t('nav.patrol.anyRobot')} · {s.startTime} {s.repeat === 'once' ? s.onceDate : t(`nav.repeat.${s.repeat}` as MessageKey)}
                      {s.loops > 1 ? ` ×${s.loops}` : ''}
                    </span>
                    <span>
                      {s.nextRunAt ? t('nav.patrol.next', { at: shortTime(s.nextRunAt) }) : t('nav.patrol.noNext')}
                      {s.lastTask ? ` · ${t('nav.patrol.last', { code: s.lastTask.code })}` : ''}
                    </span>
                  </div>
                  <span className="switch sm" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      aria-label={t('nav.patrol.enable', { name: s.name })}
                      checked={s.enabled}
                      onChange={(e) =>
                        void call(
                          () => api(`/patrol-schedules/${s.id}`, { method: 'PATCH', json: { enabled: e.target.checked } }),
                          t(e.target.checked ? 'nav.patrol.enabled' : 'nav.patrol.disabled', { name: s.name }),
                          'patrol-schedules',
                        )
                      }
                    />
                    <i />
                  </span>
                  <PermGate perms={['op.dispatch']}>
                    <button
                      type="button"
                      className="ib"
                      aria-label={t('nav.patrol.run', { name: s.name })}
                      onClick={(e) => {
                        e.stopPropagation();
                        void call(() => api(`/patrol-schedules/${s.id}/run`, { method: 'POST' }), t('nav.patrol.ran', { name: s.name }), 'patrol-schedules');
                      }}
                    >
                      ▶
                    </button>
                  </PermGate>
                  <button
                    type="button"
                    className="ib"
                    aria-label={t('nav.edit')}
                    onClick={(e) => {
                      e.stopPropagation();
                      setForm({
                        id: s.id,
                        name: s.name,
                        pathId: s.pathId,
                        robotId: s.robotId ?? '',
                        startTime: s.startTime,
                        repeat: s.repeat,
                        onceDate: s.onceDate ?? taipeiDay(new Date(Date.now() + 86_400_000)),
                        loops: String(s.loops),
                        priority: s.priority,
                      });
                    }}
                  >
                    ✎
                  </button>
                  <DelButton label={s.name} onConfirm={() => void remove('patrol-schedules', s.id, s.name, 'patrol-schedules')} />
                </div>
              ))}
              <p className="hint">{t('nav.patrol.hint')}</p>
            </div>
          )}

          {(section === 'pois' || section === 'parking') && (
            <div className="nsec">
              {(() => {
                const kind: Poi['kind'] = section === 'pois' ? 'poi' : 'parking';
                const list = pointList(kind);
                const d = draft?.kind === 'point' && draft.poiKind === kind ? draft : null;
                return (
                  <>
                    <button type="button" className="bluebtn" onClick={() => startPoint(kind)}>
                      {t(kind === 'poi' ? 'nav.poi.new' : 'nav.parking.new')}
                    </button>
                    {d && (
                      <div className="box">
                        <b>{d.id ? t('nav.poi.edit', { name: d.name }) : t(kind === 'poi' ? 'nav.poi.new' : 'nav.parking.new')}</b>
                        <span>{d.pt ? t('nav.poi.at', { x: round2(d.pt.x), y: round2(d.pt.y) }) : t('nav.poi.pickFirst')}</span>
                        <label>
                          {t('nav.poi.name')}
                          <input
                            value={d.name}
                            maxLength={32}
                            placeholder={t(kind === 'poi' ? 'nav.poi.namePh' : 'nav.parking.namePh')}
                            onChange={(e) => setDraft({ ...d, name: e.target.value })}
                          />
                        </label>
                        <div className="r">
                          <button type="button" className="mini yes" disabled={busy || !d.pt || !d.name.trim()} onClick={() => void savePoint()}>
                            {t('common.save')}
                          </button>
                          <button type="button" className="mini no" onClick={() => setDraft(null)}>
                            {t('common.cancel')}
                          </button>
                        </div>
                      </div>
                    )}
                    {list.length === 0 && <p className="empty">{t(kind === 'poi' ? 'nav.poi.empty' : 'nav.parking.empty')}</p>}
                    {list.map((p) => (
                      <div key={p.id} className={`litem${selPoi === p.id ? ' sel' : ''}`} data-poi={p.name} onClick={() => setSelPoi((s) => (s === p.id ? null : p.id))}>
                        <div className="nm2">
                          <strong>{p.name}</strong>
                          <span>{t('nav.poi.at', { x: round2(p.x), y: round2(p.y) })}</span>
                        </div>
                        <button
                          type="button"
                          className="ib"
                          aria-label={t('nav.edit')}
                          onClick={(e) => {
                            e.stopPropagation();
                            startPoint(kind, p);
                          }}
                        >
                          ✎
                        </button>
                        <DelButton label={p.name} onConfirm={() => void remove('pois', p.id, p.name, 'pois')} />
                      </div>
                    ))}
                    <p className="hint">{t(kind === 'poi' ? 'nav.poi.hint' : 'nav.parking.hint')}</p>
                  </>
                );
              })()}
            </div>
          )}

          {section === 'zones' && (
            <div className="nsec">
              <div className="seg2 wide">
                {ZONE_KINDS.map((k) => (
                  <button key={k} type="button" className={zoneKind === k ? 'on' : ''} onClick={() => setZoneKind(k)}>
                    {t(`nav.zone.${k}` as MessageKey)}
                  </button>
                ))}
              </div>
              <button type="button" className="bluebtn" onClick={() => setDraft({ kind: 'zone', id: null, name: '', zoneKind, points: [] })}>
                {t('nav.zone.draw', { kind: t(`nav.zone.${zoneKind}` as MessageKey) })}
              </button>
              {drawingZone && (
                <div className="box">
                  <b>{drawingZone.id ? t('nav.zone.edit') : t('nav.zone.draw', { kind: t(`nav.zone.${drawingZone.zoneKind}` as MessageKey) })}</b>
                  <label>
                    {t('nav.zone.name')}
                    <input value={drawingZone.name} maxLength={32} onChange={(e) => setDraft({ ...drawingZone, name: e.target.value })} />
                  </label>
                  <span>{t('nav.zone.stat', { n: drawingZone.points.length, a: drawingZone.points.length >= 3 ? polygonArea(drawingZone.points) : 0 })}</span>
                  <div className="r">
                    <button type="button" className="mini" disabled={!drawingZone.points.length} onClick={() => setDraft({ ...drawingZone, points: drawingZone.points.slice(0, -1) })}>
                      {t('nav.undo')}
                    </button>
                    <button type="button" className="mini yes" disabled={busy || drawingZone.points.length < 3 || !drawingZone.name.trim()} onClick={() => void saveZone()}>
                      {t('nav.finish')}
                    </button>
                    <button type="button" className="mini no" onClick={() => setDraft(null)}>
                      {t('common.cancel')}
                    </button>
                  </div>
                </div>
              )}
              {(zones.data ?? []).length === 0 && <p className="empty">{t('nav.zone.empty')}</p>}
              {zones.data?.map((z) => (
                <div key={z.id} className={`litem zl-${z.kind}`} data-zone={z.name}>
                  <div className="nm2">
                    <strong>{z.name}</strong>
                    <span>
                      {t(`nav.zone.${z.kind}` as MessageKey)} · {polygonArea(z.polygon.map(([x, y]) => ({ x, y })))} m²
                    </span>
                  </div>
                  <button
                    type="button"
                    className="ib"
                    aria-label={t('nav.edit')}
                    onClick={() => setDraft({ kind: 'zone', id: z.id, name: z.name, zoneKind: z.kind, points: z.polygon.map(([x, y]) => ({ x, y })) })}
                  >
                    ✎
                  </button>
                  <DelButton label={z.name} onConfirm={() => void remove('zones', z.id, z.name, 'zones')} />
                </div>
              ))}
              <p className="hint">{t('nav.zone.hint')}</p>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

/** 刪除：按一次變成「確認刪除」，再按才刪（原型 delBtn） */
function DelButton({ label, onConfirm }: { label: string; onConfirm(): void }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const id = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(id);
  }, [armed]);
  return armed ? (
    <button
      type="button"
      className="ib confirm"
      onClick={(e) => {
        e.stopPropagation();
        setArmed(false);
        onConfirm();
      }}
    >
      {t('nav.confirmDelete')}
    </button>
  ) : (
    <button
      type="button"
      className="ib del"
      aria-label={t('nav.delete', { name: label })}
      onClick={(e) => {
        e.stopPropagation();
        setArmed(true);
      }}
    >
      🗑
    </button>
  );
}
