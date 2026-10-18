import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { z } from 'zod';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequirePerm } from '../auth/perm.decorator';
import type { Principal } from '../auth/principal';
import { AppError } from '../common/errors';
import { ZodPipe } from '../common/zod.pipe';
import { OpLog } from '../oplog/oplog.decorator';
import { AssetsService, AUDIO_MAX_BYTES } from './assets.service';

const KindQuery = z.object({ kind: z.enum(['audio', 'image', 'text']).optional() });
const UploadBody = z.object({
  kind: z.enum(['audio', 'image']),
  name: z.string().trim().max(40).optional(),
  note: z.string().trim().max(200).optional(),
  durationMs: z.coerce.number().int().positive().max(30 * 60_000).optional(),
});
const TextBody = z.object({ name: z.string().trim().min(1).max(40), text: z.string().trim().min(1).max(200), note: z.string().trim().max(200).nullable().optional() }).strict();
const PatchBody = z
  .object({ name: z.string().trim().min(1).max(40), note: z.string().trim().max(200).nullable(), text: z.string().trim().min(1).max(200) })
  .partial()
  .strict();
const PushBody = z.object({ robotIds: z.array(z.string().uuid()).min(1).max(50), seconds: z.number().int().min(5).max(3600).optional() }).strict();

const target = (req: Request, res?: unknown) => `asset:${String(req.params.id ?? (res as { id?: string } | undefined)?.id ?? '')}`;

/** 音視頻管理（T-42，權限 media）：喊話音檔、警示圖、詞條。推送到機器人另外要 op.remote（與遙控頁喊話相同） */
@Controller('assets')
export class AssetsController {
  constructor(private readonly assets: AssetsService) {}

  @Get()
  @RequirePerm('media')
  list(@Query(new ZodPipe(KindQuery)) q: z.infer<typeof KindQuery>) {
    return this.assets.list(q.kind);
  }

  /** multipart：file、kind（audio｜image）、name、note、durationMs（音訊長度，前端讀檔得到） */
  @Post()
  @RequirePerm('media')
  @OpLog('asset.upload', target)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: AUDIO_MAX_BYTES, files: 1 } }))
  upload(@UploadedFile() file: Express.Multer.File | undefined, @Body(new ZodPipe(UploadBody)) b: z.infer<typeof UploadBody>, @CurrentUser() user: Principal) {
    if (!file) throw new AppError('VALIDATION_FAILED', '請選擇檔案', { fields: { file: '必填' } });
    // multer 把檔名當 latin1 解：還原成 UTF-8（中文檔名）
    const originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
    return this.assets.upload(b.kind, { buffer: file.buffer, mime: file.mimetype, originalname }, b, user.sub);
  }

  @Post('text')
  @RequirePerm('media')
  @OpLog('asset.create', target)
  createText(@Body(new ZodPipe(TextBody)) b: z.infer<typeof TextBody>, @CurrentUser() user: Principal) {
    return this.assets.createText(b, user.sub);
  }

  @Patch(':id')
  @RequirePerm('media')
  @OpLog('asset.update', target)
  update(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(PatchBody)) b: z.infer<typeof PatchBody>) {
    return this.assets.update(id, b);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePerm('media')
  @OpLog('asset.delete', target)
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.assets.remove(id);
  }

  /** 推送到機器人：音訊、詞條播放，警示圖顯示在螢幕（seconds 秒，省略由機器人決定） */
  @Post(':id/push')
  @HttpCode(202)
  @RequirePerm('media', 'op.remote')
  @OpLog('asset.push', target)
  push(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(PushBody)) b: z.infer<typeof PushBody>, @CurrentUser() user: Principal) {
    return this.assets.push(id, b.robotIds, { seconds: b.seconds }, user.sub);
  }
}
