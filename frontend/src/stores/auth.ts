import type { PermCode } from '@oviiai/contracts';
import { create } from 'zustand';
import { api } from '../api/client';
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
  /** 被動登出（過期）時登入頁顯示提示 */
  expired: boolean;
  init(): Promise<void>;
  login(username: string, password: string): Promise<void>;
  logout(): Promise<void>;
  can(...codes: PermCode[]): boolean;
}

async function loadMe() {
  return api<{ user: Me; perms: string[] }>('/me');
}

export const useAuth = create<AuthState>((set, get) => ({
  status: 'loading',
  user: null,
  perms: [],
  expired: false,

  /** 開啟頁面：access token 只在記憶體，先用 refresh cookie 換一個，再讀 /me */
  async init() {
    const token = await session.refresh().catch(() => null);
    if (!token) return set({ status: 'anon', user: null, perms: [] });
    try {
      const me = await loadMe();
      set({ status: 'authed', user: me.user, perms: me.perms, expired: false });
    } catch {
      set({ status: 'anon', user: null, perms: [] });
    }
  },

  async login(username, password) {
    const r = await session.login(username, password);
    set({ status: 'authed', user: r.user, perms: r.perms, expired: false });
  },

  async logout() {
    await session.logout();
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
    useAuth.setState({ status: 'anon', user: null, perms: [], expired: reason === 'expired' });
  } else if (token && reason === 'refresh' && s.status === 'anon') {
    void loadMe()
      .then((me) => useAuth.setState({ status: 'authed', user: me.user, perms: me.perms, expired: false }))
      .catch(() => {});
  }
});
