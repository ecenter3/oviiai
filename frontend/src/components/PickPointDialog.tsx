import { useState } from 'react';
import { t } from '../i18n';
import { FloorMap } from './FloorMap/FloorMap';
import type { Pt } from './FloorMap/geometry';

/** 在平面圖上點選座標（FloorMap pickMode） */
export function PickPointDialog(props: {
  floor: { id: string; name: string; widthM: number | null; heightM: number | null; planUrl: string | null };
  onPick(p: Pt): void;
  onClose(): void;
}) {
  const [p, setP] = useState<Pt | null>(null);
  return (
    <div className="modal-bg" onKeyDown={(e) => e.key === 'Escape' && props.onClose()}>
      <div className="modal wide-modal" role="dialog" aria-modal="true" aria-label={t('pick.title')}>
        <h2>
          {t('pick.title')} · {props.floor.name}
        </h2>
        <p className="muted">{t('pick.hint')}</p>
        <div className="pick-stage">
          <FloorMap
            viewKey={props.floor.id}
            widthM={props.floor.widthM}
            heightM={props.floor.heightM}
            planUrl={props.floor.planUrl}
            pickMode
            onPick={setP}
            alarms={p ? [{ id: 'pick', x: p.x, y: p.y }] : []}
          />
        </div>
        <div className="row">
          <span className="mono muted push-left">{p ? `(${p.x}, ${p.y})` : ''}</span>
          <button type="button" className="btn" onClick={props.onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn primary" disabled={!p} onClick={() => p && props.onPick(p)}>
            {t('pick.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
