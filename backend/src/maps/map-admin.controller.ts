import { Body, Controller, Delete, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import type { Request } from 'express';
import { sql } from 'kysely';
import { z } from 'zod';
import { RequirePerm } from '../auth/perm.decorator';
import { AppError } from '../common/errors';
import { PG_FK_VIOLATION, PG_UNIQUE_VIOLATION, pgCode } from '../common/pg-errors';
import { ZodPipe } from '../common/zod.pipe';
import { dataEncKey } from '../config';
import { KYSELY, type Database } from '../db/database.module';
import { StreamsService } from '../media/streams.service';
import { OpLog } from '../oplog/oplog.decorator';
import { BRANDS } from '../site/robot-admin.controller';

const Code = z.string().regex(/^[A-Z0-9][A-Z0-9-]{1,31}$/, '代碼只能用大寫英數與連字號');
const Floor = z.string().regex(/^[a-z0-9]{1,8}$/);
const Coord = z.number().finite().min(0).max(10_000);

export const ChargerBody = z
  .object({
    code: Code,
    floorId: Floor,
    x: Coord,
    y: Coord,
    /** 只供這個品牌使用（資料值比對） */
    brand: z.enum(BRANDS),
    /** 機器人端的充電樁 ID 等 */
    robotDock: z.record(z.union([z.string().max(100), z.number()])).default({}),
    enabled: z.boolean().default(true),
  })
  .strict();

export const CameraBody = z
  .object({
    code: Code,
    name: z.string().trim().min(1).max(32),
    floorId: Floor,
    x: Coord,
    y: Coord,
    /** 含帳密的 RTSP 位址：只寫不讀，pgcrypto 加密存放（CLAUDE.md） */
    rtspUrl: z.string().trim().max(500).regex(/^rtsps?:\/\//, '必須是 rtsp:// 或 rtsps:// 開頭'),
    enabled: z.boolean().default(true),
  })
  .strict();

const target = (kind: string) => (req: Request, res?: unknown) =>
  req.params.id ? `${kind}:${String(req.params.id)}` : ((res as { code?: string } | undefined)?.code ?? null);

/**
 * 地圖管理（T-25）：充電樁、攝影機的新增、修改、刪除（介面規格 /chargers、/cameras，權限 maps）。
 * 讀取清單在 MapObjectsController（監控頁也要看點位）。座標必須在樓層範圍內。
 */
@Controller()
export class MapAdminController {
  constructor(
    @Inject(KYSELY) private readonly db: Database,
    private readonly streams: StreamsService,
  ) {}

  @Post('chargers')
  @RequirePerm('maps')
  @OpLog('charger.create', target('charger'))
  async createCharger(@Body(new ZodPipe(ChargerBody)) b: z.infer<typeof ChargerBody>) {
    await this.checkPoint(b.floorId, b.x, b.y);
    return this.unique(b.code, () =>
      this.db
        .insertInto('chargers')
        .values({ code: b.code, floor_id: b.floorId, x: b.x, y: b.y, brand: b.brand, robot_dock: JSON.stringify(b.robotDock), enabled: b.enabled })
        .returning(['id', 'code'])
        .executeTakeFirstOrThrow(),
    );
  }

  @Patch('chargers/:id')
  @RequirePerm('maps')
  @OpLog('charger.update', target('charger'))
  async updateCharger(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ChargerBody.partial().strict())) b: Partial<z.infer<typeof ChargerBody>>) {
    const cur = await this.db.selectFrom('chargers').select(['floor_id', 'x', 'y', 'occupied_by']).where('id', '=', id).executeTakeFirst();
    if (!cur) throw new AppError('NOT_FOUND', '找不到充電樁');
    if (b.floorId !== undefined || b.x !== undefined || b.y !== undefined) await this.checkPoint(b.floorId ?? cur.floor_id, b.x ?? cur.x, b.y ?? cur.y);
    if (cur.occupied_by && (b.enabled === false || (b.floorId && b.floorId !== cur.floor_id))) throw new AppError('INVALID_STATE', '充電樁使用中，不能停用或換樓層');
    return this.unique(b.code ?? '', () =>
      this.db
        .updateTable('chargers')
        .set({
          ...(b.code !== undefined && { code: b.code }),
          ...(b.floorId !== undefined && { floor_id: b.floorId }),
          ...(b.x !== undefined && { x: b.x }),
          ...(b.y !== undefined && { y: b.y }),
          ...(b.brand !== undefined && { brand: b.brand }),
          ...(b.robotDock !== undefined && { robot_dock: JSON.stringify(b.robotDock) }),
          ...(b.enabled !== undefined && { enabled: b.enabled }),
        })
        .where('id', '=', id)
        .returning(['id', 'code'])
        .executeTakeFirstOrThrow(),
    );
  }

  @Delete('chargers/:id')
  @HttpCode(204)
  @RequirePerm('maps')
  @OpLog('charger.delete', target('charger'))
  async deleteCharger(@Param('id', ParseUUIDPipe) id: string) {
    const cur = await this.db.selectFrom('chargers').select(['occupied_by']).where('id', '=', id).executeTakeFirst();
    if (!cur) throw new AppError('NOT_FOUND', '找不到充電樁');
    if (cur.occupied_by) throw new AppError('INVALID_STATE', '充電樁使用中，不能刪除');
    await this.db.deleteFrom('chargers').where('id', '=', id).execute();
  }

  @Post('cameras')
  @RequirePerm('maps')
  @OpLog('camera.create', target('camera'))
  async createCamera(@Body(new ZodPipe(CameraBody)) b: z.infer<typeof CameraBody>) {
    await this.checkPoint(b.floorId, b.x, b.y);
    return this.afterCamera(this.unique(b.code, () =>
      this.db
        .insertInto('cameras')
        .values({
          code: b.code,
          name: b.name,
          floor_id: b.floorId,
          x: b.x,
          y: b.y,
          rtsp_url: sql`pgp_sym_encrypt(${b.rtspUrl}, ${dataEncKey()})`,
          stream_key: streamKey(b.code),
          enabled: b.enabled,
        })
        .returning(['id', 'code'])
        .executeTakeFirstOrThrow(),
    ));
  }

  @Patch('cameras/:id')
  @RequirePerm('maps')
  @OpLog('camera.update', target('camera'))
  async updateCamera(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(CameraBody.partial().strict())) b: Partial<z.infer<typeof CameraBody>>) {
    const cur = await this.db.selectFrom('cameras').select(['floor_id', 'x', 'y']).where('id', '=', id).executeTakeFirst();
    if (!cur) throw new AppError('NOT_FOUND', '找不到攝影機');
    if (b.floorId !== undefined || b.x !== undefined || b.y !== undefined) await this.checkPoint(b.floorId ?? cur.floor_id, b.x ?? cur.x, b.y ?? cur.y);
    return this.afterCamera(this.unique(b.code ?? '', () =>
      this.db
        .updateTable('cameras')
        .set({
          ...(b.code !== undefined && { code: b.code, stream_key: streamKey(b.code) }),
          ...(b.name !== undefined && { name: b.name }),
          ...(b.floorId !== undefined && { floor_id: b.floorId }),
          ...(b.x !== undefined && { x: b.x }),
          ...(b.y !== undefined && { y: b.y }),
          ...(b.rtspUrl !== undefined && { rtsp_url: sql`pgp_sym_encrypt(${b.rtspUrl}, ${dataEncKey()})` }),
          ...(b.enabled !== undefined && { enabled: b.enabled }),
        })
        .where('id', '=', id)
        .returning(['id', 'code'])
        .executeTakeFirstOrThrow(),
    ));
  }

  /** 攝影機有變：MediaMTX 路徑跟著新增、更新、移除（影像與整合 §1） */
  private async afterCamera<T>(p: Promise<T>): Promise<T> {
    const r = await p;
    void this.streams.sync();
    return r;
  }

  /** 已被告警參照的攝影機不刪（告警保存 1 年），改用停用 */
  @Delete('cameras/:id')
  @HttpCode(204)
  @RequirePerm('maps')
  @OpLog('camera.delete', target('camera'))
  async deleteCamera(@Param('id', ParseUUIDPipe) id: string) {
    try {
      const r = await this.db.deleteFrom('cameras').where('id', '=', id).executeTakeFirst();
      if (!r.numDeletedRows) throw new AppError('NOT_FOUND', '找不到攝影機');
      void this.streams.sync();
    } catch (e) {
      if (pgCode(e) === PG_FK_VIOLATION) throw new AppError('INVALID_STATE', '攝影機已有告警紀錄，請改為停用');
      throw e;
    }
  }

  /** 樓層存在、座標在樓層範圍內 */
  private async checkPoint(floorId: string, x: number, y: number) {
    const f = await this.db.selectFrom('floors').select(['width_m', 'height_m']).where('id', '=', floorId).executeTakeFirst();
    if (!f) throw new AppError('VALIDATION_FAILED', '樓層不存在', { fields: { floorId: '樓層不存在' } });
    if ((f.width_m !== null && x > Number(f.width_m)) || (f.height_m !== null && y > Number(f.height_m))) {
      throw new AppError('VALIDATION_FAILED', '座標超出樓層範圍', { fields: { x: '超出範圍', y: '超出範圍' } });
    }
  }

  private async unique<T>(code: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (pgCode(e) === PG_UNIQUE_VIOLATION) throw new AppError('VALIDATION_FAILED', `代碼 ${code} 已存在`, { fields: { code: '代碼已存在' } });
      throw e;
    }
  }
}

/** MediaMTX 路徑名稱（影像與整合 §1：cam/{攝影機代碼}） */
export const streamKey = (code: string) => `cam/${code}`;
