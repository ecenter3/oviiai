import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import type { Request } from 'express';
import { sql } from 'kysely';
import { z } from 'zod';
import { RequireAnyPerm, RequirePerm } from '../auth/perm.decorator';
import { AppError } from '../common/errors';
import { ZodPipe } from '../common/zod.pipe';
import { KYSELY, type Database } from '../db/database.module';
import { ACTIVE } from '../dispatch/task-state';
import { OpLog } from '../oplog/oplog.decorator';
import { inFloor, pathLength } from './nav-plan';

const Floor = z.string().regex(/^[a-z0-9]{1,8}$/);
const Num = z.number().finite();
const FloorQuery = z.object({ floor: Floor.optional() });

const PoiBody = z
  .object({
    floorId: Floor,
    name: z.string().trim().min(1).max(32),
    x: Num,
    y: Num,
    yaw: Num.min(-Math.PI * 2).max(Math.PI * 2).nullable().optional(),
    /** parking = 待命點：充電讓位時開往最近的待命點（PR #8 審查第 2 點） */
    kind: z.enum(['poi', 'parking']).default('poi'),
  })
  .strict();

const ZoneBody = z
  .object({
    floorId: Floor,
    name: z.string().trim().min(1).max(32),
    kind: z.enum(['forbidden', 'slow', 'silent']),
    polygon: z.array(z.tuple([Num, Num])).min(3).max(200),
  })
  .strict();

const Waypoint = z
  .object({
    x: Num,
    y: Num,
    yaw: Num.optional(),
    /** 到點停留秒數 */
    dwellSec: z.number().int().min(0).max(3600).optional(),
    /** 到點動作（拍照、喊話等，轉接器依能力執行） */
    action: z.string().max(32).optional(),
  })
  .strict();

const PathBody = z
  .object({
    floorId: Floor,
    name: z.string().trim().min(1).max(32),
    points: z.array(Waypoint).min(2).max(500),
  })
  .strict();

const target = (kind: string) => (req: Request, res?: unknown) =>
  `${kind}:${String(req.params.id ?? (res as { id?: string } | undefined)?.id ?? '')}`;

/**
 * 導航管理後端（T-23）：興趣點（含待命點）、特殊區域、路徑。介面規格 CRUD /pois、/zones、/paths，權限 nav。
 * 讀取放寬：派工與監控頁要選興趣點、畫路徑；GET /pois 在 MapObjectsController。
 * 被任務範本、進行中的任務、巡邏排程或定點檢測點引用的興趣點與路徑不可刪（409）。
 */
@Controller()
export class NavController {
  constructor(@Inject(KYSELY) private readonly db: Database) {}

  // ===== 興趣點 =====

  @Post('pois')
  @RequirePerm('nav')
  @OpLog('poi.create', target('poi'))
  async createPoi(@Body(new ZodPipe(PoiBody)) b: z.infer<typeof PoiBody>) {
    await this.checkPoints(b.floorId, [b]);
    return this.db
      .insertInto('pois')
      .values({ floor_id: b.floorId, name: b.name, x: b.x, y: b.y, yaw: b.yaw ?? null, kind: b.kind })
      .returning(['id', 'name', 'kind'])
      .executeTakeFirstOrThrow();
  }

