import { Inject, Injectable, Logger } from '@nestjs/common';
import { KYSELY, type Database } from '../db/database.module';
import type { RobotInfo } from './types';

const RELOAD_MS = 30_000;
const MISS_RELOAD_MS = 10_000;

/**
 * 機器人代碼 → 資料庫資料。只接受資料庫裡已登記、啟用中的機器人；
 * 不認得的代碼丟棄並警告一次（避免任何人往 MQTT 發訊息就出現在監控畫面）。
 */
@Injectable()
export class RobotRegistry {
  private readonly log = new Logger('RobotRegistry');
  private byCode = new Map<string, RobotInfo>();
  private loadedAt = 0;
  private lastMissReload = 0;
  private readonly warned = new Set<string>();

  constructor(@Inject(KYSELY) private readonly db: Database) {}

  async load(): Promise<void> {
    const rows = await this.db
      .selectFrom('robots')
      .select(['id', 'code', 'floor_id', 'adapter'])
      .where('enabled', '=', true)
      .execute();
    this.byCode = new Map(rows.map((r) => [r.code, { id: r.id, code: r.code, floor: r.floor_id, adapter: r.adapter }]));
    this.loadedAt = Date.now();
  }

  all(): RobotInfo[] {
    return [...this.byCode.values()];
  }

  /** 查不到時最多每 10 秒重讀一次資料庫（剛新增的機器人不必等 30 秒） */
  async resolve(code: string): Promise<RobotInfo | undefined> {
    const now = Date.now();
    if (now - this.loadedAt > RELOAD_MS) await this.load();
    let r = this.byCode.get(code);
    if (!r && now - this.lastMissReload > MISS_RELOAD_MS) {
      this.lastMissReload = now;
      await this.load();
      r = this.byCode.get(code);
    }
    if (!r && !this.warned.has(code)) {
      this.warned.add(code);
      this.log.warn(`未登記或已停用的機器人 ${code}，訊息丟棄`);
    }
    return r;
  }

  get(code: string): RobotInfo | undefined {
    return this.byCode.get(code);
  }
}
