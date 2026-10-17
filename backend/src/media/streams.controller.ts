import { Body, Controller, Get, HttpCode, Logger, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequireAnyPerm } from '../auth/perm.decorator';
import type { Principal } from '../auth/principal';
import { Public } from '../auth/public.decorator';
import { AppError } from '../common/errors';
import { ZodPipe } from '../common/zod.pipe';
import { mediaConfig } from './media-config';
import { issueStreamToken } from './stream-token';
import { type MediaAuthRequest, StreamsService } from './streams.service';

const FloorQuery = z.object({ floor: z.string().regex(/^[a-z0-9]{1,8}$/).optional() });
/** MediaMTX 路徑名稱：英數、-、_、/（cam/CAM-1F-01、robot/B2-001/front） */
const KEY = /^[A-Za-z0-9][A-Za-z0-9_./-]{0,127}$/;

/** 看影像的頁面：實時監控、機器人狀態、實時遙控 */
@Controller('streams')
@RequireAnyPerm('monitor', 'robots', 'remote')
export class StreamsController {
  constructor(private readonly streams: StreamsService) {}

  /** 可播放的影像（攝影機與機器人鏡頭） */
  @Get()
  async list(@Query(new ZodPipe(FloorQuery)) q: z.infer<typeof FloorQuery>) {
    const cfg = mediaConfig();
    return (await this.streams.list(q.floor)).map((s) => ({ key: s.key, kind: s.kind, id: s.id, code: s.code, name: s.name, floorId: s.floorId, test: s.source === 'test', whepUrl: `${cfg.publicUrl}/${s.key}/whep` }));
  }

  /**
   * 播放憑證（介面規格 GET /streams/:key/token；key 含 / 時以 %2F 編碼）。60 秒內開始播放有效；
   * 播放中不需要再換，斷線重連時重新取。
   */
  @Get(':key/token')
  async token(@Param('key') key: string, @CurrentUser() user: Principal) {
    if (!KEY.test(key)) throw new AppError('NOT_FOUND', '沒有這一路影像');
    const s = await this.streams.get(key);
    // 對講路徑不發播放憑證（不能旁聽控制室講話）；對講由 /robots/:id/talk 核發推流憑證
    if (!s?.source || s.kind === 'talk') throw new AppError('NOT_FOUND', '沒有這一路影像或沒有影像來源');
    const t = issueStreamToken(key, user.sub);
    this.streams.markWanted(key);
    return { token: t.token, expiresAt: new Date(t.expiresAt).toISOString(), whepUrl: `${mediaConfig().publicUrl}/${key}/whep` };
  }
}

/**
 * MediaMTX 的權限回呼（authMethod: http，影像與整合 §1）。不在 /api/v1 底下，正式環境 Nginx 不轉送 /internal，
 * 只有 MediaMTX 容器直連後端呼叫。200 放行、401 拒絕；不回任何資料。
 */
@Controller('internal/media')
export class MediaAuthController {
  private readonly log = new Logger('MediaAuth');
  constructor(private readonly streams: StreamsService) {}

  @Public()
  @Post('auth')
  @HttpCode(200)
  auth(@Body() body: MediaAuthRequest, @Res() res: Response) {
    if (this.streams.authorize(body ?? {})) {
      res.status(200).end();
      return;
    }
    // 只記帳號與有沒有密碼、查詢字串，不記內容（憑證）
    this.log.debug(`拒絕 ${body?.action ?? '?'} ${body?.path ?? '?'}（${body?.protocol ?? '?'}，${body?.ip ?? '?'}，帳號 ${body?.user || '-'}、密碼${body?.password ? '有' : '無'}、查詢${body?.query ? '有' : '無'}）`);
    res.status(401).end();
  }
}
