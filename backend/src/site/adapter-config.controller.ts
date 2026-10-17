import { Controller, Get, Headers, Inject, Param, Req } from '@nestjs/common';
import type { Request } from 'express';
import { sql } from 'kysely';
import { timingSafeEqual } from 'node:crypto';
import { Public } from '../auth/public.decorator';
import { AppError } from '../common/errors';
import { adapterAllowedCidrs, adapterKey, dataEncKey } from '../config';
import { KYSELY, type Database } from '../db/database.module';

/**
 * 轉接器設定（機器人接入 §3：一個轉接器程序管理同品牌的多台，設定來自後端 GET /adapter-config/{name}，以轉接器金鑰驗證）。
 * 金鑰放在 .env 的 ADAPTER_KEY_<名稱大寫>，請求帶 X-Adapter-Key。回傳該轉接器底下啟用中的機器人、
 * 連線資料（含解密後的密碼，只給持有金鑰的轉接器）、同樓層同品牌的充電樁、座標校正矩陣。
 * 不走使用者登入（轉接器沒有帳號），所以標 @Public，自己檢查來源網段與金鑰。
 *
 * 來源網段（ADAPTER_ALLOWED_CIDRS）在後端也檢查一次（PR #11 審查第 1 點）：就算 Nginx 設錯、
 * 路徑大小寫繞過 Nginx 的 location（Express 路由不分大小寫），或直連 3000 埠，也拿不到解密後的密碼。
 * 正式環境沒設定就一律拒絕。req.ip 要正確，前面有 Nginx 時 TRUST_PROXY 要設成 Nginx 的位址。
 */
@Controller('adapter-config')
export class AdapterConfigController {
  constructor(@Inject(KYSELY) private readonly db: Database) {}

  @Public()
  @Get(':name')
  async get(@Param('name') name: string, @Headers('x-adapter-key') key: string | undefined, @Req() req: Request) {
    const allowed = adapterAllowedCidrs();
    if (allowed && !allowed.has(req.ip)) throw new AppError('FORBIDDEN', '來源網段不允許取得轉接器設定');
    if (!/^[a-z0-9_-]{1,32}$/.test(name)) throw new AppError('NOT_FOUND', '找不到轉接器');
    const expected = adapterKey(name);
    if (!expected || !key || !safeEqual(key, expected)) throw new AppError('UNAUTHENTICATED', '轉接器金鑰錯誤');

    const robots = await this.db
      .selectFrom('robots as r')
      .leftJoin('robot_map_calib as c', 'c.robot_id', 'r.id')
      .select(['r.id', 'r.code', 'r.brand', 'r.model', 'r.serial_no', 'r.floor_id', 'r.conn', 'r.caps', 'r.modules', 'c.matrix', 'c.robot_map_id'])
      .select(sql<string | null>`CASE WHEN r.conn_secret IS NULL THEN NULL ELSE pgp_sym_decrypt(r.conn_secret, ${dataEncKey()}) END`.as('secret'))
      .where('r.adapter', '=', name)
      .where('r.enabled', '=', true)
      .orderBy('r.code')
      .execute();
    const chargers = await this.db.selectFrom('chargers').select(['id', 'code', 'floor_id', 'brand', 'x', 'y', 'robot_dock']).where('enabled', '=', true).execute();
    return {
      adapter: name,
      robots: robots.map((r) => ({
        code: r.code,
        brand: r.brand,
        model: r.model,
        serialNo: r.serial_no,
        floor: r.floor_id,
        conn: r.conn,
        secret: r.secret,
        caps: r.caps,
        modules: r.modules,
        calib: r.matrix ? { mapId: r.robot_map_id, matrix: r.matrix } : null,
        chargers: chargers
          .filter((c) => c.floor_id === r.floor_id && c.brand === r.brand)
          .map((c) => ({ id: c.id, code: c.code, x: c.x, y: c.y, dock: c.robot_dock })),
      })),
    };
  }
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
