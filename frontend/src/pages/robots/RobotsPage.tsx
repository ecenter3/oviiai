import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../api/client';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { robotTone } from '../../components/FloorMap/geometry';
import { PermGate } from '../../components/PermGate';
import { t, type MessageKey } from '../../i18n';
import { ChargeCompleteButton } from '../../components/ChargeCompleteButton';
import { useAuth } from '../../stores/auth';
import { type ChargeStatus, chargeStatusOf } from '../../stores/charging';
import { useChargingData } from '../useChargingData';
import { type RobotLive, useRealtime } from '../../stores/realtime';
import { useTasks } from '../../stores/tasks';
import { useToast } from '../../stores/toast';

interface Floor {
  id: string;
  name: string;
}

export interface RobotRow {
  id: string;
  code: string;
  brand: string;
  model: string;
  floorId: string;
  caps: string[];
  live: RobotLive | null;
  teleop: { userId: string; username: string } | null;
  task: { id: string; code: string; status: string; priority: string } | null;
}

const STATES = ['idle', 'navigating', 'patrolling', 'teleop', 'returning', 'charging', 'paused', 'estop', 'fault', 'offline'] as const;

/** 狀態（含離線）：卡片、篩選共用 */
export function stateOf(r: Pick<RobotRow, 'live'>): string {
  return r.live?.online ? r.live.state : 'offline';
}

const brandLabel = (b: string) => {
  const key = `brand.${b}` as MessageKey;
  const s = t(key);
  return s === key ? b : s;
};

/**
 * 機器人狀態（系統規格書 §4.2、T-15）：每台一張卡片（原型），依樓層、品牌、狀態篩選；
 * 急停／解除、回充、接管遙控、歸還自動。即時狀態走 WebSocket，靜態資料與遙控鎖、任務走 GET /robots。
 */
export function RobotsPage() {
  const qc = useQueryClient();
  const floors = useQuery({ queryKey: ['floors'], queryFn: () => api<Floor[]>('/floors') });
  const rows = useQuery({ queryKey: ['robots'], queryFn: () => api<RobotRow[]>('/robots'), refetchInterval: 10_000 });
  const live = useRealtime((s) => s.robots);
  const chargingFloors = useChargingData();
  const setWatch = useRealtime((s) => s.setWatch);
  const me = useAuth((s) => s.user);
  const [floor, setFloor] = useState('all');
  const [brand, setBrand] = useState('');
  const [state, setState] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<RobotRow | null>(null);

  // 卡片要看全部樓層的即時狀態
  useEffect(() => {
    if (!floors.data) return;
    setWatch(floors.data.map((f) => f.id));
    return () => setWatch([]);
  }, [floors.data, setWatch]);

  // 任務變化（派出、完成、暫停）時更新卡片上的任務與遙控狀態
  const taskVersion = useTasks((s) => s.active);
  useEffect(() => {
    void qc.invalidateQueries({ queryKey: ['robots'] });
  }, [taskVersion, qc]);

  const merged = useMemo(
    () => (rows.data ?? []).map((r) => ({ ...r, live: live[r.code] ?? r.live })),
    [rows.data, live],
  );
  const floorName = (id: string) => floors.data?.find((f) => f.id === id)?.name ?? id;
  const brands = [...new Set(merged.map((r) => r.brand))].sort();
  const shown = merged.filter(
    (r) => (floor === 'all' || r.floorId === floor) && (!brand || r.brand === brand) && (!state || stateOf(r) === state),
  );

  async function act(r: RobotRow, fn: () => Promise<unknown>, ok?: string) {
    setBusy(r.id);
    try {
      await fn();
      if (ok) useToast.getState().show(ok, 'ok');
      await qc.invalidateQueries({ queryKey: ['robots'] });
    } catch (e) {
      useToast.getState().show(e instanceof ApiError ? e.message : String(e), 'error');
    } finally {
      setBusy(null);
    }
  }
  const command = (r: RobotRow, type: string) =>
    act(r, () => api(`/robots/${r.id}/commands`, { method: 'POST', json: { type } }), t('robot.cmd.sent', { code: r.code, type: t(CMD[type]) }));

  return (
    <div className="robots">
      <div className="page-h">{t('robots.title', { n: merged.length })}</div>
      <div className="filters" role="group" aria-label={t('robots.filter.floor')}>
        <button type="button" className={`chip${floor === 'all' ? ' on' : ''}`} aria-pressed={floor === 'all'} onClick={() => setFloor('all')}>
          {t('robots.filter.all', { n: merged.length })}
        </button>
        {(floors.data ?? []).map((f) => (
          <button key={f.id} type="button" className={`chip${floor === f.id ? ' on' : ''}`} aria-pressed={floor === f.id} onClick={() => setFloor(f.id)}>
            {f.name}（{merged.filter((r) => r.floorId === f.id).length}）
          </button>
        ))}
        <span className="sep" />
        <select aria-label={t('robots.filter.brand')} value={brand} onChange={(e) => setBrand(e.target.value)}>
          <option value="">{t('robots.filter.anyBrand')}</option>
          {brands.map((b) => (
            <option key={b} value={b}>
              {brandLabel(b)}
            </option>
          ))}
        </select>
        <select aria-label={t('robots.filter.state')} value={state} onChange={(e) => setState(e.target.value)}>
          <option value="">{t('robots.filter.anyState')}</option>
          {STATES.map((s) => (
            <option key={s} value={s}>
              {t(`state.${s}` as MessageKey)}
            </option>
          ))}
        </select>
      </div>

      {rows.isLoading ? (
        <p className="muted">{t('common.loading')}</p>
      ) : shown.length === 0 ? (
        <p className="muted">{t('robots.empty')}</p>
      ) : (
        <div className="rgrid">
          {shown.map((r) => (
            <RobotCard
              key={r.id}
              robot={r}
              floorName={floorName(r.floorId)}
              charge={chargeStatusOf(chargingFloors, r.id)}
              mine={r.teleop?.userId === me?.id}
              busy={busy === r.id}
              onEstop={() => void command(r, 'estop')}
              onRelease={() => setConfirm(r)}
              onCharge={() => void command(r, 'charge')}
              onTakeover={() =>
                void act(r, () => api(`/robots/${r.id}/teleop/acquire`, { method: 'POST' }), t('robots.takeover.ok', { code: r.code }))
              }
              onGiveBack={() =>
                void act(r, () => api(`/robots/${r.id}/teleop/release`, { method: 'POST' }), t('robots.release.ok', { code: r.code }))
              }
            />
          ))}
        </div>
      )}

      {confirm && (
        <ConfirmDialog
          title={t('robot.act.estopRelease')}
          body={t('robot.act.estopReleaseConfirm', { code: confirm.code })}
          confirmText={t('robot.act.estopRelease')}
          danger
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const r = confirm;
            setConfirm(null);
            void command(r, 'estop_release');
          }}
        />
      )}
    </div>
  );
}

