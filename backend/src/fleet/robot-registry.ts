import { Inject, Injectable, Logger } from '@nestjs/common';
import { Subject } from 'rxjs';
import { KYSELY, type Database } from '../db/database.module';
import { WarnOnce } from '../common/warn-once';
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
  private byId = new Map<string, RobotInfo>();
  private loadedAt = 0;
  private lastMissReload = 0;
  private readonly warn = new WarnOnce(this.log);

  /** 重新載入後不在清單裡的機器人（被停用或刪除），fleet 據此清掉即時狀態（PR #3 審查第 1 點） */
  readonly removed$ = new Subject<RobotInfo>();
  /**
   * 機器人離開某個轉接器（改派到別的轉接器、停用、刪除）：舊轉接器的 MQTT 連線權限還含這台，
   * AdapterRevoker 據此踢掉舊轉接器，讓它用新憑證重連（PR #16 審查第 2 點）
   */
  readonly leftAdapter$ = new Subject<{ robot: RobotInfo; adapter: string }>();

  constructor(@Inject(KYSELY) private readonly db: Database) {}

  async load(): Promise<void> {
    const rows = await this.db
      .selectFrom('robots')
      .select(['id', 'code', 'floor_id', 'adapter', 'caps', 'brand'])
      .where('enabled', '=', true)
      .execute();
    const next = new Map<string, RobotInfo>(
      rows.map((r) => [r.code, { id: r.id, code: r.code, floor: r.floor_id, adapter: r.adapter, caps: r.caps, brand: r.brand }]),
    );
    const gone = [...this.byCode.values()].filter((r) => !next.has(r.code));
    const moved = [...this.byCode.values()].filter((r) => next.has(r.code) && next.get(r.code)!.adapter !== r.adapter);
    this.byCode = next;
    this.byId = new Map([...next.values()].map((r) => [r.id, r]));
    this.loadedAt = Date.now();
    for (const r of gone) this.removed$.next(r);
    for (const r of [...gone, ...moved]) this.leftAdapter$.next({ robot: r, adapter: r.adapter });
  }

  all(): RobotInfo[] {
    return [...this.byCode.values()];
  }

  /** 查不到時最多每 10 秒重讀一次資料庫（剛新增的機器人不必等 30 秒） */
  async resolve(code: string): Promise<RobotInfo | undefined> {
    await this.refreshIfStale();
    let r = this.byCode.get(code);
    if (!r && Date.now() - this.lastMissReload > MISS_RELOAD_MS) {
      this.lastMissReload = Date.now();
      await this.load();
      r = this.byCode.get(code);
    }
    if (!r) this.warn.warn(code, `未登記或已停用的機器人 ${code}，訊息丟棄`);
    return r;
  }

  async resolveId(id: string): Promise<RobotInfo | undefined> {
    await this.refreshIfStale();
    return this.byId.get(id);
  }

  get(code: string): RobotInfo | undefined {
    return this.byCode.get(code);
  }

  /** 定期重讀，也讓停用的機器人在 30 秒內從畫面消失 */
  async refreshIfStale(): Promise<void> {
    if (Date.now() - this.loadedAt > RELOAD_MS) await this.load();
  }
}
