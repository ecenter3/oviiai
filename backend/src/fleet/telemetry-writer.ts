import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { KYSELY, type Database } from '../db/database.module';
import type { DB } from '../db/types';
import type { Insertable } from 'kysely';

const FLUSH_MS = 5_000;
/** 資料庫長時間寫不進去時的上限，避免記憶體無限增長（28 台 × 1 Hz × 約 10 分鐘） */
const MAX_BUFFER = 20_000;

type Row = Insertable<DB['telemetry']>;

/** 後端邏輯 §1：每台每秒最多取一筆，每 5 秒批次寫入 telemetry */
@Injectable()
export class TelemetryWriter implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('TelemetryWriter');
  private buffer: Row[] = [];
  private readonly lastSecond = new Map<string, number>();
  private timer?: NodeJS.Timeout;
  private dropped = 0;

  constructor(@Inject(KYSELY) private readonly db: Database) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.flush(), FLUSH_MS);
  }

  async onModuleDestroy() {
    clearInterval(this.timer);
    await this.flush();
  }

  /** 回傳是否收下（同一台同一秒的第二筆以後不收） */
  add(row: Row & { at: Date }): boolean {
    const sec = Math.floor(row.at.getTime() / 1000);
    if (this.lastSecond.get(row.robot_id) === sec) return false;
    this.lastSecond.set(row.robot_id, sec);
    if (this.buffer.length >= MAX_BUFFER) {
      this.buffer.shift();
      this.dropped++;
    }
    this.buffer.push(row);
    return true;
  }

  async flush(): Promise<number> {
    if (!this.buffer.length) return 0;
    const rows = this.buffer;
    this.buffer = [];
    try {
      await this.db.insertInto('telemetry').values(rows).execute();
    } catch (e) {
      // 寫不進去就放回去下次再試（受 MAX_BUFFER 限制）
      this.buffer = rows.concat(this.buffer).slice(-MAX_BUFFER);
      this.log.error(`遙測寫入失敗（${rows.length} 筆待重試）：${e instanceof Error ? e.message : e}`);
      return 0;
    }
    if (this.dropped) {
      this.log.warn(`資料庫寫入延遲期間丟棄了 ${this.dropped} 筆遙測`);
      this.dropped = 0;
    }
    return rows.length;
  }
}
