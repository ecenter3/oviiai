/**
 * 操作日誌的參數摘要（後端邏輯 §7）。日誌會在操作日誌頁顯示、匯出 CSV、保存期限到時存成備查檔，
 * 所以秘密一律不能寫進來：
 * - 欄位名稱像密碼、金鑰、網址（rtspUrl 等）→ 整個值換成 ***
 * - 任何字串裡的「協定://帳號:密碼@」→ 帳密換成 ***:***（PR #10 審查第 1 點：攝影機 RTSP 帳密曾以明文寫進日誌）
 */
const SECRET_KEY = /pass(word)?|token|secret|key|credential|rtsp|url/i;
/**
 * scheme://user:pass@host → scheme://***:***@host（帳號或密碼任一段都遮）。
 * 貪婪比對到 host 前「最後一個 @」：密碼含沒編碼的 @（rtsp://admin:p@ss@host）也整段遮掉（PR #11 審查第 3 點）。
 */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/]*@/gi;
const MAX_JSON = 2000;

/** 參數摘要：遮蔽秘密；過長只留前段 */
export function summarize(value: unknown): unknown {
  const redacted = redact(value);
  const json = JSON.stringify(redacted);
  if (json === undefined || json.length <= MAX_JSON) return redacted;
  return { truncated: true, preview: json.slice(0, MAX_JSON) };
}

/** 字串裡網址的帳密遮成 ***:*** */
export function redactUrlCredentials(s: string): string {
  return s.replace(URL_CREDENTIALS, '$1***:***@');
}

/** 遮蔽秘密（不截斷）；OpLogService.write 寫入前一律再套一次 */
export function redact(v: unknown): unknown {
  if (typeof v === 'string') return redactUrlCredentials(v);
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET_KEY.test(k) ? '***' : redact(x)]));
  }
  return v;
}

export function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === 'object' && Object.keys(v).length === 0);
}
