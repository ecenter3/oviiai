import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../../api/client';
import { FloorMap, type FloorMapHandle } from '../../components/FloorMap/FloorMap';
import { t, type MessageKey } from '../../i18n';
import { type CmdResult, useRealtime } from '../../stores/realtime';
import { useToast } from '../../stores/toast';
import { chargeStatusOf } from '../../stores/charging';
import { useChargingData } from '../useChargingData';
import { type DrawerCommand, RobotDrawer } from './RobotDrawer';
import { MediaControls } from '../../components/media/MediaControls';
import { VideoPlayer } from '../../components/media/VideoPlayer';
import { AlertLog } from './AlertLog';
import { TasksPanel } from './TasksPanel';

interface Floor {
  id: string;
  name: string;
  sort: number;
  planUrl: string | null;
  widthM: number | null;
  heightM: number | null;
}
interface Camera {
  id: string;
  code: string;
  name: string;
  streamKey: string;
  floorId: string;
  x: number;
  y: number;
}
interface Charger {
  id: string;
  code: string;
  floorId: string;
  x: number;
  y: number;
  occupiedBy: { robotId: string; code: string } | null;
}

const FLOOR_KEY = 'oviiai.monitor.floor';
const readFloor = () => {
  try {
    return localStorage.getItem(FLOOR_KEY);
  } catch {
    return null;
  }
};

const CMD_LABEL: Record<string, MessageKey> = {
  estop: 'robot.act.estop',
  estop_release: 'robot.act.estopRelease',
  stop: 'robot.act.stop',
  charge: 'robot.act.charge',
};
const cmdLabel = (type: string) => (CMD_LABEL[type] ? t(CMD_LABEL[type]) : type);

/**
 * 實時監控（系統規格書 §4.1、T-14）。版面依原型：派工任務｜平面圖｜攝影機，下方告警日誌。
 * 只訂閱目前樓層的即時狀態；統計卡在頂欄（stats.tick）。
 */
