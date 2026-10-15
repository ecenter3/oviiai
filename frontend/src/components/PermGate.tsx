import type { PermCode } from '@oviiai/contracts';
import type { ReactNode } from 'react';
import { useAuth } from '../stores/auth';

/** 依權限顯示或隱藏子元件（前端隱藏只是方便，後端仍會檢查） */
export function PermGate({ perms, children }: { perms: PermCode[]; children: ReactNode }) {
  const can = useAuth((s) => s.can);
  return can(...perms) ? <>{children}</> : null;
}
