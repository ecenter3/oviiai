import { Injectable, Logger } from '@nestjs/common';
import type { Request } from 'express';
import type { Principal } from '../auth/principal';
import { OpLogService } from './oplog.service';

/** 同一人同一路由多久內只記一筆（前端輪詢或重試時不洗版） */
export const FORBIDDEN_DEDUP_MS = 60_000;
const MAX_KEYS = 10_000;

/**
 * 403（沒有權限）寫進操作日誌 auth.forbidden（安全收尾 b）：有人試圖使用權限外功能時查得到。
 * 同一人（未登入以 IP）同一路由 1 分鐘內只記一筆。已由 @OpLog 記錄失敗的請求不重複記。
 */
@Injectable()
export class ForbiddenAuditService {
  private readonly log = new Logger('ForbiddenAudit');
  private readonly last = new Map<string, number>();

  constructor(private readonly oplog: OpLogService) {}

  async record(req: Request & { user?: Principal; oplogged?: boolean }, details: Record<string, unknown>): Promise<void> {
    if (req.oplogged) return;
    // 路由樣板（/api/v1/robots/:id），同一路由不同 id 算同一筆
    const route = `${req.method} ${(req.baseUrl ?? '') + (typeof req.route?.path === 'string' ? req.route.path : req.path)}`;
    const who = req.user?.sub ?? `ip:${req.ip}`;
    const key = `${who}|${route}`;
    const now = Date.now();
    const prev = this.last.get(key);
    if (prev !== undefined && now - prev < FORBIDDEN_DEDUP_MS) return;
    this.last.set(key, now);
    if (this.last.size > MAX_KEYS) this.prune(now);
    try {
      await this.oplog.write({
        userId: req.user?.sub ?? null,
        username: req.user?.username ?? '(未登入)',
        action: 'auth.forbidden',
        target: route,
        detail: { ok: false, error: 'FORBIDDEN', path: req.originalUrl.split('?')[0], ...details },
        ip: req.ip ?? null,
      });
    } catch (e) {
      this.log.error(`寫入操作日誌失敗：${e instanceof Error ? e.message : e}`);
    }
  }

  private prune(now: number) {
    for (const [k, at] of this.last) if (now - at >= FORBIDDEN_DEDUP_MS) this.last.delete(k);
    // 一分鐘內就有上萬組（異常）：整個清掉，寧可多記
    if (this.last.size > MAX_KEYS) this.last.clear();
  }
}
