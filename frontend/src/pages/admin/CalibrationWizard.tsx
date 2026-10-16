import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../api/client';
import { FloorMap, type MapMark } from '../../components/FloorMap/FloorMap';
import { t } from '../../i18n';
import { useToast } from '../../stores/toast';

export interface CalibRow {
  robotId: string;
  code: string;
  brand: string;
  model: string;
  online: boolean;
  calib: { mapId: string; rmseM: number; points: number; updatedAt: string } | null;
}
interface Point {
  u: string;
  v: string;
  x: number | null;
  y: number | null;
}
interface Detail {
  calib: { mapId: string; points: { u: number; v: number; x: number; y: number }[]; rmseM: number } | null;
  live: { online: boolean; u: number; v: number } | null;
  maxRmseM: number;
}
interface Fit {
  ok: boolean;
  reason?: string;
  rmseM?: number;
  residuals?: number[];
  rotationDeg?: number;
  scale?: number;
  maxRmseM: number;
}

const empty = (): Point => ({ u: '', v: '', x: null, y: null });
const num = (s: string) => (s.trim() === '' || Number.isNaN(Number(s)) ? null : Number(s));

/**
 * 座標校正精靈（工程開發手冊「機器人接入」§6、T-26）。
 * 1. 讓機器人走到 3 個以上分散的位置；每個位置在平面圖上點出 (x,y)，並「帶入目前位置」或手動輸入機器人地圖座標 (u,v)。
 * 2. 每改一次就試算誤差（RMSE）；超過 0.5 m 不能儲存，誤差大的點標紅，方便重量。
 * 3. 同樓層同品牌共用一張地圖的機器人可一起套用。
 */
