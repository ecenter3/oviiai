const SECRET_KEY = /pass(word)?|token|secret|key|credential/i;
const MAX_JSON = 2000;

/** 參數摘要：遮蔽密碼類欄位；過長只留前段 */
export function summarize(value: unknown): unknown {
  const redacted = redact(value);
  const json = JSON.stringify(redacted);
  if (json === undefined || json.length <= MAX_JSON) return redacted;
  return { truncated: true, preview: json.slice(0, MAX_JSON) };
}

function redact(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET_KEY.test(k) ? '***' : redact(x)]));
  }
  return v;
}

export function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === 'object' && Object.keys(v).length === 0);
}
