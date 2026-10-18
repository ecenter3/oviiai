import { Inject, Injectable } from '@nestjs/common';
import { KYSELY, type Database } from '../db/database.module';

const TTL_MS = 10_000;

/**
 * 讀 settings 表，記憶體快取 10 秒。
 * 手冊後端邏輯：設定變更時以 Redis pub/sub 通知刷新——設定頁（T-20）完成時改為主動失效。
 */
@Injectable()
export class SettingsService {
  private cache = new Map<string, unknown>();
  private loadedAt = 0;

  constructor(@Inject(KYSELY) private readonly db: Database) {}

  async getNumber(key: string, fallback: number): Promise<number> {
    const v = Number(await this.get(key));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  }

  async get(key: string): Promise<unknown> {
    if (Date.now() - this.loadedAt > TTL_MS) {
      const rows = await this.db.selectFrom('settings').select(['key', 'value']).execute();
      this.cache = new Map(rows.map((r) => [r.key, r.value]));
      this.loadedAt = Date.now();
    }
    return this.cache.get(key);
  }

  /**
   * 這個人閒置多少分鐘自動登出（0＝不登出）：角色設了「不自動登出」就是 0，否則全站設定（預設 30）。
   * 所有登入者都要知道，由 /me 與登入回傳。
   */
  async idleMinutes(noIdleLogout = false): Promise<number> {
    if (noIdleLogout) return 0;
    const v = Number((await this.get('auth.idleMinutes')) ?? 30);
    return Number.isInteger(v) && v >= 5 ? v : 30;
  }

  invalidate(): void {
    this.loadedAt = 0;
  }
}