export function CalibrationWizard({
  robot,
  group,
  floor,
  onClose,
}: {
  robot: CalibRow;
  group: CalibRow[];
  floor: { id: string; name: string; planUrl: string | null; widthM: number | null; heightM: number | null };
  onClose(): void;
}) {
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: ['calibration', robot.robotId], queryFn: () => api<Detail>(`/robots/${robot.robotId}/calibration`) });
  const [mapId, setMapId] = useState('');
  const [points, setPoints] = useState<Point[]>([empty(), empty(), empty()]);
  const [picking, setPicking] = useState<number | null>(null);
  const [applyTo, setApplyTo] = useState<string[]>([]);
  const [fit, setFit] = useState<Fit | null>(null);
  const [busy, setBusy] = useState(false);
  const loaded = useRef(false);
  const toast = useToast.getState().show;

  // 已有校正：帶入原本的點，方便微調
  useEffect(() => {
    if (loaded.current || !detail.data) return;
    loaded.current = true;
    const c = detail.data.calib;
    setMapId(c?.mapId ?? `${floor.id}-map`);
    if (c?.points.length) setPoints(c.points.map((p) => ({ u: String(p.u), v: String(p.v), x: p.x, y: p.y })));
  }, [detail.data, floor.id]);

  const complete = points
    .map((p, i) => ({ i, u: num(p.u), v: num(p.v), x: p.x, y: p.y }))
    .filter((p): p is { i: number; u: number; v: number; x: number; y: number } => p.u !== null && p.v !== null && p.x !== null && p.y !== null);

  // 每次改點就試算（稍等 300 ms，打字時不要一直送）
  const key = JSON.stringify(complete);
  useEffect(() => {
    if (complete.length === 0) return setFit(null);
    const id = setTimeout(() => {
      api<Fit>(`/robots/${robot.robotId}/calibration/fit`, { method: 'POST', json: { points: complete.map(({ u, v, x, y }) => ({ u, v, x, y })) } }).then(setFit, () => setFit(null));
    }, 300);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, robot.robotId]);

  const residualOf = (i: number) => {
    const k = complete.findIndex((p) => p.i === i);
    return k >= 0 && fit?.residuals ? fit.residuals[k] : null;
  };
  const max = fit?.maxRmseM ?? 0.5;
  const marks: MapMark[] = points.flatMap((p, i) => {
    if (p.x === null || p.y === null) return [];
    const r = residualOf(i);
    return [{ id: `c${i}`, x: p.x, y: p.y, label: String(i + 1), tone: r === null ? 'draft' : r > max ? 'bad' : 'ok', title: r === null ? undefined : t('calib.residual', { r }) }];
  });

  const set = (i: number, patch: Partial<Point>) => setPoints((l) => l.map((p, j) => (j === i ? { ...p, ...patch } : p)));

  async function useCurrent(i: number) {
    let d: Detail;
    try {
      d = await api<Detail>(`/robots/${robot.robotId}/calibration`);
    } catch (e) {
      return toast(e instanceof ApiError ? e.message : String(e), 'error');
    }
    if (!d.live?.online) return toast(t('calib.offline', { code: robot.code }), 'error');
    set(i, { u: String(d.live.u), v: String(d.live.v) });
  }

  async function save() {
    setBusy(true);
    try {
      const r = await api<{ rmseM: number; applied: string[] }>(`/robots/${robot.robotId}/calibration`, {
        method: 'PUT',
        json: { mapId: mapId.trim(), points: complete.map(({ u, v, x, y }) => ({ u, v, x, y })), applyTo },
      });
      toast(t('calib.saved', { n: r.applied.length, rmse: r.rmseM }), 'ok');
      await qc.invalidateQueries({ queryKey: ['calibrations'] });
      onClose();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    try {
      await api(`/robots/${robot.robotId}/calibration`, { method: 'DELETE' });
      toast(t('calib.cleared', { code: robot.code }), 'ok');
      await qc.invalidateQueries({ queryKey: ['calibrations'] });
      onClose();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : String(e), 'error');
    }
  }

  const peers = group.filter((g) => g.robotId !== robot.robotId && g.brand === robot.brand);

  return (
    <div className="modal-bg" onKeyDown={(e) => e.key === 'Escape' && picking === null && onClose()}>
      <div className="modal wide-modal calib-wizard" role="dialog" aria-modal="true" aria-label={t('calib.title', { code: robot.code })}>
        <h2>{t('calib.title', { code: robot.code })}</h2>
        <p className="hint">{t('calib.intro')}</p>
        <div className="cw-body">
          <div className={`cw-map${picking !== null ? ' picking' : ''}`}>
            <FloorMap
              widthM={floor.widthM}
              heightM={floor.heightM}
              planUrl={floor.planUrl}
              marks={marks}
              pickMode={picking !== null}
              onPick={(p) => {
                if (picking === null) return;
                set(picking, { x: p.x, y: p.y });
                setPicking(null);
              }}
              viewKey={floor.id}
            />
            {picking !== null && <div className="pick-tip">{t('calib.pickTip', { n: picking + 1 })}</div>}
          </div>
          <div className="cw-side">
            <label className="fl">
              {t('calib.mapId')}
              <input value={mapId} maxLength={64} onChange={(e) => setMapId(e.target.value)} />
            </label>
            <table className="cw-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>{t('calib.plan')}</th>
                  <th>{t('calib.robotUv')}</th>
                  <th>{t('calib.err')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {points.map((p, i) => {
                  const r = residualOf(i);
                  return (
                    <tr key={i} data-point={i + 1}>
                      <td className="mono">{i + 1}</td>
                      <td>
                        <button type="button" className={`obtn${picking === i ? ' on' : ''}`} onClick={() => setPicking(picking === i ? null : i)}>
                          {p.x === null ? t('calib.pick') : `${p.x}, ${p.y}`}
                        </button>
                      </td>
                      <td>
                        <div className="uv">
                          <input aria-label={t('calib.u', { n: i + 1 })} inputMode="decimal" placeholder="u" value={p.u} onChange={(e) => set(i, { u: e.target.value })} />
                          <input aria-label={t('calib.v', { n: i + 1 })} inputMode="decimal" placeholder="v" value={p.v} onChange={(e) => set(i, { v: e.target.value })} />
                          <button type="button" className="mini" title={t('calib.useCurrentTip')} onClick={() => void useCurrent(i)}>
                            {t('calib.useCurrent')}
                          </button>
                        </div>
                      </td>
                      <td className={`mono${r !== null && r > max ? ' bad' : ''}`}>{r === null ? '—' : `${r} m`}</td>
                      <td>
                        <button
                          type="button"
                          className="ib del"
                          aria-label={t('calib.removePoint', { n: i + 1 })}
                          disabled={points.length <= 1}
                          onClick={() => setPoints((l) => l.filter((_, j) => j !== i))}
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <button type="button" className="obtn" disabled={points.length >= 50} onClick={() => setPoints((l) => [...l, empty()])}>
              {t('calib.addPoint')}
            </button>

            <div className={`cw-result${fit ? (fit.ok ? ' ok' : ' bad') : ''}`} role="status">
              {!fit || complete.length < 3
                ? t('calib.needPoints', { n: complete.length })
                : fit.reason
                  ? fit.reason
                  : fit.ok
                    ? t('calib.ok', { rmse: fit.rmseM!, rot: fit.rotationDeg!, scale: fit.scale! })
                    : t('calib.tooBig', { rmse: fit.rmseM!, max })}
            </div>
            {/* 3 點剛好解出仿射轉換，誤差必為 0，量錯也看不出來 */}
            {complete.length === 3 && fit?.ok && <p className="warn-text">{t('calib.threeOnly')}</p>}

            {peers.length > 0 && (
              <div className="fl">
                {t('calib.applyTo')}
                <div className="radios">
                  {peers.map((g) => (
                    <label key={g.robotId}>
                      <input type="checkbox" checked={applyTo.includes(g.robotId)} onChange={(e) => setApplyTo((l) => (e.target.checked ? [...l, g.robotId] : l.filter((x) => x !== g.robotId)))} />
                      {g.code}
                    </label>
                  ))}
                </div>
                <span className="fhint">{t('calib.applyHint')}</span>
              </div>
            )}
          </div>
        </div>
        <div className="row">
          {detail.data?.calib && (
            <button type="button" className="btn danger push-right" onClick={() => void clear()}>
              {t('calib.clear')}
            </button>
          )}
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn primary" disabled={busy || !fit?.ok || complete.length < 3 || !mapId.trim()} onClick={() => void save()}>
            {t('common.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
