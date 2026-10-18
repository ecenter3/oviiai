import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequireAnyPerm, RequirePerm } from '../auth/perm.decorator';
import type { Principal } from '../auth/principal';
import { AppError } from '../common/errors';
import { PageQuery } from '../common/pagination';
import { ZodPipe } from '../common/zod.pipe';
import { OpLog } from '../oplog/oplog.decorator';
import { type MediaKind, MediaService } from './media.service';

const Key = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_./-]{0,127}$/);
const SnapshotBody = z.object({ streamKey: Key }).strict();
const RecordBody = z.object({ streamKey: Key }).strict();
const ListQuery = PageQuery.extend({
  kind: z.enum(['snapshot', 'clip']),
  robot: z.string().uuid().optional(),
  camera: z.string().uuid().optional(),
  floor: z.string().regex(/^[a-z0-9]{1,8}$/).optional(),
  source: z.enum(['manual', 'patrol', 'alarm']).optional(),
  from: z.string().datetime({ offset: true }).transform((s) => new Date(s)).optional(),
  to: z.string().datetime({ offset: true }).transform((s) => new Date(s)).optional(),
});
const UrlQuery = z.object({ download: z.enum(['0', '1']).optional() });
const DeleteBody = z.object({ ids: z.array(z.string().uuid()).min(1).max(200) }).strict();

/** 抓拍看「抓拍圖片」權限、錄影看「錄像回放」權限 */
const PAGE: Record<MediaKind, 'captures' | 'records'> = { snapshot: 'captures', clip: 'records' };
/** 看得到這種檔案：抓拍要 captures、錄像要 records；歷史視頻（history）兩種都能看 */
const HistoryQuery = z.object({
  robot: z.string().uuid().optional(),
  camera: z.string().uuid().optional(),
  from: z.string().datetime({ offset: true }).transform((v) => new Date(v)),
  to: z.string().datetime({ offset: true }).transform((v) => new Date(v)),
});

function checkKind(user: Principal, kind: MediaKind) {
  if (!user.perms.includes(PAGE[kind]) && !user.perms.includes('history')) throw new AppError('FORBIDDEN', '沒有權限');
}
const target = (req: Request, res?: unknown) => `media:${String(req.params.id ?? (res as { id?: string } | undefined)?.id ?? '')}`;

/**
 * 抓拍與錄影（介面規格 /media；T-28）。抓拍、錄影要 op.remote（與遙控頁相同）；
 * 瀏覽抓拍圖片要 captures、錄像要 records。
 */
@Controller('media')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Post('snapshot')
  @RequirePerm('op.remote')
  @OpLog('media.snapshot', target)
  snapshot(@Body(new ZodPipe(SnapshotBody)) b: z.infer<typeof SnapshotBody>, @CurrentUser() user: Principal) {
    return this.media.snapshot(b.streamKey, user.sub);
  }

  /** 篩選欄的選項（抓拍、錄像、歷史視頻頁的使用者不一定有 robots、monitor 權限） */
  @Get('options')
  @RequireAnyPerm('captures', 'records', 'history')
  options() {
    return this.media.options();
  }

  @Get('recordings/active')
  @RequireAnyPerm('monitor', 'robots', 'remote', 'records')
  active() {
    return this.media.active();
  }

  @Post('recordings')
  @RequirePerm('op.remote')
  @OpLog('media.record_start', (req) => `stream:${String((req.body as { streamKey?: string })?.streamKey ?? '')}`)
  start(@Body(new ZodPipe(RecordBody)) b: z.infer<typeof RecordBody>, @CurrentUser() user: Principal) {
    return this.media.startRecording(b.streamKey, user.sub);
  }

  @Post('recordings/:id/stop')
  @HttpCode(200)
  @RequirePerm('op.remote')
  @OpLog('media.record_stop', target)
  stop(@Param('id', ParseUUIDPipe) id: string) {
    return this.media.stopRecording(id);
  }

  /** `?kind=snapshot|clip&robot&camera&floor&source&from&to&page&size`；每筆附 5 分鐘預簽名網址 */
  @Get()
  @RequireAnyPerm('captures', 'records')
  list(@Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>, @CurrentUser() user: Principal) {
    checkKind(user, q.kind);
    return this.media.list({ kind: q.kind, robot: q.robot, camera: q.camera, floor: q.floor, source: q.source, from: q.from, to: q.to }, q.page, q.size);
  }

  /** 歷史視頻（T-40）：`?robot|camera&from&to`，錄影片段、抓拍、告警時間點（各附 5 分鐘預簽名網址） */
  @Get('history')
  @RequirePerm('history')
  history(@Query(new ZodPipe(HistoryQuery)) q: z.infer<typeof HistoryQuery>) {
    return this.media.history(q);
  }

  /** 介面規格 GET /media/:id/url：5 分鐘預簽名網址；?download=1 以附件下載 */
  @Get(':id/url')
  @RequireAnyPerm('captures', 'records', 'history')
  async url(@Param('id', ParseUUIDPipe) id: string, @Query(new ZodPipe(UrlQuery)) q: z.infer<typeof UrlQuery>, @CurrentUser() user: Principal) {
    checkKind(user, await this.media.kindOf(id));
    return { url: (await this.media.downloadUrl(id, q.download === '1')).url };
  }

  /**
   * 刪除（可多筆；原型「全選」「刪除」）。要有操作權限 op.media，且看得到該種類（PR #12 審查第 1 點）；
   * 告警關聯的檔案是證據，不能手動刪，只能由保存期限排程清除（409）。
   */
  @Post('delete')
  @HttpCode(200)
  @RequirePerm('op.media')
  @OpLog('media.delete', () => 'media')
  async remove(@Body(new ZodPipe(DeleteBody)) b: z.infer<typeof DeleteBody>, @CurrentUser() user: Principal) {
    for (const id of b.ids) checkKind(user, await this.media.kindOf(id));
    return { deleted: await this.media.remove(b.ids) };
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePerm('op.media')
  @OpLog('media.delete', target)
  async removeOne(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: Principal) {
    checkKind(user, await this.media.kindOf(id));
    await this.media.remove([id]);
  }
}
