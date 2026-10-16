import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { z } from 'zod';
import { RequirePerm } from '../auth/perm.decorator';
import { AppError } from '../common/errors';
import { ZodPipe } from '../common/zod.pipe';
import { OpLog } from '../oplog/oplog.decorator';
import { Authenticated } from '../auth/perm.decorator';
import { KYSELY, type Database } from '../db/database.module';
import { StorageService } from '../storage/storage.service';

/** 平面圖上限 15 MB；只收點陣圖（SVG 可能夾帶指令碼，不收） */
export const PLAN_MAX_BYTES = 15 * 1024 * 1024;
const PLAN_TYPES: { ext: string; mime: string; magic: (b: Buffer) => boolean }[] = [
  { ext: 'png', mime: 'image/png', magic: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: 'jpg', mime: 'image/jpeg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'webp', mime: 'image/webp', magic: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
];

/** 以檔案內容判斷格式（不信任副檔名與 Content-Type） */
export function sniffPlan(b: Buffer) {
  return PLAN_TYPES.find((t) => t.magic(b)) ?? null;
}

/** 平面圖網址：後端轉送物件儲存，帶版本避免快取舊圖（瀏覽器以 access token 取回） */
const planUrl = (id: string, key: string | null) => (key ? `/api/v1/floors/${id}/plan?v=${encodeURIComponent(key.split('/').pop()!)}` : null);

const FloorBody = z
  .object({
    name: z.string().trim().min(1).max(32),
    robotQuota: z.number().int().min(0).max(100),
    widthM: z.number().positive().max(10_000).nullable(),
    heightM: z.number().positive().max(10_000).nullable(),
  })
  .partial()
  .strict();

/** GET /floors（介面規格：登入即可）；PUT /floors/:id、平面圖上傳（maps，T-25） */
@Controller('floors')
export class FloorsController {
  constructor(
    @Inject(KYSELY) private readonly db: Database,
    private readonly storage: StorageService,
  ) {}

  @Authenticated()
  @Get()
  async list() {
    const rows = await this.db.selectFrom('floors').selectAll().orderBy('sort').execute();
    return rows.map((f) => ({
      id: f.id,
      name: f.name,
      sort: f.sort,
      planUrl: planUrl(f.id, f.plan_key),
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

  /** 上傳平面圖（multipart，欄位 file）：PNG／JPEG／WebP，存到物件儲存 plans/，舊圖刪除 */
  @Post(':id/plan')
  @RequirePerm('maps')
  @OpLog('floor.plan', (req) => `floor:${req.params.id}`)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: PLAN_MAX_BYTES, files: 1 } }))
  async uploadPlan(@Param('id') id: string, @UploadedFile() file: Express.Multer.File | undefined) {
    const floor = await this.floor(id);
    if (!file?.buffer?.length) throw new AppError('VALIDATION_FAILED', '請選擇平面圖檔案', { fields: { file: '必填' } });
    const t = sniffPlan(file.buffer);
    if (!t) throw new AppError('VALIDATION_FAILED', '平面圖只接受 PNG、JPEG、WebP', { fields: { file: '格式不支援' } });
    const key = `plans/${id}-${Date.now()}.${t.ext}`;
    await this.storage.put(key, file.buffer, t.mime);
    await this.db.updateTable('floors').set({ plan_key: key }).where('id', '=', id).execute();
    if (floor.plan_key) await this.storage.remove(floor.plan_key).catch(() => undefined);
    return { planUrl: planUrl(id, key), bytes: file.size, type: t.mime };
  }

  @Delete(':id/plan')
  @HttpCode(200)
  @RequirePerm('maps')
  @OpLog('floor.plan.delete', (req) => `floor:${req.params.id}`)
  async deletePlan(@Param('id') id: string) {
    const floor = await this.floor(id);
    await this.db.updateTable('floors').set({ plan_key: null }).where('id', '=', id).execute();
    if (floor.plan_key) await this.storage.remove(floor.plan_key).catch(() => undefined);
    return { planUrl: null };
  }

  /** 平面圖內容（登入即可，與 GET /floors 相同）；網址帶版本，可長時間快取 */
  @Authenticated()
  @Get(':id/plan')
  async plan(@Param('id') id: string, @Res() res: Response) {
    const floor = await this.floor(id);
    if (!floor.plan_key) throw new AppError('NOT_FOUND', '這個樓層還沒有平面圖');
    // 平面圖上限 15 MB：整個讀進來再送，不串流（串流經過開發用代理時瀏覽器會卡住收不完）
    const body = await this.storage.getBuffer(floor.plan_key).catch(() => {
      throw new AppError('NOT_FOUND', '平面圖檔案不存在');
    });
    const t = sniffPlan(body);
    res.setHeader('Content-Type', t?.mime ?? 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(body);
  }

  private async floor(id: string) {
    const f = await this.db.selectFrom('floors').select(['id', 'plan_key']).where('id', '=', id).executeTakeFirst();
    if (!f) throw new AppError('NOT_FOUND', '找不到樓層');
    return f;
  }
}
