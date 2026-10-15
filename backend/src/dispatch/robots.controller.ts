import { Controller, Get, Inject, Query } from '@nestjs/common';
import { z } from 'zod';
import { RequirePerm } from '../auth/perm.decorator';
import { ZodPipe } from '../common/zod.pipe';
import { TeleopLock } from '../commands/teleop-lock.service';
import { KYSELY, type Database } from '../db/database.module';
import { FleetService } from '../fleet/fleet.service';
import { ACTIVE } from './task-state';

const RobotQuery = z.object({
  floor: z.string().regex(/^[a-z0-9]{1,8}$/).optional(),
  brand: z.string().max(32).optional(),
  state: z.string().max(32).optional(),
});

/**
 * GET /robots（介面規格：robots 權限）：登記的機器人＋即時狀態（Redis／記憶體）＋遙控鎖＋目前任務。
 * 品牌只是資料欄位（篩選、顯示），不影響任何行為。新增修改停用是機器人管理（T-25）。
 */
@Controller('robots')
export class RobotsController {
  constructor(
    @Inject(KYSELY) private readonly db: Database,
    private readonly fleet: FleetService,
    private readonly lock: TeleopLock,
  ) {}

  @Get()
  @RequirePerm('robots')
  async list(@Query(new ZodPipe(RobotQuery)) q: z.infer<typeof RobotQuery>) {
    let query = this.db
      .selectFrom('robots')
      .select(['id', 'code', 'brand', 'model', 'floor_id', 'caps'])
      .where('enabled', '=', true)
      .orderBy('floor_id')
      .orderBy('code');
    if (q.floor) query = query.where('floor_id', '=', q.floor);
    if (q.brand) query = query.where('brand', '=', q.brand);
    const rows = await query.execute();
    const tasks = await this.db
      .selectFrom('tasks')
      .select(['id', 'code', 'status', 'robot_id', 'priority'])
      .where('status', 'in', ACTIVE.filter((s) => s !== 'pending_approval' && s !== 'queued'))
      .where('robot_id', 'in', rows.length ? rows.map((r) => r.id) : ['00000000-0000-0000-0000-000000000000'])
      .execute();

    const out = [];
    for (const r of rows) {
      const live = this.fleet.get(r.code) ?? null;
      if (q.state && (live?.online ? live.state : 'offline') !== q.state) continue;
      const holder = await this.lock.holder(r.code);
      const t = tasks.find((x) => x.robot_id === r.id);
      out.push({
        id: r.id,
        code: r.code,
        brand: r.brand,
        model: r.model,
        floorId: r.floor_id,
        caps: r.caps,
        live,
        teleop: holder ? { userId: holder.userId, username: holder.username } : null,
        task: t ? { id: t.id, code: t.code, status: t.status, priority: t.priority } : null,
      });
    }
    return out;
  }
}
