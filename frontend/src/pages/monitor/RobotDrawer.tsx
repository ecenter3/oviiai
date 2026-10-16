import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { robotTone } from '../../components/FloorMap/geometry';
import { PermGate } from '../../components/PermGate';
import { formatTime, t, type MessageKey } from '../../i18n';
import { ChargeCompleteButton } from '../../components/ChargeCompleteButton';
import type { ChargeStatus } from '../../stores/charging';
import type { RobotLive } from '../../stores/realtime';

export type DrawerCommand = 'estop' | 'estop_release' | 'stop' | 'charge';

/** 點機器人看詳情（系統規格書 §4.1：點機器人看詳情、進入遙控、急停、回充） */
export function RobotDrawer(props: {
  robot: RobotLive;
  floorName: string;
  onClose(): void;
  onCommand(type: DrawerCommand): void;
  busy: boolean;
  charge?: ChargeStatus | null;
}) {
  const { robot: r, onCommand, busy } = props;
  const [confirmRelease, setConfirmRelease] = useState(false);
  const tone = robotTone(r.state, r.online);
  const battClass = r.battery < 20 ? 'low' : r.battery < 40 ? 'mid' : '';
  const estopped = r.state === 'estop';
  const heading = Math.round(((((r.yaw * 180) / Math.PI) % 360) + 360) % 360);

  return (
    <aside className="drawer" role="dialog" aria-label={r.code} onKeyDown={(e) => e.key === 'Escape' && props.onClose()}>
      <div className="drawer-head">
        <h2>{r.code}</h2>
        <button type="button" className="btn" onClick={props.onClose}>
          {t('robot.close')}
        </button>
      </div>
      <div className="drawer-body">
        <dl className="kv">
          <dt>{t('robot.state')}</dt>
          <dd>
            <span className={`state-tag tone-${tone}`}>{t((r.online ? `state.${r.state}` : 'state.offline') as MessageKey)}</span>
          </dd>
          <dt>{t('robot.floor')}</dt>
          <dd>{props.floorName}</dd>
          <dt>{t('robot.battery')}</dt>
          <dd className="batt">
            <span className="bar">
              <i className={battClass} style={{ width: `${Math.max(0, Math.min(100, r.battery))}%` }} />
            </span>
            {r.battery.toFixed(0)}%{r.charging ? ` · ${t('robot.charging')}` : ''}
          </dd>
          <dt>{t('robot.position')}</dt>
          <dd>
            ({r.x.toFixed(2)}, {r.y.toFixed(2)}) m
          </dd>
          <dt>{t('robot.heading')}</dt>
          <dd>{heading}°</dd>
          <dt>{t('robot.speed')}</dt>
          <dd>{r.speed === null ? '—' : `${r.speed.toFixed(2)} m/s`}</dd>
          <dt>{t('robot.signal')}</dt>
          <dd>{r.rssi === null ? '—' : `${r.rssi} dBm`}</dd>
          {props.charge && (
            <>
              <dt>{t('robots.charge')}</dt>
              <dd className={props.charge.kind === 'manual' ? 'warn-text' : ''}>{props.charge.text}</dd>
            </>
          )}
          <dt>{t('robot.task')}</dt>
          <dd>{r.taskId ?? t('robot.none')}</dd>
          <dt>{t('robot.updated')}</dt>
          <dd>{formatTime(r.ts)}</dd>
        </dl>

        {r.faults.length > 0 && (
          <div>
            <div className="muted">{t('robot.faults')}</div>
            <ul className="faults">
              {r.faults.map((f) => (
                <li key={f.code}>
                  L{f.level} {f.code} {f.msg}
                </li>
              ))}
            </ul>
          </div>
        )}

        {props.charge?.kind === 'manual' && (
          <ChargeCompleteButton robotId={r.robotId} code={r.code} className="btn primary" />
        )}

        <div className="acts">
          <PermGate perms={['op.estop']}>
            {estopped ? (
              <button type="button" className="btn wide" disabled={busy} onClick={() => setConfirmRelease(true)}>
                {t('robot.act.estopRelease')}
              </button>
            ) : (
              <button type="button" className="btn danger solid wide" disabled={busy} onClick={() => onCommand('estop')}>
                {t('robot.act.estop')}
              </button>
            )}
          </PermGate>
          <PermGate perms={['op.remote']}>
            <button type="button" className="btn" disabled={busy} onClick={() => onCommand('stop')}>
              {t('robot.act.stop')}
            </button>
            <button type="button" className="btn" disabled={busy || !r.online || estopped} onClick={() => onCommand('charge')}>
              {t('robot.act.charge')}
            </button>
          </PermGate>
          <PermGate perms={['remote', 'op.remote']}>
            <Link className="btn primary wide" to={`/remote/${r.robotId}`}>
              {t('robot.act.remote')}
            </Link>
          </PermGate>
        </div>
      </div>
      {confirmRelease && (
        <ConfirmDialog
          title={t('robot.act.estopRelease')}
          body={t('robot.act.estopReleaseConfirm', { code: r.code })}
          confirmText={t('robot.act.estopRelease')}
          danger
          onCancel={() => setConfirmRelease(false)}
          onConfirm={() => {
            setConfirmRelease(false);
            onCommand('estop_release');
          }}
        />
      )}
    </aside>
  );
}
