import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { RequirePerm } from '../auth/perm.decorator';
import { AppError } from '../common/errors';
import { ZodPipe } from '../common/zod.pipe';
import { KYSELY, type Database } from '../db/database.module';
import { FleetService } from '../fleet/fleet.service';
import { OpLog } from '../oplog/oplog.decorator';
import { apply, CalibError, type CalibPoint, fitAffine, invert, MAX_RMSE_M, MIN_POINTS } from './affine';

const Num = z.number().finite();
const Point = z.object({ u: Num, v: Num, x: Num.min(0), y: Num.min(0) }).strict();
const FitBody = z.object({ points: z.array(Point).min(1).max(50) }).strict();
const SaveBody = z
  .object({
    /** 機器人端的地圖名稱（建圖時命名） */
    mapId: z.string().trim().min(1).max(64),
    points: z.array(Point).min(MIN_POINTS).max(50),
    /** 同樓層同品牌、共用同一張地圖的機器人一起套用 */
    applyTo: z.array(z.string().uuid()).max(50).default([]),
  })
  .strict();
const FloorQuery = z.object({ floor: z.string().regex(/^[a-z0-9]{1,8}$/) });

const target = (req: Request) => `robot:${String(req.params.id)}`;

/**
 * 座標校正（工程開發手冊「機器人接入」§6、介面規格 GET/PUT /robots/:id/calibration，權限 maps；T-26）。
 *
 * 現場在 3 個以上分散位置記錄「機器人地圖座標 (u,v)」與「平面圖上的位置 (x,y)」，以最小平方求仿射轉換。
 * RMSE 超過 0.5 m 不能儲存；同樓層同品牌共用一張地圖時可一次套用到同組機器人。
 * 儲存後轉接器從 GET /adapter-config/{name} 取得（calib.matrix，機器人 → 平台），反向用反矩陣。
 */
@Controller()
export class CalibrationController {
  constructor(
    @Inject(KYSELY) private readonly db: Database,
    private readonly fleet: FleetService,
  ) {}

  /** 樓層的機器人與校正狀態（地圖管理頁的校正清單） */
  @Get('calibrations')
  @RequirePerm('maps')
  async list(@Query(new ZodPipe(FloorQuery)) q: z.infer<typeof FloorQuery>) {
    const rows = await this.db
      .selectFrom('robots as r')
      .leftJoin('robot_map_calib as c', 'c.robot_id', 'r.id')
      .select(['r.id', 'r.code', 'r.brand', 'r.model', 'r.floor_id', 'c.robot_map_id', 'c.rmse_m', 'c.updated_at', 'c.points'])
      .where('r.floor_id', '=', q.floor)
      .where('r.enabled', '=', true)
      .orderBy('r.code')
      .execute();
    return rows.map((r) => ({
      robotId: r.id,
      code: r.code,
      brand: r.brand,
      model: r.model,
      floorId: r.floor_id,
      online: !!this.fleet.get(r.code)?.online,
      calib: r.robot_map_id
        ? { mapId: r.robot_map_id, rmseM: Number(r.rmse_m), points: (r.points as unknown[]).length, updatedAt: r.updated_at!.toISOString() }
        : null,
    }));
  }

  /**
   * 校正資料＋機器人目前位置。live.u/v 是「機器人地圖座標」：轉接器回報的是套用目前校正後的平台座標，
   * 以反矩陣換回（還沒校正時轉接器沒有轉換，兩者相同）。校正精靈的「帶入目前位置」用它。
   */
  @Get('robots/:id/calibration')
  @RequirePerm('maps')
  async get(@Param('id', ParseUUIDPipe) id: string) {
    const robot = await this.robot(id);
    const c = await this.db.selectFrom('robot_map_calib').selectAll().where('robot_id', '=', id).executeTakeFirst();
    const live = this.fleet.get(robot.code);
    let uv: { u: number; v: number } | null = null;
    if (live) {
      const raw = c ? apply(invert(c.matrix), live.x, live.y) : { x: live.x, y: live.y };
      uv = { u: round3(raw.x), v: round3(raw.y) };
    }
    return {
      robot: { id: robot.id, code: robot.code, brand: robot.brand, floorId: robot.floor_id },
      calib: c
        ? { mapId: c.robot_map_id, matrix: c.matrix, points: c.points as CalibPoint[], rmseM: Number(c.rmse_m), updatedAt: c.updated_at.toISOString() }
        : null,
      live: live ? { online: live.online, x: live.x, y: live.y, yaw: live.yaw, ...uv! } : null,
      maxRmseM: MAX_RMSE_M,
    };
  }

