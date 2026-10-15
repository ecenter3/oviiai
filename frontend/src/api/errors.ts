/** 後端錯誤格式 `{ error: { code, message, details } }`（介面規格 §1） */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export async function toApiError(r: Response): Promise<ApiError> {
  try {
    const body = (await r.json()) as { error?: { code?: string; message?: string; details?: Record<string, unknown> } };
    if (body.error?.code) return new ApiError(r.status, body.error.code, body.error.message ?? '', body.error.details);
  } catch {
    /* 不是 JSON（例如代理伺服器的錯誤頁） */
  }
  return new ApiError(r.status, r.status >= 500 ? 'INTERNAL' : 'UNKNOWN', `HTTP ${r.status}`);
}
