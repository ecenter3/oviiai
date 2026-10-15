import { Controller, Get, Inject } from '@nestjs/common';
import { Authenticated } from '../auth/perm.decorator';
import { KYSELY, type Database } from '../db/database.module';

/** GET /floors（介面規格：登入即可）。修改、平面圖上傳屬地圖管理（T-25） */
@Controller('floors')
export class FloorsController {
  constructor(@Inject(KYSELY) private readonly db: Database) {}

  @Authenticated()
  @Get()
  async list() {
    const rows = await this.db.selectFrom('floors').selectAll().orderBy('sort').execute();
    return rows.map((f) => ({
      id: f.id,
      name: f.name,
      sort: f.sort,
      planUrl: null as string | null,
      widthM: f.width_m === null ? null : Number(f.width_m),
      heightM: f.height_m === null ? null : Number(f.height_m),
      robotQuota: f.robot_quota,
    }));
  }
}
