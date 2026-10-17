import type { PermCode } from '@oviiai/contracts';
import { create } from 'zustand';
import { api, onPasswordChangeRequired } from '../api/client';
import { markActive } from '../api/activity';
import * as session from '../api/session';

export interface Me {
  id: string;
  username: string;
  displayName: string;
  role: { id: string; name: string };
}

interface AuthState {
  status: 'loading' | 'authed' | 'anon';
  user: Me | null;
  perms: string[];
  /** 管理員建立帳號或重設密碼後：改密碼前只能改密碼或登出 */
  mustChangePassword: boolean;
  /** 閒置多少分鐘自動登出（0＝不登出；規則頁設定） */
  idleMinutes: number;
  /** 因閒置被登出：登入頁顯示提示（分鐘數） */
  idleOut: number | null;
  /** 被動登出（過期）時登入頁顯示提示 */
  expired: boolean;
  init(): Promise<void>;
  login(username: string, password: string): Promise<void>;
  logout(): Promise<void>;
  passwordChanged(): void;
  idleLogout(): Promise<void>;
  can(...codes: PermCode[]): boolean;
}

async function loadMe() {
  return api<{ user: Me; perms: string[]; mustChangePassword?: boolean; idleMinutes?: number }>('/me');
}

function fromMe(m: { user: Me; perms: string[]; mustChangePassword?: boolean; idleMinutes?: number }) {
  return { user: m.user, perms: m.perms, mustChangePassword: !!m.mustChangePassword, idleMinutes: m.idleMinutes ?? 0 };
}

export const useAuth = create<AuthState>((set, get) => ({
  status: 'loading',
  user: null,
  perms: [],
  mustChangePassword: false,
  idleMinutes: 0,
  idleOut: null,
  expired: false,

  /** 開啟頁面：access token 只在記憶體，先用 refresh cookie 換一個，再讀 /me */
  async init() {
    const token = await session.refresh().catch(() => null);
    if (!token) return set({ status: 'anon', user: null, perms: [] });
    try {
      const me = await loadMe();
      set({ status: 'authed', ...fromMe(me), expired: false, idleOut: null });
    } catch {
      set({ status: 'anon', user: null, perms: [] });
    }
  },

  async login(username, password) {
    const r = await session.login(username, password);
    markActive();
    set({ status: 'authed', ...fromMe(r), expired: false, idleOut: null });
  },

  async logout() {
    await session.logout();
  },

  passwordChanged() {
    set({ mustChangePassword: false });
  },

  async idleLogout() {
    const n = get().idleMinutes;
    await session.logout();
    set({ idleOut: n });
  },

  can(...codes) {
    const perms = get().perms;
    return codes.every((c) => perms.includes(c));
  },
}));

// 其他分頁登出、或 refresh 失敗 → 回登入頁；其他分頁登入 → 這裡也自動登入
session.onSessionChange((token, reason) => {
  const s = useAuth.getState();
  if (!token && s.status !== 'anon') {
    useAuth.setState({ status: 'anon', user: null, perms: [], mustChangePassword: false, expired: reason === 'expired' });
  } else if (token && reason === 'refresh' && s.status === 'anon') {
    void loadMe()
      .then((me) => useAuth.setState({ status: 'authed', ...fromMe(me), expired: false, idleOut: null }))
      .catch(() => {});
  }
});

onPasswordChangeRequired(() => {
  if (useAuth.getState().status === 'authed') useAuth.setState({ mustChangePassword: true });
});
