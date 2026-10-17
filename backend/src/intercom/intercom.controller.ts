import { Body, Controller, Delete, HttpCode, Param, ParseUUIDPipe, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { z } from 'zod';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequirePerm } from '../auth/perm.decorator';
import type { Principal } from '../auth/principal';
import { AppError } from '../common/errors';
import { ZodPipe } from '../common/zod.pipe';
import { OpLog } from '../oplog/oplog.decorator';
import { IntercomService, SPEAK_MAX_BYTES } from './intercom.service';

const target = (req: Request) => `robot:${req.params.id}`;
const SpeakBody = z.object({ durationMs: z.coerce.number().positive().max(60_000) }).strict();

/** 雙向對講（介面規格未列，T-31 新增；權限同遙控 op.remote） */
@Controller('robots/:id')
export class IntercomController {
  constructor(private readonly intercom: IntercomService) {}

  /** 方案 A：取得推流憑證與 WHIP 位址 */
  @Post('talk')
  @HttpCode(200)
  @RequirePerm('op.remote')
  @OpLog('robot.talk_start', target)
  start(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: Principal) {
    return this.intercom.start(id, user);
  }

  /** 方案 A：瀏覽器推流成功，叫轉接器開始拉音訊 */
  @Post('talk/started')
  @HttpCode(200)
  @RequirePerm('op.remote')
  started(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: Principal) {
    return this.intercom.started(id, user);
  }

  @Delete('talk')
  @HttpCode(204)
  @RequirePerm('op.remote')
  @OpLog('robot.talk_stop', target)
  async stop(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: Principal) {
    await this.intercom.stop(id, user);
  }

  /** 方案 B：按鍵說話（multipart：file＝錄音、durationMs） */
  @Post('speak-audio')
  @HttpCode(202)
  @RequirePerm('op.remote')
  @OpLog('robot.speak', target)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: SPEAK_MAX_BYTES, files: 1 } }))
  speak(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body(new ZodPipe(SpeakBody)) b: z.infer<typeof SpeakBody>,
    @CurrentUser() user: Principal,
  ) {
    if (!file) throw new AppError('VALIDATION_FAILED', '沒有錄音', { fields: { file: '必填' } });
    return this.intercom.speak(id, user, { buffer: file.buffer, mime: file.mimetype, durationMs: b.durationMs });
  }
}