export function MonitorPage() {
  const floors = useQuery({ queryKey: ['floors'], queryFn: () => api<Floor[]>('/floors') });
  const [floorId, setFloorId] = useState<string | null>(readFloor);
  const floor = floors.data?.find((f) => f.id === floorId) ?? floors.data?.[0];
  const fid = floor?.id;

  const cameras = useQuery({ queryKey: ['cameras', fid], queryFn: () => api<Camera[]>(`/cameras?floor=${fid}`), enabled: !!fid });
  const chargers = useQuery({
    queryKey: ['chargers', fid],
    queryFn: () => api<Charger[]>(`/chargers?floor=${fid}`),
    enabled: !!fid,
    refetchInterval: 10_000,
  });

  const chargingFloors = useChargingData();
  const chargingHere = fid ? chargingFloors[fid] : undefined;
  const setWatch = useRealtime((s) => s.setWatch);
  const robotsByCode = useRealtime((s) => s.robots);
  const robots = useMemo(
    () => Object.values(robotsByCode).filter((r) => r.floor === fid).sort((a, b) => a.code.localeCompare(b.code)),
    [robotsByCode, fid],
  );

  const [selected, setSelected] = useState<string | null>(null);
  const [selCam, setSelCam] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mapRef = useRef<FloorMapHandle>(null);
  const pending = useRef(new Set<string>());

  useEffect(() => {
    if (!fid) return;
    setWatch([fid]);
    return () => setWatch([]);
  }, [fid, setWatch]);

  // 只對這個畫面送出的指令跳提示
  const results = useRealtime((s) => s.cmdResults);
  const shown = useRef(new Set<string>());
  useEffect(() => {
    for (const r of results) {
      const key = `${r.cmdId}:${r.status}`;
      if (!pending.current.has(r.cmdId) || shown.current.has(key)) continue;
      shown.current.add(key);
      toastResult(r);
      if (r.status !== 'accepted') pending.current.delete(r.cmdId);
    }
  }, [results]);

  function chooseFloor(id: string) {
    setFloorId(id);
    setSelected(null);
    setSelCam(null);
    try {
      localStorage.setItem(FLOOR_KEY, id);
    } catch {
      /* 不記住也沒關係 */
    }
  }

  const robot = robots.find((r) => r.robotId === selected) ?? null;

  async function command(type: DrawerCommand) {
    if (!robot) return;
    setBusy(true);
    try {
      const r = await api<{ cmdId: string }>(`/robots/${robot.robotId}/commands`, { method: 'POST', json: { type } });
      pending.current.add(r.cmdId);
      useToast.getState().show(t('robot.cmd.sent', { code: robot.code, type: cmdLabel(type) }));
    } catch (e) {
      useToast.getState().show(e instanceof ApiError ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  const camList = cameras.data ?? [];
  // 只播放點選的那一路（影像與整合 §1：首頁不同時開所有攝影機）
  const cam = camList.find((c) => c.id === selCam) ?? null;

  return (
    <div className="monitor">
      <TasksPanel
        floorName={(id) => floors.data?.find((f) => f.id === id)?.name ?? id}
        focusedRobotId={selected}
        onFocusRobot={(task) => {
          if (task.floorId !== fid) chooseFloor(task.floorId);
          setSelected(task.robotId);
        }}
      />

      <section className="panel map" aria-label={floor?.name}>
        <div className="map-tools">
          {(floors.data ?? []).map((f) => (
            <button key={f.id} type="button" className={`chip${f.id === fid ? ' on' : ''}`} aria-pressed={f.id === fid} onClick={() => chooseFloor(f.id)}>
              {f.name}
            </button>
          ))}
          <button type="button" className="chip" aria-label={t('monitor.map.zoomIn')} onClick={() => mapRef.current?.zoomIn()}>
            ＋
          </button>
          <button type="button" className="chip" aria-label={t('monitor.map.zoomOut')} onClick={() => mapRef.current?.zoomOut()}>
            －
          </button>
          <button type="button" className="chip" onClick={() => mapRef.current?.fit()}>
            {t('monitor.map.fit')}
          </button>
          <div className="stats">
            <span>
              {t('monitor.map.robots')} <b>{robots.length}</b> {t('common.units')}
            </span>
            <span>
              {t('monitor.map.cameras')} <b>{camList.length}</b> {t('common.units')}
            </span>
          </div>
        </div>
        <div className="stage">
          {floor && (
            <FloorMap
              ref={mapRef}
              viewKey={floor.id}
              widthM={floor.widthM}
              heightM={floor.heightM}
              planUrl={floor.planUrl}
              robots={robots.map((r) => ({
                id: r.robotId,
                code: r.code,
                x: r.x,
                y: r.y,
                yaw: r.yaw,
                state: r.state,
                online: r.online,
                battery: r.battery,
                tip: `${r.code} · ${t((r.online ? `state.${r.state}` : 'state.offline') as MessageKey)} · ${Math.round(r.battery)}%`,
              }))}
              cameras={camList}
              chargers={(chargers.data ?? []).map((c) => ({
                ...c,
                // 充電排程的即時佔用優先（WebSocket charger.updated），沒有才用資料庫欄位
                occupiedBy: chargingHere?.chargers.find((x) => x.id === c.id)?.occupiedBy?.code ?? (chargingHere ? null : (c.occupiedBy?.code ?? null)),
              }))}
              selectedRobotId={selected}
              onRobotClick={(id) => setSelected((s) => (s === id ? null : id))}
              onCameraClick={(id) => setSelCam(id)}
            >
              <div className="floor-tag">
                <strong>{floor.name}</strong>
                <span>{t('monitor.map.floorSub', { robots: robots.length, cameras: camList.length })}</span>
                {!!chargingHere?.queue.length && <span className="warn-text">{t('charge.queue', { n: chargingHere.queue.length })}</span>}
                {!floor.planUrl && <em>{floor.widthM ? t('monitor.map.noPlan') : t('monitor.map.noSize')}</em>}
              </div>
              <div className="legend">
                <span>
                  <i className="lg-working" />
                  {t('monitor.legend.working')}
                </span>
                <span>
                  <i className="lg-idle" />
                  {t('monitor.legend.idle')}
                </span>
                <span>
                  <i className="lg-manual" />
                  {t('monitor.legend.manual')}
                </span>
                <span>
                  <i className="lg-charge" />
                  {t('monitor.legend.charge')}
                </span>
                <span>
                  <i className="lg-fault" />
                  {t('monitor.legend.fault')}
                </span>
                <span>
                  <i className="lg-dock" />
                  {t('monitor.legend.dock')}
                </span>
                <span>
                  <i className="lg-cam" />
                  {t('monitor.legend.camera')}
                </span>
                <span>
                  <i className="lg-alarm" />
                  {t('monitor.legend.alarm')}
                </span>
              </div>
            </FloorMap>
          )}
        </div>
      </section>

      <section className="panel cams" aria-label={t('monitor.cams')}>
        <div className="panel-head">
          {t('monitor.cams')} <span className="meta">({camList.length})</span>
        </div>
        {cam && (
          <div className="cam-live">
            <VideoPlayer key={cam.streamKey} streamKey={cam.streamKey} label={`${cam.code} ${cam.name}`}>
              <MediaControls streamKey={cam.streamKey} name={cam.name} />
              <button type="button" className="vbtn" aria-label={t('video.close')} onClick={() => setSelCam(null)}>
                ✕
              </button>
            </VideoPlayer>
          </div>
        )}
        <div className="scroll">
          {camList.length === 0 ? (
            <div className="empty">{t('monitor.cams.empty')}</div>
          ) : (
            <div className="cam-grid">
              {camList.map((c) => (
                <button key={c.id} type="button" className={`feed${c.id === selCam ? ' sel' : ''}`} onClick={() => setSelCam(c.id)} title={c.name}>
                  <span className="code">{c.code}</span>
                  <span className="nosig">{c.id === selCam ? t('monitor.cams.playing') : t('monitor.cams.clickToPlay')}</span>
                  <span className="name">{c.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </section>

      <AlertLog />

      {robot && (
        <RobotDrawer
          robot={robot}
          floorName={floor?.name ?? robot.floor}
          busy={busy}
          charge={chargeStatusOf(chargingFloors, robot.robotId)}
          onClose={() => setSelected(null)}
          onCommand={command}
        />
      )}
    </div>
  );
}

function toastResult(r: CmdResult) {
  const vars = { code: r.code, type: cmdLabel(r.type), reason: r.error?.msg ?? r.error?.code ?? '' };
  const show = useToast.getState().show;
  if (r.status === 'accepted') show(t('robot.cmd.accepted', vars));
  else if (r.status === 'done') show(t('robot.cmd.done', vars), 'ok');
  else if (r.status === 'rejected') show(t('robot.cmd.rejected', vars), 'warn');
  else show(t('robot.cmd.failed', vars), 'error');
}
