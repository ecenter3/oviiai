import { ApiError, toApiError } from './errors';
import { expire, getToken, refresh } from './session';

const BASE = '/api/v1';

/**
 * 呼叫後端 API：自動帶 access token；401 時 refresh 一次再重送（介面規格 §1、前端架構「驗證」），
 * refresh 也失敗就視為登入過期。回傳解析後的 JSON（204 回 undefined）。
 */
export async function api<T = unknown>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const r = await request(path, init);
  if (r.status === 204) return undefined as T;
  return (await r.json()) as T;
}

/** 下載檔案（例：告警匯出 CSV）：帶 access token 取回內容後，以瀏覽器下載 */
export async function download(path: string, filename: string): Promise<void> {
  const r = await request(path);
  const url = URL.createObjectURL(await r.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/**
 * 需要登入才能讀的圖片（例：平面圖 /api/v1/floors/:id/plan）：帶 token 取回，轉成 blob: 網址給 <img>／<image> 用。
 * 同一網址只取一次（網址帶版本，內容不變）。
 */
const blobs = new Map<string, Promise<string>>();
export function authedObjectUrl(url: string): Promise<string> {
  let p = blobs.get(url);
  if (!p) {
    p = request(url.replace(/^\/api\/v1/, '')).then(async (r) => URL.createObjectURL(await r.blob()));
    p.catch(() => blobs.delete(url));
    blobs.set(url, p);
  }
  return p;
}

async function request(path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
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
  if (!r.ok) {
    const e = await toApiError(r);
    if (e.code === 'PASSWORD_CHANGE_REQUIRED') pwdRequired();
    throw e;
  }
  return r;
}

/** 管理員重設了密碼（後端回 PASSWORD_CHANGE_REQUIRED）：通知 auth store 顯示強制改密碼 */
let pwdRequired = () => {};
export function onPasswordChangeRequired(fn: () => void) {
  pwdRequired = fn;
}

export { ApiError };