const CMD: Record<string, MessageKey> = {
  estop: 'robot.act.estop',
  estop_release: 'robot.act.estopRelease',
  charge: 'robot.act.charge',
};

const VALUE_CLASS: Record<string, string> = {
  idle: 'idle',
  charge: 'warn',
  manual: 'man',
  estop: 'crit',
  fault: 'crit',
  offline: 'off',
};

function RobotCard(props: {
  robot: RobotRow;
  floorName: string;
  charge: ChargeStatus | null;
  mine: boolean;
  busy: boolean;
  onEstop(): void;
  onRelease(): void;
  onCharge(): void;
  onTakeover(): void;
  onGiveBack(): void;
}) {
  const { robot: r, busy } = props;
  const st = stateOf(r);
  const tone = robotTone(r.live?.state ?? 'offline', !!r.live?.online);
  const low = (r.live?.battery ?? 100) < 40;
  const dot = st === 'offline' ? 'off' : st === 'estop' || st === 'fault' ? 'crit' : tone === 'charge' || low ? 'warn' : '';
  const faults = r.live?.faults ?? [];
  const online = !!r.live?.online;
  return (
    <article className={`rcard${st === 'estop' ? ' estop' : ''}`} aria-label={r.code} data-robot-card={r.code}>
      <h3>
        {r.code}
        <span className={`dot ${dot}`} />
        <small>
          {brandLabel(r.brand)} {r.model}
        </small>
      </h3>
      <div className="row">
        <span>{t('robot.floor')}</span>
        <b>{props.floorName}</b>
      </div>
      <div className="row">
        <span>{t('robot.state')}</span>
        <b className={VALUE_CLASS[tone] ?? ''}>{t(`state.${st}` as MessageKey)}</b>
      </div>
      <div className="row">
        <span>{t('robot.battery')}</span>
        <b className={low ? 'warn' : ''}>{r.live ? `${r.live.battery.toFixed(0)}%${r.live.charging ? ' ⚡' : ''}` : '—'}</b>
      </div>
      <div className="row">
        <span>{t('robots.charge')}</span>
        <b className={props.charge?.kind === 'manual' ? 'warn' : ''}>{props.charge?.text ?? '—'}</b>
      </div>
      <div className="row">
        <span>{t('robots.task')}</span>
        <b>{r.task ? `${r.task.code}（${t(`task.status.${r.task.status}` as MessageKey)}）` : '—'}</b>
      </div>
      <div className="row">
        <span>{t('robot.signal')}</span>
        <b>{r.live?.rssi != null ? `${r.live.rssi} dBm` : '—'}</b>
      </div>
      <div className="row">
        <span>{t('robots.faultCodes')}</span>
        <b className={faults.length ? 'crit' : ''}>{faults.length ? faults.map((f) => f.code).join('、') : '—'}</b>
      </div>
      {r.teleop && <div className="rc-note">{t('robots.teleopBy', { name: r.teleop.username })}</div>}

      <div className="rc-acts">
        {props.charge?.kind === 'manual' && <ChargeCompleteButton robotId={r.id} code={r.code} />}
        <PermGate perms={['op.estop']}>
          {st === 'estop' ? (
            <button type="button" className="mini" disabled={busy} onClick={props.onRelease}>
              {t('robot.act.estopRelease')}
            </button>
          ) : (
            <button type="button" className="mini danger" disabled={busy} onClick={props.onEstop}>
              {t('robot.act.estop')}
            </button>
          )}
        </PermGate>
        <PermGate perms={['op.remote']}>
          <button type="button" className="mini" disabled={busy || !online || st === 'estop'} onClick={props.onCharge}>
            {t('robot.act.charge')}
          </button>
        </PermGate>
        <PermGate perms={['remote', 'op.remote']}>
          {props.mine ? (
            <>
              <button type="button" className="mini yes" disabled={busy} onClick={props.onGiveBack}>
                {t('robots.act.release')}
              </button>
              <Link className="mini" to={`/remote/${r.id}`}>
                {t('robots.act.openRemote')}
              </Link>
            </>
          ) : (
            <button type="button" className="mini" disabled={busy || !online || st === 'estop' || !!r.teleop} onClick={props.onTakeover}>
              {t('robots.act.takeover')}
            </button>
          )}
        </PermGate>
      </div>
    </article>
  );
}
