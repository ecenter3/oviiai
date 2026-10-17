import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../api/client';
import { BulkImportDialog } from '../../components/BulkImportDialog';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { FloorMap } from '../../components/FloorMap/FloorMap';
import { t, type MessageKey } from '../../i18n';
import { useToast } from '../../stores/toast';
import { type CalibRow, CalibrationWizard } from './CalibrationWizard';
import { BRANDS } from './RobotAdminPage';

interface Floor {
  id: string;
  name: string;
  planUrl: string | null;
  widthM: number | null;
  heightM: number | null;
  robotQuota: number;
}
interface Charger {
  id: string;
  code: string;
  floorId: string;
  x: number;
  y: number;
  brand: (typeof BRANDS)[number];
  enabled: boolean;
  robotDock: Record<string, string | number>;
  occupiedBy: { robotId: string; code: string } | null;
}
interface Camera {
  id: string;
  code: string;
  name: string;
  floorId: string;
  x: number;
  y: number;
  enabled: boolean;
  hasRtsp: boolean;
}

type Kind = 'charger' | 'camera';
interface PointForm {
  kind: Kind;
  id: string | null;
  code: string;
  name: string;
  brand: (typeof BRANDS)[number];
  dockId: string;
  rtspUrl: string;
  x: string;
  y: string;
  enabled: boolean;
}

const emptyPoint = (kind: Kind): PointForm => ({
  kind,
  id: null,
  code: '',
  name: '',
  brand: 'anbot',
  dockId: '',
  rtspUrl: '',
  x: '',
  y: '',
  enabled: true,
});
const MAX_PLAN = 15 * 1024 * 1024;

/**
 * 地圖管理（/maps，原型「地圖管理」；T-25）：各樓層平面圖上傳（PNG／JPEG／WebP）、實際尺寸、配置台數；
 * 在平面圖上點選位置放置充電樁與攝影機。攝影機 RTSP 帳密只寫不讀（加密存放）。座標校正精靈是 T-26。
 */