  /** 試算（不儲存）：精靈每加一點就算一次 RMSE 與每點誤差 */
  @Post('robots/:id/calibration/fit')
  @HttpCode(200)
  @RequirePerm('maps')
  async fit(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(FitBody)) b: z.infer<typeof FitBody>) {
    await this.robot(id);
    if (b.points.length < MIN_POINTS) return { ok: false, reason: `至少要 ${MIN_POINTS} 組對應點`, maxRmseM: MAX_RMSE_M };
    try {
      const r = fitAffine(b.points);
      return { ok: r.rmseM <= MAX_RMSE_M, ...r, maxRmseM: MAX_RMSE_M };
    } catch (e) {
      if (e instanceof CalibError) return { ok: false, reason: e.message, maxRmseM: MAX_RMSE_M };
      throw e;
    }
  }

  /** 儲存（RMSE ≤ 0.5 m）；applyTo 的機器人必須同樓層、同品牌 */
  @Put('robots/:id/calibration')
  @RequirePerm('maps')
  @OpLog('calibration.save', target)
  async save(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(SaveBody)) b: z.infer<typeof SaveBody>) {
    const robot = await this.robot(id);
    let r;
    try {
      r = fitAffine(b.points);
    } catch (e) {
      if (e instanceof CalibError) throw new AppError('VALIDATION_FAILED', e.message, { fields: { points: e.message } });
      throw e;
    }
    if (r.rmseM > MAX_RMSE_M) {
      throw new AppError('VALIDATION_FAILED', `誤差 ${r.rmseM} m 超過 ${MAX_RMSE_M} m，不能儲存。請檢查誤差大的點或重新量測`, {
        rmseM: r.rmseM,
        residuals: r.residuals,
      });
    }
    const f = await this.db.selectFrom('floors').select(['width_m', 'height_m']).where('id', '=', robot.floor_id).executeTakeFirst();
    const w = f?.width_m ? Number(f.width_m) : Infinity;
    const h = f?.height_m ? Number(f.height_m) : Infinity;
    if (b.points.some((p) => p.x > w || p.y > h)) throw new AppError('VALIDATION_FAILED', '平面圖上的點超出樓層範圍');

    const others = [...new Set(b.applyTo.filter((x) => x !== id))];
    if (others.length) {
      const group = await this.db.selectFrom('robots').select(['id', 'code', 'floor_id', 'brand', 'enabled']).where('id', 'in', others).execute();
      const bad = others.filter((x) => {
        const g = group.find((y) => y.id === x);
        return !g || !g.enabled || g.floor_id !== robot.floor_id || g.brand !== robot.brand;
      });
      if (bad.length) throw new AppError('VALIDATION_FAILED', '只能套用到同樓層、同品牌、啟用中的機器人', { fields: { applyTo: '不在同一組' } });
    }
    const values = (robotId: string) => ({
      robot_id: robotId,
      robot_map_id: b.mapId,
      matrix: r.matrix,
      points: JSON.stringify(b.points),
      rmse_m: String(r.rmseM),
    });
    await this.db.transaction().execute(async (trx) => {
      for (const rid of [id, ...others]) {
        await trx
          .insertInto('robot_map_calib')
          .values(values(rid))
          .onConflict((oc) =>
            oc.column('robot_id').doUpdateSet({ robot_map_id: b.mapId, matrix: r.matrix, points: JSON.stringify(b.points), rmse_m: String(r.rmseM), updated_at: new Date() }),
          )
          .execute();
      }
    });
    return { ...r, mapId: b.mapId, applied: [id, ...others] };
  }

  /** 清除校正（轉接器改回不轉換） */
  @Delete('robots/:id/calibration')
  @HttpCode(204)
  @RequirePerm('maps')
  @OpLog('calibration.delete', target)
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.robot(id);
    await this.db.deleteFrom('robot_map_calib').where('robot_id', '=', id).execute();
  }

  private async robot(id: string) {
    const r = await this.db.selectFrom('robots').select(['id', 'code', 'brand', 'floor_id']).where('id', '=', id).where('enabled', '=', true).executeTakeFirst();
    if (!r) throw new AppError('NOT_FOUND', '找不到機器人或已停用');
    return r;
  }
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;