  @Patch('pois/:id')
  @RequirePerm('nav')
  @OpLog('poi.update', target('poi'))
  async updatePoi(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(PoiBody.partial().strict())) b: Partial<z.infer<typeof PoiBody>>) {
    const cur = await this.db.selectFrom('pois').selectAll().where('id', '=', id).executeTakeFirst();
    if (!cur) throw new AppError('NOT_FOUND', '找不到興趣點');
    if (b.floorId !== undefined && b.floorId !== cur.floor_id && (await this.poiRefs(id)).length) {
      throw new AppError('INVALID_STATE', '興趣點被任務範本、進行中的任務或定點檢測點使用，不能換樓層');
    }
    await this.checkPoints(b.floorId ?? cur.floor_id, [{ x: b.x ?? cur.x, y: b.y ?? cur.y }]);
    return this.db
      .updateTable('pois')
      .set({
        ...(b.floorId !== undefined && { floor_id: b.floorId }),
        ...(b.name !== undefined && { name: b.name }),
        ...(b.x !== undefined && { x: b.x }),
        ...(b.y !== undefined && { y: b.y }),
        ...(b.yaw !== undefined && { yaw: b.yaw }),
        ...(b.kind !== undefined && { kind: b.kind }),
      })
      .where('id', '=', id)
      .returning(['id', 'name', 'kind'])
      .executeTakeFirstOrThrow();
  }

  @Delete('pois/:id')
  @HttpCode(204)
  @RequirePerm('nav')
  @OpLog('poi.delete', target('poi'))
  async deletePoi(@Param('id', ParseUUIDPipe) id: string) {
    const refs = await this.poiRefs(id);
    if (refs.length) throw new AppError('INVALID_STATE', `興趣點使用中：${refs.join('、')}`, { refs });
    const r = await this.db.deleteFrom('pois').where('id', '=', id).executeTakeFirst();
    if (!r.numDeletedRows) throw new AppError('NOT_FOUND', '找不到興趣點');
  }

  // ===== 特殊區域 =====

  @Get('zones')
  @RequireAnyPerm('nav', 'monitor', 'dispatch')
  async zones(@Query(new ZodPipe(FloorQuery)) q: z.infer<typeof FloorQuery>) {
    let query = this.db.selectFrom('zones').selectAll().orderBy('floor_id').orderBy('name');
    if (q.floor) query = query.where('floor_id', '=', q.floor);
    return (await query.execute()).map((z) => ({ id: z.id, floorId: z.floor_id, name: z.name, kind: z.kind, polygon: z.polygon }));
  }

  @Post('zones')
  @RequirePerm('nav')
  @OpLog('zone.create', target('zone'))
  async createZone(@Body(new ZodPipe(ZoneBody)) b: z.infer<typeof ZoneBody>) {
    await this.checkPoints(b.floorId, b.polygon.map(([x, y]) => ({ x, y })));
    return this.db
      .insertInto('zones')
      .values({ floor_id: b.floorId, name: b.name, kind: b.kind, polygon: JSON.stringify(b.polygon) })
      .returning(['id', 'name'])
      .executeTakeFirstOrThrow();
  }

  @Patch('zones/:id')
  @RequirePerm('nav')
  @OpLog('zone.update', target('zone'))
  async updateZone(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ZoneBody.partial().strict())) b: Partial<z.infer<typeof ZoneBody>>) {
    const cur = await this.db.selectFrom('zones').selectAll().where('id', '=', id).executeTakeFirst();
    if (!cur) throw new AppError('NOT_FOUND', '找不到區域');
    await this.checkPoints(b.floorId ?? cur.floor_id, (b.polygon ?? cur.polygon).map(([x, y]) => ({ x, y })));
    return this.db
      .updateTable('zones')
      .set({
        ...(b.floorId !== undefined && { floor_id: b.floorId }),
        ...(b.name !== undefined && { name: b.name }),
        ...(b.kind !== undefined && { kind: b.kind }),
        ...(b.polygon !== undefined && { polygon: JSON.stringify(b.polygon) }),
      })
      .where('id', '=', id)
      .returning(['id', 'name'])
      .executeTakeFirstOrThrow();
  }

  @Delete('zones/:id')
  @HttpCode(204)
  @RequirePerm('nav')
  @OpLog('zone.delete', target('zone'))
  async deleteZone(@Param('id', ParseUUIDPipe) id: string) {
    const r = await this.db.deleteFrom('zones').where('id', '=', id).executeTakeFirst();
    if (!r.numDeletedRows) throw new AppError('NOT_FOUND', '找不到區域');
  }

  // ===== 路徑 =====

  @Get('paths')
  @RequireAnyPerm('nav', 'monitor', 'dispatch')
  async paths(@Query(new ZodPipe(FloorQuery)) q: z.infer<typeof FloorQuery>) {
    let query = this.db
      .selectFrom('paths as p')
      .selectAll('p')
      .select((eb) => eb.selectFrom('patrol_schedules as s').select(eb.fn.countAll<string>().as('n')).whereRef('s.path_id', '=', 'p.id').as('schedules'))
      .orderBy('p.floor_id')
      .orderBy('p.name');
    if (q.floor) query = query.where('p.floor_id', '=', q.floor);
    return (await query.execute()).map((p) => ({
      id: p.id,
      floorId: p.floor_id,
      name: p.name,
      points: p.points,
      lengthM: Number(p.length_m),
      schedules: Number(p.schedules ?? 0),
    }));
  }

  @Post('paths')
  @RequirePerm('nav')
  @OpLog('path.create', target('path'))
  async createPath(@Body(new ZodPipe(PathBody)) b: z.infer<typeof PathBody>) {
    await this.checkPoints(b.floorId, b.points);
    return this.db
      .insertInto('paths')
      .values({ floor_id: b.floorId, name: b.name, points: JSON.stringify(b.points), length_m: String(pathLength(b.points)) })
      .returning(['id', 'name', 'length_m'])
      .executeTakeFirstOrThrow()
      .then((r) => ({ id: r.id, name: r.name, lengthM: Number(r.length_m) }));
  }

  @Patch('paths/:id')
  @RequirePerm('nav')
  @OpLog('path.update', target('path'))
  async updatePath(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(PathBody.partial().strict())) b: Partial<z.infer<typeof PathBody>>) {
    const cur = await this.db.selectFrom('paths').selectAll().where('id', '=', id).executeTakeFirst();
    if (!cur) throw new AppError('NOT_FOUND', '找不到路徑');
    if (b.floorId !== undefined && b.floorId !== cur.floor_id && (await this.pathRefs(id)).length) {
      throw new AppError('INVALID_STATE', '路徑被排程或任務使用，不能換樓層');
    }
    const points = b.points ?? cur.points;
    await this.checkPoints(b.floorId ?? cur.floor_id, points);
    return this.db
      .updateTable('paths')
      .set({
        ...(b.floorId !== undefined && { floor_id: b.floorId }),
        ...(b.name !== undefined && { name: b.name }),
        ...(b.points !== undefined && { points: JSON.stringify(b.points), length_m: String(pathLength(b.points)) }),
      })
      .where('id', '=', id)
      .returning(['id', 'name', 'length_m'])
      .executeTakeFirstOrThrow()
      .then((r) => ({ id: r.id, name: r.name, lengthM: Number(r.length_m) }));
  }

  /** 被巡邏排程、任務範本、進行中任務引用 → 409（後端邏輯 §4） */
  @Delete('paths/:id')
  @HttpCode(204)
  @RequirePerm('nav')
  @OpLog('path.delete', target('path'))
  async deletePath(@Param('id', ParseUUIDPipe) id: string) {
    const refs = await this.pathRefs(id);
    if (refs.length) throw new AppError('INVALID_STATE', `路徑使用中：${refs.join('、')}`, { refs });
    const r = await this.db.deleteFrom('paths').where('id', '=', id).executeTakeFirst();
    if (!r.numDeletedRows) throw new AppError('NOT_FOUND', '找不到路徑');
  }

  // ===== 內部 =====

  private async poiRefs(id: string): Promise<string[]> {
    const tpl = await this.db.selectFrom('task_templates').select('name').where(sql<string>`target->>'poiId'`, '=', id).execute();
    const tasks = await this.db.selectFrom('tasks').select('code').where(sql<string>`target->>'poiId'`, '=', id).where('status', 'in', [...ACTIVE]).execute();
    const point = await this.db.selectFrom('inspection_points').select('id').where('poi_id', '=', id).executeTakeFirst();
    return [...tpl.map((t) => `任務範本「${t.name}」`), ...tasks.map((t) => `任務 ${t.code}`), ...(point ? ['定點檢測點'] : [])];
  }

  private async pathRefs(id: string): Promise<string[]> {
    const sch = await this.db.selectFrom('patrol_schedules').select('name').where('path_id', '=', id).execute();
    const tpl = await this.db.selectFrom('task_templates').select('name').where(sql<string>`target->>'pathId'`, '=', id).execute();
    const tasks = await this.db.selectFrom('tasks').select('code').where(sql<string>`target->>'pathId'`, '=', id).where('status', 'in', [...ACTIVE]).execute();
    return [...sch.map((s) => `巡邏排程「${s.name}」`), ...tpl.map((t) => `任務範本「${t.name}」`), ...tasks.map((t) => `任務 ${t.code}`)];
  }

  private async checkPoints(floorId: string, pts: { x: number; y: number }[]) {
    const f = await this.db.selectFrom('floors').select(['width_m', 'height_m']).where('id', '=', floorId).executeTakeFirst();
    if (!f) throw new AppError('VALIDATION_FAILED', '樓層不存在', { fields: { floorId: '樓層不存在' } });
    const size = { w: f.width_m === null ? null : Number(f.width_m), h: f.height_m === null ? null : Number(f.height_m) };
    if (!inFloor(pts, size)) throw new AppError('VALIDATION_FAILED', '座標超出樓層範圍');
  }
}
