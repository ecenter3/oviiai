import { ApiError, toApiError } from './errors';
import { expire, getToken, refresh } from './session';

const BASE = '/api/v1';

/**
 * 呼叫後端 API：自動帶 access token；401 時 refresh 一次再重送（介面規格 §1、前端架構「驗證」），
 * refresh 也失敗就視為登入過期。回傳解析後的 JSON（204 回 undefined）。
 */
export async function api<T = unknown>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const send = (token: string | null) => {
    const headers = new Headers(rest.headers);
    if (token) headers.set('Authorization', `Bearer ${token}`);
    if (json !== undefined) headers.set('Content-Type', 'application/json');
    return fetch(`${BASE}${path}`, {
      ...rest,
      headers,
      credentials: 'same-origin',
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
  };

  let r = await send(getToken());
  if (r.status === 401) {
    const token = await refresh();
    if (!token) {
      expire();
      throw await toApiError(r);
    }
    r = await send(token);
    if (r.status === 401) expire();
  }
  if (!r.ok) throw await toApiError(r);
  if (r.status === 204) return undefined as T;
  return (await r.json()) as T;
}

export { ApiError };
