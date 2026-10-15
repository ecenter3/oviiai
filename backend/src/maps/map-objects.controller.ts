import { Controller, Get, Inject, Query } from '@nestjs/common';
import { z } from 'zod';
import { RequireAnyPerm } from '../auth/perm.decorator';
import { ZodPipe } from '../common/zod.pipe';
import { KYSELY, type Database } from '../db/database.module';

const FloorQuery = z.object({ floor: z.string().regex(/^[a-z0-9]{1,8}$/).optional() });

/**
 * 攝影機與充電樁的唯讀清單，給平面圖標示（實時監控、機器人狀態頁）。
 * 介面規格把 /cameras、/chargers 歸在 maps 權限；新增、修改、刪除仍只開放 maps（T-25）。
 * 監控頁的使用者（例如警衛）沒有 maps 權限也要看得到點位，所以讀取放寬為 monitor／robots／maps 任一。
 * 攝影機的 RTSP 帳密不回傳。
 */
@Controller()
@RequireAnyPerm('monitor', 'robots', 'maps')
export class MapObjectsController {
  constructor(@Inject(KYSELY) private readonly db: Database) {}

  @Get('cameras')
  async cameras(@Query(new ZodPipe(FloorQuery)) q: z.infer<typeof FloorQuery>) {
    let query = this.db.selectFrom('cameras').select(['id', 'code', 'name', 'floor_id', 'x', 'y', 'enabled']).orderBy('code');
    if (q.floor) query = query.where('floor_id', '=', q.floor);
    return (await query.execute()).map((c) => ({ id: c.id, code: c.code, name: c.name, floorId: c.floor_id, x: c.x, y: c.y, enabled: c.enabled }));
  }

  @Get('chargers')
  async chargers(@Query(new ZodPipe(FloorQuery)) q: z.infer<typeof FloorQuery>) {
    let query = this.db
      .selectFrom('chargers as c')
      .leftJoin('robots as r', 'r.id', 'c.occupied_by')
      .select(['c.id', 'c.code', 'c.floor_id', 'c.x', 'c.y', 'c.enabled', 'c.occupied_by', 'r.code as occupied_code'])
      .orderBy('c.code');
    if (q.floor) query = query.where('c.floor_id', '=', q.floor);
    return (await query.execute()).map((c) => ({
      id: c.id,
      code: c.code,
      floorId: c.floor_id,
      x: c.x,
      y: c.y,
      enabled: c.enabled,
      occupiedBy: c.occupied_by ? { robotId: c.occupied_by, code: c.occupied_code } : null,
    }));
  }
}
