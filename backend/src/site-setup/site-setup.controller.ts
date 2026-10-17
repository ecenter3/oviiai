import { Controller, Get, HttpCode, Param, Post, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { z } from 'zod';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequireAnyPerm, RequirePerm } from '../auth/perm.decorator';
import type { Principal } from '../auth/principal';
import { AppError } from '../common/errors';
import { ZodPipe } from '../common/zod.pipe';
import { OpLog } from '../oplog/oplog.decorator';
import { assertKind, BulkImportService, type ImportKind, type ImportResult } from './bulk-import.service';
import { SetupStatusService } from './setup-status.service';
import { PACKAGE_MAX_BYTES, SiteTransferService } from './site-transfer.service';

const DryRun = z.object({ dryRun: z.enum(['true', 'false', '1', '0']).optional() }).strict();
const SiteImportQuery = DryRun.extend({
  /** merge（預設）只新增、修改；sync 會刪除或停用設定包裡沒有的 */
  mode: z.enum(['merge', 'sync']).default('merge'),
  /** sync 且有刪除時必填「刪除」 */
  confirm: z.string().max(16).optional(),
}).strict();
const TemplateQuery = z.object({ format: z.enum(['xlsx', 'csv']).default('xlsx') }).strict();
const isDry = (q: z.infer<typeof DryRun>) => q.dryRun === 'true' || q.dryRun === '1';
const IMPORT_MAX_BYTES = 5 * 1024 * 1024;

const KIND_PERM = { cameras: 'maps', robots: 'robotmgr' } as const;
const importLog = (kind: ImportKind) => (req: { query: Record<string, unknown> }) => `${kind === 'cameras' ? 'camera' : 'robot'}.import${req.query.dryRun === 'true' || req.query.dryRun === '1' ? '.preview' : ''}`;
const importTarget = (_req: unknown, res?: unknown) => {
  const r = res as ImportResult | undefined;
  return r ? `${r.kind}（${r.imported || r.valid}/${r.total} 列）` : null;
};

function need(file: Express.Multer.File | undefined): Express.Multer.File {
  if (!file?.buffer?.length) throw new AppError('VALIDATION_FAILED', '請選擇檔案', { fields: { file: '必填' } });
  return file;
}

/**
 * 場域快速設定（介面規格「場域快速設定」）：
 * T-45 批次匯入攝影機、機器人；T-44 場域設定匯出／匯入；T-46 設定精靈的完成狀態。
 */
@Controller()
export class SiteSetupController {
  constructor(
    private readonly bulk: BulkImportService,
    private readonly transfer: SiteTransferService,
    private readonly setup: SetupStatusService,
  ) {}

  // ===== T-45 批次匯入 =====

  /** 範本：攝影機要 maps、機器人要 robotmgr */
  @Get('import/templates/:kind')
  @RequireAnyPerm('maps', 'robotmgr')
  async template(
    @Param('kind') k: string,
    @Query(new ZodPipe(TemplateQuery)) q: z.infer<typeof TemplateQuery>,
    @CurrentUser() user: Principal,
    @Res() res: Response,
  ) {
    const kind = assertKind(k);
    if (!user.perms.includes(KIND_PERM[kind])) throw new AppError('FORBIDDEN', '沒有權限', { required: [KIND_PERM[kind]], mode: 'all' });
    const body = await this.bulk.template(kind, q.format);
    const name = `${kind === 'cameras' ? '攝影機' : '機器人'}匯入範本.${q.format}`;
    res
      .type(q.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .setHeader('Content-Disposition', `attachment; filename="${kind}-template.${q.format}"; filename*=UTF-8''${encodeURIComponent(name)}`)
      .send(body);
  }

  @Post('cameras/import')
  @HttpCode(200)
  @RequirePerm('maps')
  @OpLog(importLog('cameras'), importTarget)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: IMPORT_MAX_BYTES, files: 1 } }))
  importCameras(@UploadedFile() file: Express.Multer.File | undefined, @Query(new ZodPipe(DryRun)) q: z.infer<typeof DryRun>) {
    const f = need(file);
    return this.bulk.run('cameras', f.buffer, f.originalname, isDry(q));
  }

  @Post('robots/import')
  @HttpCode(200)
  @RequirePerm('robotmgr')
  @OpLog(importLog('robots'), importTarget)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: IMPORT_MAX_BYTES, files: 1 } }))
  importRobots(@UploadedFile() file: Express.Multer.File | undefined, @Query(new ZodPipe(DryRun)) q: z.infer<typeof DryRun>) {
    const f = need(file);
    return this.bulk.run('robots', f.buffer, f.originalname, isDry(q));
  }

  // ===== T-44 場域設定匯出／匯入 =====

  /** 下載設定包。雖然不改狀態，仍記操作日誌（整個場域的設定被帶走） */
  @Get('site/export')
  @RequirePerm('settings')
  @OpLog('site.export', () => 'site')
  async export(@Res() res: Response) {
    const zip = await this.transfer.exportZip();
    const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(new Date()).replace(/-/g, '');
    res.type('application/zip').setHeader('Content-Disposition', `attachment; filename="oviiai-site-${day}.zip"`).send(zip);
  }

  /** dryRun=true 只回傳差異；不帶 dryRun 才套用（單一交易） */
  @Post('site/import')
  @HttpCode(200)
  @RequirePerm('settings', 'op.config')
  @OpLog((req) => (req.query.dryRun === 'true' || req.query.dryRun === '1' ? 'site.import.preview' : 'site.import'), (req) => `site（${req.query.mode === 'sync' ? '同步刪除' : '合併'}）`)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: PACKAGE_MAX_BYTES, files: 1 } }))
  async import(@UploadedFile() file: Express.Multer.File | undefined, @Query(new ZodPipe(SiteImportQuery)) q: z.infer<typeof SiteImportQuery>, @CurrentUser() user: Principal) {
    const { pkg, plans } = this.transfer.read(need(file).buffer);
    if (isDry(q)) return { ...(await this.transfer.preview(pkg, plans, { actor: user, mode: q.mode })), applied: false };
    return this.transfer.apply(pkg, plans, user, q.mode, q.confirm);
  }

  // ===== T-46 設定精靈 =====

  @Get('site/setup-status')
  @RequirePerm('settings')
  status() {
    return this.setup.status();
  }
}
