import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { setupStatusQuery } from '../pages/admin/SetupPage';
import { useAuth } from '../stores/auth';

const SEEN = 'oviiai.setup.autoOpened';

/**
 * 系統空白（沒有機器人也沒有攝影機）時，有 settings 權限的人登入後自動開啟設定精靈（前端頁面「新場域設定精靈」）。
 * 每個瀏覽器分頁只自動開一次，關掉精靈去別頁就不再打擾。
 */
export function useSetupAutoOpen() {
  const can = useAuth((s) => s.can);
  const enabled = can('settings');
  const location = useLocation();
  const navigate = useNavigate();
  const status = useQuery({ ...setupStatusQuery, enabled, staleTime: 60_000 });
  useEffect(() => {
    if (!status.data?.blank || location.pathname !== '/') return;
    try {
      if (sessionStorage.getItem(SEEN)) return;
      sessionStorage.setItem(SEEN, '1');
    } catch {
      /* 不能記住也照樣開 */
    }
    navigate('/setup', { replace: true });
  }, [status.data?.blank, location.pathname, navigate]);
}
