import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequireAnyPerm, RequirePerm } from '../auth/perm.decorator';
import type { Principal } from '../auth/principal';
import { AppError } from '../common/errors';
import { PageQuery } from '../common/pagination';
import { ZodPipe } from '../common/zod.pipe';
import { OpLog } from '../oplog/oplog.decorator';
import { EnvService } from './env.service';

const MAX_SPAN_MS = 31 * 86_400_000;
const floorId = z.string().regex(/^[a-z0-9]{1,8}$/);
const iso = z.string().datetime({ offset: true }).transform((s) => new Date(s));
const Range = z
  .object({ from: iso, to: iso })
  .refine((r) => r.from < r.to, { message: '開始時間要早於結束時間', path: ['from'] })
  .refine((r) => r.to.getTime() - r.from.getTime() <= MAX_SPAN_MS, { message: '最多查 31 天', path: ['to'] });
const SummaryQuery = z.object({ floorId, from: iso, to: iso });
const MapQuery = SummaryQuery.extend({ kind: z.string().regex(/^[a-z0-9_]{1,32}$/), cell: z.coerce.number().min(1).max(20).default(4) });
const limit = z.number().finite().nullable();
const ThresholdsBody = z
  .array(z.object({ kind: z.string().regex(/^[a-z0-9_]{1,32}$/), min: limit, max: limit, alarmType: z.string().max(64).nullable() }).strict())
  .min(1)
  .max(50);
const Freq = z.enum(['pass', '1h', '4h']);
const PointBody = z.object({ poiId: z.string().uuid(), freq: Freq.default('pass'), radiusM: z.number().gt(0).max(10).optional() }).strict();
const PointPatch = z.object({ freq: Freq.optional(), radiusM: z.number().gt(0).max(10).optional(), enabled: z.boolean().optional() }).strict();
const MeasureBody = z.object({ robotId: z.string().uuid().nullable().optional() }).strict();
const ReadingsQuery = PageQuery.extend({ from: iso, to: iso });

const checkRange = (r: { from: Date; to: Date }) => {
  const p = Range.safeParse({ from: r.from.toISOString(), to: r.to.toISOString() });
  if (!p.success) throw new AppError('VALIDATION_FAILED', p.error.issues[0].message, { fields: { [String(p.error.issues[0].path[0])]: p.error.issues[0].message } });
};
const pointTarget = (req: Request, res?: unknown) => `inspection_point:${req.params.id ?? (res as { id?: string } | undefined)?.id ?? ''}`;

/**
 * 環境監測（/env，權限 env）、定點檢測（/points，權限 points）；第二期 T-41。
 * 閾值在環境監測頁與告警設置頁都可改（權限 alarmset）。
 */
@Controller('env')
export class EnvController {
  constructor(private readonly env: EnvService) {}

  @Get('thresholds')
  @RequireAnyPerm('env', 'points', 'alarmset')
  thresholds() {
    return this.env.listThresholds();
  }

  @Put('thresholds')
  @RequirePerm('alarmset')
  @OpLog('env.thresholds', () => 'env-thresholds')
  updateThresholds(@Body(new ZodPipe(ThresholdsBody)) b: z.infer<typeof ThresholdsBody>, @CurrentUser() user: Principal) {
    return this.env.updateThresholds(b, user.sub);
  }

  @Get('summary')
  @RequirePerm('env')
  summary(@Query(new ZodPipe(SummaryQuery)) q: z.infer<typeof SummaryQuery>) {
    checkRange(q);
    return this.env.summary(q);
  }

  /** 平面圖上的量測位置（依格子彙總） */
  @Get('map')
  @RequireAnyPerm('env', 'points')
  map(@Query(new ZodPipe(MapQuery)) q: z.infer<typeof MapQuery>) {
    checkRange(q);
    return this.env.map(q);
  }

  @Get('points')
  @RequirePerm('points')
  points(@Query(new ZodPipe(z.object({ floorId: floorId.optional() }))) q: { floorId?: string }) {
    return this.env.listPoints(q.floorId);
  }

  @Post('points')
  @RequirePerm('points')
  @OpLog('env.point_create', pointTarget)
  createPoint(@Body(new ZodPipe(PointBody)) b: z.infer<typeof PointBody>, @CurrentUser() user: Principal) {
    return this.env.createPoint(b, user.sub);
  }

  @Patch('points/:id')
  @RequirePerm('points')
  @OpLog('env.point_update', pointTarget)
  updatePoint(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(PointPatch)) b: z.infer<typeof PointPatch>) {
    return this.env.updatePoint(id, b);
  }

  @Delete('points/:id')
  @HttpCode(204)
  @RequirePerm('points')
  @OpLog('env.point_delete', pointTarget)
  async removePoint(@Param('id', ParseUUIDPipe) id: string) {
    await this.env.removePoint(id);
  }

  /** 立即檢測：派任務到檢測點 */
  @Post('points/:id/measure')
  @RequirePerm('points', 'op.dispatch')
  @OpLog('env.point_measure', pointTarget)
  measure(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(MeasureBody)) b: z.infer<typeof MeasureBody>, @CurrentUser() user: Principal) {
    return this.env.measure(id, b, { id: user.sub, username: user.username });
  }

  @Get('points/:id/readings')
  @RequirePerm('points')
  readings(@Param('id', ParseUUIDPipe) id: string, @Query(new ZodPipe(ReadingsQuery)) q: z.infer<typeof ReadingsQuery>) {
    checkRange(q);
    return this.env.pointReadings(id, q, q.page, q.size);
  }
}
