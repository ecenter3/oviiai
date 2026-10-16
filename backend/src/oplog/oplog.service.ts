import { Inject, Injectable } from '@nestjs/common';
import type { Response } from 'express';
import type { SelectQueryBuilder } from 'kysely';
import { CSV_BOM, csvRow, formatTaipei } from '../common/csv';
import type { Paged } from '../common/pagination';
import { KYSELY, type Database } from '../db/database.module';
import type { DB } from '../db/types';
import { redact, redactUrlCredentials } from './summarize';

export interface OpLogEntry {
  userId: string | null;
  username: string;
  action: string;
  target?: string | null;
  detail?: Record<string, unknown> | null;
  ip?: string | null;
}

export interface OpLogFilter {
  /** 帳號（username），帳號刪除後仍可查 */
  user?: string;
  /** 完全相符；結尾 * 為前綴比對，例 robot.* */
  action?: string;
  from?: Date;
  to?: Date;
}

export interface OpLogView {
  id: string;
  at: string;
  userId: string | null;
  username: string;
  action: string;
  target: string | null;
  detail: unknown;
  ip: string | null;
}

const EXPORT_BATCH = 2000;

@Injectable()
export class OpLogService {
  constructor(@Inject(KYSELY) private readonly db: Database) {}

  async write(e: OpLogEntry): Promise<void> {
    await this.db
      .insertInto('op_logs')
      .values({
        user_id: e.userId,
        username: e.username,
        action: e.action,
        target: e.target ? redactUrlCredentials(e.target) : null,
        // 不論從哪裡寫入，網址帳密與密碼類欄位都不進日誌（PR #10 審查第 1 點）
        detail: e.detail ? JSON.stringify(redact(e.detail)) : null,
        ip: e.ip ?? null,
      })
      .execute();
  }

  async list(f: OpLogFilter, page: number, size: number): Promise<Paged<OpLogView>> {
    const base = this.filtered(f);
    const [{ total }, rows] = await Promise.all([
      base.select((eb) => eb.fn.countAll<string>().as('total')).executeTakeFirstOrThrow(),
      base
        .selectAll()
        .orderBy('at', 'desc')
        .orderBy('id', 'desc')
        .limit(size)
        .offset((page - 1) * size)
        .execute(),
    ]);
    return { items: rows.map(view), total: Number(total), page, size };
  }

  /** 依條件匯出 CSV（台北時間）；分批讀取，不一次載入全部 */
  async exportCsv(f: OpLogFilter, res: Response): Promise<void> {
    const stamp = formatTaipei(new Date()).slice(0, 10).replace(/-/g, '');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="oplogs-${stamp}.csv"`);
    res.write(CSV_BOM + csvRow(['時間', '帳號', '動作', '對象', '結果', 'IP', '內容']));

    let cursor: { at: Date; id: string } | undefined;
    for (;;) {
      let q = this.filtered(f).selectAll();
      if (cursor) {
        const c = cursor;
        q = q.where((eb) => eb.or([eb('at', '<', c.at), eb.and([eb('at', '=', c.at), eb('id', '<', c.id)])]));
      }
      const rows = await q.orderBy('at', 'desc').orderBy('id', 'desc').limit(EXPORT_BATCH).execute();
      for (const r of rows) {
        const detail = (r.detail ?? {}) as { ok?: boolean };
        const ok = detail.ok === false ? '失敗' : '成功';
        const line = csvRow([formatTaipei(r.at), r.username, r.action, r.target, ok, r.ip, r.detail]);
        if (!res.write(line)) await new Promise((resolve) => res.once('drain', resolve));
      }
      if (rows.length < EXPORT_BATCH) break;
      const last = rows[rows.length - 1];
      cursor = { at: last.at, id: last.id };
    }
    res.end();
  }

  private filtered(f: OpLogFilter): SelectQueryBuilder<DB, 'op_logs', object> {
    let q = this.db.selectFrom('op_logs');
    if (f.user) q = q.where('username', '=', f.user);
    if (f.action?.endsWith('*')) q = q.where('action', 'like', `${escapeLike(f.action.slice(0, -1))}%`);
    else if (f.action) q = q.where('action', '=', f.action);
    if (f.from) q = q.where('at', '>=', f.from);
    if (f.to) q = q.where('at', '<', f.to);
    return q;
  }
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function view(r: {
  id: string;
  at: Date;
  user_id: string | null;
  username: string;
  action: string;
  target: string | null;
  detail: unknown;
  ip: string | null;
}): OpLogView {
  return {
    id: String(r.id),
    at: r.at.toISOString(),
    userId: r.user_id,
    username: r.username,
    action: r.action,
    target: r.target,
    detail: r.detail,
    ip: r.ip,
  };
}
