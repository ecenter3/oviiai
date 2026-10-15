import { useEffect, useRef } from 'react';
import { t } from '../i18n';

/** 破壞性操作前確認（前端驗收共同條件：急停解除、刪除、駁回先確認） */
export function ConfirmDialog(props: { title: string; body: string; confirmText: string; danger?: boolean; onConfirm(): void; onCancel(): void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => cancel.current?.focus(), []);
  return (
    <div className="modal-bg" onKeyDown={(e) => e.key === 'Escape' && props.onCancel()}>
      <div className="modal" role="alertdialog" aria-modal="true" aria-label={props.title}>
        <h2>{props.title}</h2>
        <p>{props.body}</p>
        <div className="row">
          <button ref={cancel} type="button" className="btn" onClick={props.onCancel}>
            {t('common.cancel')}
          </button>
          <button type="button" className={`btn ${props.danger ? 'danger solid' : 'primary'}`} onClick={props.onConfirm}>
            {props.confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
