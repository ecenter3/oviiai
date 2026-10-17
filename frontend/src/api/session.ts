/**
 * 登入狀態：access token 只放記憶體（不放 localStorage），refresh token 在 httpOnly cookie。
 *
 * 同一時間只能有一個 refresh（後端每次 refresh 都會輪替 refresh token，同時兩個請求會讓其中一個失效）：
 * - 同一分頁：共用進行中的 Promise
 * - 跨分頁：Web Locks API 排隊；先拿到鎖的分頁 refresh 完以 BroadcastChannel 分享新 token，
 *   等待中的分頁拿到鎖時若已收到比自己開始等待還新的 token，就直接用，不再打一次 refresh
 * 登出也廣播，所有分頁一起回登入頁。
 */
import { ApiError, toApiError } from './errors';

const BASE = '/api/v1';
const LOCK_NAME = 'oviiai-auth-refresh';
const CHANNEL_NAME = 'oviiai-auth';

type Msg = { type: 'token'; accessToken: string } | { type: 'logout' };
type Listener = (token: string | null, reason: 'login' | 'refresh' | 'logout' | 'expired') => void;

let accessToken: string | null = null;
let shared: { token: string; at: number } | null = null;
let inflight: Promise<string | null> | null = null;
const listeners = new Set<Listener>();

const channel: BroadcastChannel | null = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL_NAME);
channel?.addEventListener('message', (e: MessageEvent<Msg>) => {
  if (e.data?.type === 'token') {
    shared = { token: e.data.accessToken, at: Date.now() };
    set(e.data.accessToken, 'refresh');
  } else if (e.data?.type === 'logout') {
    set(null, 'logout');
  }
});

function set(token: string | null, reason: Parameters<Listener>[1]) {
  accessToken = token;
  for (const l of listeners) l(token, reason);
}

export function getToken(): string | null {
  return accessToken;
}

export function onSessionChange(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** 解出 JWT 的 exp（毫秒）。只用來判斷快不快過期，驗證由後端負責 */
export function tokenExpiresAt(token: string): number {
  try {
    const p = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: number };
    return (p.exp ?? 0) * 1000;
  } catch {
    return 0;
  }
}

async function callRefresh(startedAt: number): Promise<string | null> {
  // 等鎖期間別的分頁已經 refresh 好了：直接用它的 token
  if (shared && shared.at >= startedAt && tokenExpiresAt(shared.token) > Date.now() + 5_000) {
    set(shared.token, 'refresh');
    return shared.token;
  }
  const r = await fetch(`${BASE}/auth/refresh`, { method: 'POST', credentials: 'same-origin' });
  if (!r.ok) return null;
  const { accessToken: token } = (await r.json()) as { accessToken: string };
  shared = { token, at: Date.now() };
  set(token, 'refresh');
  channel?.postMessage({ type: 'token', accessToken: token } satisfies Msg);
  return token;
}

/** 以 refresh cookie 換新的 access token；失敗（cookie 失效）回 null。同時間只會有一個請求 */
export function refresh(): Promise<string | null> {
  if (inflight) return inflight;
  const startedAt = Date.now();
  const run = () => callRefresh(startedAt);
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  const p: Promise<string | null> = (locks ? (locks.request(LOCK_NAME, run) as unknown as Promise<string | null>) /* 型別定義未攤平 async callback 的 Promise，執行時會攤平 */ : run()).finally(() => {
    inflight = null;
  });
  inflight = p;
  return p;
}

export interface LoginResult {
  accessToken: string;
  user: { id: string; username: string; displayName: string; role: { id: string; name: string } };
  perms: string[];
  mustChangePassword?: boolean;
  idleMinutes?: number;
}

export async function login(username: string, password: string): Promise<LoginResult> {
  const r = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!r.ok) throw await toApiError(r);
  const body = (await r.json()) as LoginResult;
  set(body.accessToken, 'login');
  return body;
}

/**
 * 登出：先 refresh 再登出。
 * 後端 /auth/logout 需要有效的 access token；重新整理頁面後記憶體裡沒有 token、或 token 已過期時，
 * 直接登出會 401 而撤銷不到 refresh token。先 refresh 拿到有效 token，同時讓 cookie 換成最新的那一把再撤銷。
 * 不論後端是否成功，本機都清掉並通知其他分頁。
 */
export async function logout(): Promise<void> {
  try {
    const token = await refresh();
    if (token) {
      await fetch(`${BASE}/auth/logout`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Authorization: `Bearer ${token}` },
      });
    }
  } catch {
    /* 網路錯誤也照樣在本機登出 */
  } finally {
    shared = null;
    set(null, 'logout');
    channel?.postMessage({ type: 'logout' } satisfies Msg);
  }
}

/** refresh 也失敗：登入真的過期了 */
export function expire(): void {
  shared = null;
  set(null, 'expired');
}

export { ApiError };
