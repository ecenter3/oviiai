import { useState } from 'react';
import { api, ApiError } from '../api/client';
import { t } from '../i18n';
import { useAuth } from '../stores/auth';
import { useToast } from '../stores/toast';

/** 人工充電模式：人員充好電或換好電池後按（op.config 或 op.remote 任一） */
export function ChargeCompleteButton({ robotId, code, className = 'mini yes' }: { robotId: string; code: string; className?: string }) {
  const perms = useAuth((s) => s.perms);
  const [busy, setBusy] = useState(false);
  if (!perms.includes('op.config') && !perms.includes('op.remote')) return null;
  async function done() {
    setBusy(true);
    try {
      await api(`/robots/${robotId}/charge-complete`, { method: 'POST' });
      useToast.getState().show(t('charge.completed', { code }), 'ok');
    } catch (e) {
      useToast.getState().show(e instanceof ApiError ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  }
  return (
    <button type="button" className={className} disabled={busy} onClick={() => void done()}>
      {t('charge.complete')}
    </button>
  );
}
