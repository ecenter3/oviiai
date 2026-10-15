import { Inject, Injectable } from '@nestjs/common';
import { KYSELY, type Database } from '../db/database.module';

export interface OpLogEntry {
  userId: string | null;
  username: string;
  action: string;
  target?: string | null;
  detail?: Record<string, unknown> | null;
  ip?: string | null;
}

/** 寫入 op_logs。@OpLog 裝飾器與查詢、匯出在 T-06 加入。 */
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
        target: e.target ?? null,
        detail: e.detail ? JSON.stringify(e.detail) : null,
        ip: e.ip ?? null,
      })
      .execute();
  }
}
