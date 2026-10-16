import { Body, Controller, Get, Inject, Param, Put } from '@nestjs/common';
import { z } from 'zod';
import { RequirePerm } from '../auth/perm.decorator';
import { AppError } from '../common/errors';
import { ZodPipe } from '../common/zod.pipe';
import { OpLog } from '../oplog/oplog.decorator';
import { Authenticated } from '../auth/perm.decorator';
import { KYSELY, type Database } from '../db/database.module';

const FloorBody = z
  .object({
    name: z.string().trim().min(1).max(32),
    robotQuota: z.number().int().min(0).max(100),
    widthM: z.number().positive().max(10_000).nullable(),
    heightM: z.number().positive().max(10_000).nullable(),
  })
  .partial()
  .strict();

/** GET /floors（介面規格：登入即可）；PUT /floors/:id（maps）。平面圖上傳屬地圖管理（T-25） */
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

  @Put(':id')
  @RequirePerm('maps')
  @OpLog('floor.update', (req) => `floor:${req.params.id}`)
  async update(@Param('id') id: string, @Body(new ZodPipe(FloorBody)) b: z.infer<typeof FloorBody>) {
    const r = await this.db
      .updateTable('floors')
      .set({
        ...(b.name !== undefined && { name: b.name }),
        ...(b.robotQuota !== undefined && { robot_quota: b.robotQuota }),
        ...(b.widthM !== undefined && { width_m: b.widthM === null ? null : String(b.widthM) }),
        ...(b.heightM !== undefined && { height_m: b.heightM === null ? null : String(b.heightM) }),
      })
      .where('id', '=', id)
      .executeTakeFirst();
    if (!r.numUpdatedRows) throw new AppError('NOT_FOUND', '找不到樓層');
    return { ok: true };
  }
}