export function MapsPage() {
  const qc = useQueryClient();
  const [bulk, setBulk] = useState(false);
  const floors = useQuery({
    queryKey: ['floors'],
    queryFn: () => api<Floor[]>('/floors'),
  });
  const [floorId, setFloorId] = useState<string | null>(null);
  const floor = floors.data?.find((f) => f.id === floorId) ?? floors.data?.[0];
  const fid = floor?.id;
  const chargers = useQuery({
    queryKey: ['chargers', fid],
    queryFn: () => api<Charger[]>(`/chargers?floor=${fid}`),
    enabled: !!fid,
  });
  const cameras = useQuery({
    queryKey: ['cameras', fid],
    queryFn: () => api<Camera[]>(`/cameras?floor=${fid}`),
    enabled: !!fid,
  });
  const calibs = useQuery({
    queryKey: ['calibrations', fid],
    queryFn: () => api<CalibRow[]>(`/calibrations?floor=${fid}`),
    enabled: !!fid,
  });
  const [calibrating, setCalibrating] = useState<CalibRow | null>(null);

  const [size, setSize] = useState({ w: '', h: '', quota: '' });
  const [point, setPoint] = useState<PointForm>(() => emptyPoint('charger'));
  const [picking, setPicking] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<{
    kind: Kind;
    id: string;
    code: string;
  } | null>(null);
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (floor)
      setSize({
        w: floor.widthM?.toString() ?? '',
        h: floor.heightM?.toString() ?? '',
        quota: String(floor.robotQuota),
      });
  }, [floor]);
  useEffect(() => {
    setPoint((p) => emptyPoint(p.kind));
    setPicking(false);
  }, [fid]);

  const toast = useToast.getState().show;
  const fail = (e: unknown) => {
    if (e instanceof ApiError) {
      setErrors((e.details.fields as Record<string, string> | undefined) ?? {});
      toast(e.message, 'error');
    } else toast(String(e), 'error');
  };

  async function upload(f: File) {
    if (!fid) return;
    if (f.size > MAX_PLAN) return toast(t('maps.plan.tooBig'), 'error');
    const fd = new FormData();
    fd.append('file', f);
    setBusy(true);
    try {
      await api(`/floors/${fid}/plan`, { method: 'POST', body: fd });
      toast(t('maps.plan.uploaded', { floor: floor!.name }), 'ok');
      await qc.invalidateQueries({ queryKey: ['floors'] });
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
      if (file.current) file.current.value = '';
    }
  }

  async function removePlan() {
    if (!fid) return;
    try {
      await api(`/floors/${fid}/plan`, { method: 'DELETE' });
      await qc.invalidateQueries({ queryKey: ['floors'] });
    } catch (e) {
      fail(e);
    }
  }

  async function saveSize() {
    if (!fid) return;
    const num = (s: string) => (s.trim() ? Number(s) : null);
    try {
      await api(`/floors/${fid}`, {
        method: 'PUT',
        json: {
          widthM: num(size.w),
          heightM: num(size.h),
          robotQuota: Number(size.quota || 0),
        },
      });
      toast(t('maps.size.saved'), 'ok');
      await qc.invalidateQueries({ queryKey: ['floors'] });
    } catch (e) {
      fail(e);
    }
  }

  async function savePoint() {
    if (!fid) return;
    setErrors({});
    const x = Number(point.x);
    const y = Number(point.y);
    if (point.x === '' || point.y === '' || Number.isNaN(x) || Number.isNaN(y)) return setErrors({ x: t('maps.point.pickFirst') });
    const isCharger = point.kind === 'charger';
    const body = isCharger
      ? {
          code: point.code.trim().toUpperCase(),
          floorId: fid,
          x,
          y,
          brand: point.brand,
          robotDock: point.dockId.trim() ? { id: point.dockId.trim() } : {},
          enabled: point.enabled,
        }
      : {
          code: point.code.trim().toUpperCase(),
          name: point.name.trim(),
          floorId: fid,
          x,
          y,
          enabled: point.enabled,
          ...(point.rtspUrl.trim() && { rtspUrl: point.rtspUrl.trim() }),
        };
    if (!isCharger && !point.id && !point.rtspUrl.trim()) return setErrors({ rtspUrl: t('maps.point.rtspRequired') });
    setBusy(true);
    try {
      const base = isCharger ? '/chargers' : '/cameras';
      await api(point.id ? `${base}/${point.id}` : base, {
        method: point.id ? 'PATCH' : 'POST',
        json: body,
      });
      toast(t('maps.point.saved', { code: body.code }), 'ok');
      setPoint(emptyPoint(point.kind));
      setPicking(false);
      await qc.invalidateQueries({
        queryKey: [isCharger ? 'chargers' : 'cameras'],
      });
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  async function remove(kind: Kind, id: string) {
    try {
      await api(`/${kind === 'charger' ? 'chargers' : 'cameras'}/${id}`, {
        method: 'DELETE',
      });
      await qc.invalidateQueries({
        queryKey: [kind === 'charger' ? 'chargers' : 'cameras'],
      });
      if (point.id === id) setPoint(emptyPoint(kind));
    } catch (e) {
      fail(e);
    }
  }

  const editCharger = (c: Charger) =>
    setPoint({
      kind: 'charger',
      id: c.id,
      code: c.code,
      name: '',
      brand: c.brand,
      dockId: String(c.robotDock.id ?? ''),
      rtspUrl: '',
      x: String(c.x),
      y: String(c.y),
      enabled: c.enabled,
    });
  const editCamera = (c: Camera) =>
    setPoint({
      kind: 'camera',
      id: c.id,
      code: c.code,
      name: c.name,
      brand: 'anbot',
      dockId: '',
      rtspUrl: '',
      x: String(c.x),
      y: String(c.y),
      enabled: c.enabled,
    });

  const draft =
    point.x !== '' && point.y !== ''
      ? [
          {
            id: 'draft',
            x: Number(point.x),
            y: Number(point.y),
            label: t('maps.point.here'),
          },
        ]
      : [];

  return (
    <div className="pg2">
      {bulk && <BulkImportDialog kind="cameras" onClose={() => setBulk(false)} onDone={() => void qc.invalidateQueries({ queryKey: ['cameras'] })} />}
      <section className="panel">
        <div className="pane-head">
          <span className="title">{t('page.maps')}</span>
          <div className="seg2" role="tablist">
            {floors.data?.map((f) => (
              <button
                key={f.id}
                type="button"
                role="tab"
                aria-selected={f.id === fid}
                className={f.id === fid ? 'on' : ''}
                onClick={() => setFloorId(f.id)}
              >
                {f.name}
              </button>
            ))}
          </div>
          <span className="meta">
            {floor
              ? t('maps.meta', {
                  size: floor.widthM && floor.heightM ? `${floor.widthM} × ${floor.heightM} m` : t('maps.size.unset'),
                  plan: floor.planUrl ? t('maps.plan.has') : t('maps.plan.none'),
                })
              : ''}
          </span>
        </div>
        <div className="scroll">
          <div className="pane-body maps-body">
            <div className={`maps-stage${picking ? ' picking' : ''}`}>
              {floor && (
                <FloorMap
                  widthM={floor.widthM}
                  heightM={floor.heightM}
                  planUrl={floor.planUrl}
                  chargers={(chargers.data ?? []).map((c) => ({
                    id: c.id,
                    code: c.code,
                    x: c.x,
                    y: c.y,
                    occupiedBy: c.occupiedBy?.code ?? null,
                  }))}
                  cameras={(cameras.data ?? []).map((c) => ({
                    id: c.id,
                    name: c.name,
                    x: c.x,
                    y: c.y,
                  }))}
                  alarms={draft}
                  onChargerClick={(id) => {
                    const c = chargers.data?.find((x) => x.id === id);
                    if (c) editCharger(c);
                  }}
                  onCameraClick={(id) => {
                    const c = cameras.data?.find((x) => x.id === id);
                    if (c) editCamera(c);
                  }}
                  pickMode={picking}
                  onPick={(p) => {
                    setPoint((f) => ({ ...f, x: String(p.x), y: String(p.y) }));
                    setPicking(false);
                  }}
                  viewKey={fid}
                />
              )}
              {picking && <div className="pick-tip">{t('maps.point.pickTip')}</div>}
            </div>

            <h3 className="sub-h">{t('maps.chargers', { n: chargers.data?.length ?? 0 })}</h3>
            <div className="tbl-wrap">
              <table className="dtbl">
                <thead>
                  <tr>
                    <th>{t('maps.col.code')}</th>
                    <th>{t('maps.col.brand')}</th>
                    <th>{t('maps.col.pos')}</th>
                    <th>{t('maps.col.dock')}</th>
                    <th>{t('maps.col.status')}</th>
                    <th>{t('alarm.col.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {(chargers.data ?? []).length === 0 && (
                    <tr>
                      <td colSpan={6} className="tbl-empty">
                        {t('maps.empty')}
                      </td>
                    </tr>
                  )}
                  {chargers.data?.map((c) => (
                    <tr key={c.id} data-charger={c.code}>
                      <td className="mono">{c.code}</td>
                      <td>{t(`brand.${c.brand}` as MessageKey)}</td>
                      <td className="mono">
                        ({c.x}, {c.y})
                      </td>
                      <td className="mono">{String(c.robotDock.id ?? '—')}</td>
                      <td>
                        {!c.enabled
                          ? t('maps.status.disabled')
                          : c.occupiedBy
                            ? t('maps.status.occupied', {
                                code: c.occupiedBy.code,
                              })
                            : t('maps.status.free')}
                      </td>
                      <td>
                        <div className="acts">
                          <button type="button" className="obtn" onClick={() => editCharger(c)}>
                            {t('robotmgr.edit')}
                          </button>
                          <button
                            type="button"
                            className="obtn red"
                            onClick={() =>
                              setRemoving({
                                kind: 'charger',
                                id: c.id,
                                code: c.code,
                              })
                            }
                          >
                            {t('maps.delete')}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h3 className="sub-h">
              {t('maps.cameras', { n: cameras.data?.length ?? 0 })}
              <button type="button" className="obtn" onClick={() => setBulk(true)}>
                {t('bulk.open')}
              </button>
            </h3>
            <div className="tbl-wrap">
              <table className="dtbl">
                <thead>
                  <tr>
                    <th>{t('maps.col.code')}</th>
                    <th>{t('maps.col.name')}</th>
                    <th>{t('maps.col.pos')}</th>
                    <th>{t('maps.col.rtsp')}</th>
                    <th>{t('maps.col.status')}</th>
                    <th>{t('alarm.col.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {(cameras.data ?? []).length === 0 && (
                    <tr>
                      <td colSpan={6} className="tbl-empty">
                        {t('maps.empty')}
                      </td>
                    </tr>
                  )}
                  {cameras.data?.map((c) => (
                    <tr key={c.id} data-camera={c.code}>
                      <td className="mono">{c.code}</td>
                      <td>{c.name}</td>
                      <td className="mono">
                        ({c.x}, {c.y})
                      </td>
                      <td>{c.hasRtsp ? t('maps.rtsp.set') : t('maps.rtsp.unset')}</td>
                      <td>{c.enabled ? t('maps.status.enabled') : t('maps.status.disabled')}</td>
                      <td>
                        <div className="acts">
                          <button type="button" className="obtn" onClick={() => editCamera(c)}>
                            {t('robotmgr.edit')}
                          </button>
                          <button
                            type="button"
                            className="obtn red"
                            onClick={() =>
                              setRemoving({
                                kind: 'camera',
                                id: c.id,
                                code: c.code,
                              })
                            }
                          >
                            {t('maps.delete')}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h3 className="sub-h">{t('calib.section', { n: calibs.data?.length ?? 0 })}</h3>
            <div className="tbl-wrap">
              <table className="dtbl">
                <thead>
                  <tr>
                    <th>{t('robotmgr.col.code')}</th>
                    <th>{t('robotmgr.col.model')}</th>
                    <th>{t('calib.mapId')}</th>
                    <th>{t('calib.rmse')}</th>
                    <th>{t('calib.updated')}</th>
                    <th>{t('alarm.col.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {(calibs.data ?? []).length === 0 && (
                    <tr>
                      <td colSpan={6} className="tbl-empty">
                        {t('maps.empty')}
                      </td>
                    </tr>
                  )}
                  {calibs.data?.map((c) => (
                    <tr key={c.robotId} data-calib={c.code}>
                      <td className="mono">{c.code}</td>
                      <td>
                        {t(`brand.${c.brand}` as MessageKey)} {c.model}
                      </td>
                      <td className="mono">{c.calib?.mapId ?? '—'}</td>
                      <td>
                        {c.calib ? <span className="badge2 ok">{t('calib.rmseValue', { rmse: c.calib.rmseM, n: c.calib.points })}</span> : <span className="badge2 unreg">{t('calib.none')}</span>}
                      </td>
                      <td className="mono">{c.calib ? new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(new Date(c.calib.updatedAt)) : '—'}</td>
                      <td>
                        <button type="button" className="obtn" onClick={() => setCalibrating(c)}>
                          {t('calib.start')}
                        </button>
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
        <div className="scroll filt-in">
          <div className="fl">{t('maps.plan.title')}</div>
          <input
            ref={file}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            hidden
            aria-label={t('maps.plan.upload')}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
            }}
          />
          <button type="button" className="go2 danger" disabled={busy || !fid} onClick={() => file.current?.click()}>
            {floor?.planUrl ? t('maps.plan.replace') : t('maps.plan.upload')}
          </button>
          {floor?.planUrl && (
            <button type="button" className="go2" onClick={() => void removePlan()}>
              {t('maps.plan.remove')}
            </button>
          )}
          <p className="hint">{t('maps.plan.hint')}</p>

          <form
            className="filt-sub"
            onSubmit={(e) => {
              e.preventDefault();
              void saveSize();
            }}
          >
            <div className="fl">
              {t('maps.size.title')}
              <div className="trange">
                <input
                  aria-label={t('maps.size.w')}
                  placeholder={t('maps.size.w')}
                  inputMode="decimal"
                  value={size.w}
                  onChange={(e) => setSize((s) => ({ ...s, w: e.target.value }))}
                />
                <span>×</span>
                <input
                  aria-label={t('maps.size.h')}
                  placeholder={t('maps.size.h')}
                  inputMode="decimal"
                  value={size.h}
                  onChange={(e) => setSize((s) => ({ ...s, h: e.target.value }))}
                />
                <span>m</span>
              </div>
            </div>
            <label className="fl">
              {t('maps.size.quota')}
              <input
                type="number"
                min={0}
                max={100}
                value={size.quota}
                onChange={(e) => setSize((s) => ({ ...s, quota: e.target.value }))}
              />
            </label>
            <button type="submit" className="go2">
              {t('common.save')}
            </button>
          </form>

          <div className="tabs2">
            {(['charger', 'camera'] as const).map((k) => (
              <button key={k} type="button" className={point.kind === k ? 'on' : ''} onClick={() => setPoint(emptyPoint(k))}>
                {point.id && point.kind === k
                  ? t('maps.point.edit', { code: point.code })
                  : t(k === 'charger' ? 'maps.point.addCharger' : 'maps.point.addCamera')}
              </button>
            ))}
          </div>
          <form
            className="filt-sub"
            onSubmit={(e) => {
              e.preventDefault();
              void savePoint();
            }}
          >
            <div className="fl">
              <label>
                {t('maps.col.code')}
                <input
                  value={point.code}
                  required
                  maxLength={32}
                  placeholder={point.kind === 'charger' ? 'CHG-1F-3' : 'CAM-1F-08'}
                  onChange={(e) =>
                    setPoint((p) => ({
                      ...p,
                      code: e.target.value.toUpperCase(),
                    }))
                  }
                />
              </label>
              {errors.code && <span className="ferr">{errors.code}</span>}
            </div>
            {point.kind === 'charger' ? (
              <>
                <label className="fl">
                  {t('maps.col.brand')}
                  <select
                    value={point.brand}
                    onChange={(e) =>
                      setPoint((p) => ({
                        ...p,
                        brand: e.target.value as PointForm['brand'],
                      }))
                    }
                  >
                    {BRANDS.map((b) => (
                      <option key={b} value={b}>
                        {t(`brand.${b}` as MessageKey)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="fl">
                  {t('maps.col.dock')}
                  <input
                    value={point.dockId}
                    maxLength={100}
                    placeholder={t('maps.point.dockPh')}
                    onChange={(e) => setPoint((p) => ({ ...p, dockId: e.target.value }))}
                  />
                </label>
              </>
            ) : (
              <>
                <label className="fl">
                  {t('maps.col.name')}
                  <input value={point.name} required maxLength={32} onChange={(e) => setPoint((p) => ({ ...p, name: e.target.value }))} />
                </label>
                <div className="fl">
                  <label>
                    {t('maps.col.rtsp')}
                    <input
                      type="password"
                      value={point.rtspUrl}
                      maxLength={500}
                      autoComplete="off"
                      placeholder={point.id ? t('maps.point.rtspKeep') : 'rtsp://user:pass@10.0.0.20/stream1'}
                      onChange={(e) => setPoint((p) => ({ ...p, rtspUrl: e.target.value }))}
                    />
                  </label>
                  {errors.rtspUrl && <span className="ferr">{errors.rtspUrl}</span>}
                </div>
              </>
            )}
            <div className="fl">
              {t('maps.col.pos')}
              <div className="trange">
                <input
                  aria-label="x"
                  placeholder="x"
                  inputMode="decimal"
                  value={point.x}
                  onChange={(e) => setPoint((p) => ({ ...p, x: e.target.value }))}
                />
                <span>,</span>
                <input
                  aria-label="y"
                  placeholder="y"
                  inputMode="decimal"
                  value={point.y}
                  onChange={(e) => setPoint((p) => ({ ...p, y: e.target.value }))}
                />
              </div>
              {(errors.x || errors.y) && <span className="ferr">{errors.x ?? errors.y}</span>}
            </div>
            <button type="button" className={`go2${picking ? ' warn' : ''}`} onClick={() => setPicking((v) => !v)}>
              {picking ? t('maps.point.pickCancel') : t('maps.point.pick')}
            </button>
            <label className="check">
              <input type="checkbox" checked={point.enabled} onChange={(e) => setPoint((p) => ({ ...p, enabled: e.target.checked }))} />{' '}
              {t('maps.point.enabled')}
            </label>
            <button type="submit" className="go2 warn" disabled={busy}>
              {point.id ? t('common.save') : t(point.kind === 'charger' ? 'maps.point.addCharger' : 'maps.point.addCamera')}
            </button>
          </form>
          <p className="hint">{t('calib.sideHint')}</p>
        </div>
      </aside>

      {calibrating && floor && (
        <CalibrationWizard robot={calibrating} group={calibs.data ?? []} floor={floor} onClose={() => setCalibrating(null)} />
      )}
      {removing && (
        <ConfirmDialog
          title={t('maps.delete')}
          body={t('maps.deleteConfirm', { code: removing.code })}
          confirmText={t('maps.delete')}
          danger
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            const r = removing;
            setRemoving(null);
            void remove(r.kind, r.id);
          }}
        />
      )}
    </div>
  );
}
