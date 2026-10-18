import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import type { Request } from 'express';
import { sql } from 'kysely';
import { z } from 'zod';
import { RequirePerm } from '../auth/perm.decorator';
import { AppError } from '../common/errors';
import { PG_UNIQUE_VIOLATION, pgCode } from '../common/pg-errors';
import { ZodPipe } from '../common/zod.pipe';
import { dataEncKey } from '../config';
import { KYSELY, type Database } from '../db/database.module';
import { FleetService } from '../fleet/fleet.service';
import { RobotRegistry } from '../fleet/robot-registry';
import { StreamsService } from '../media/streams.service';
import { OpLog } from '../oplog/oplog.decorator';

/** 品牌是資料值（資料庫 CHECK 限定這三個）；能力清單決定畫面上的功能，不做品牌判斷 */
export const BRANDS = ['anbot', 'unitree', 'deep'] as const;
/** talk：能播放音檔（對講方案 B，按鍵說話）；talk_live：能接收即時音訊串流（方案 A）。T-31 */
/** screen：有螢幕，可顯示警示圖（T-42 音視頻管理） */
export const CAPS = ['ptz', 'light', 'talk', 'talk_live', 'follow', 'lift', 'env', 'screen'] as const;

export const Conn = z
  .object({
    host: z.string().trim().max(253).regex(/^[A-Za-z0-9.:_-]+$/, '主機名稱或 IP 格式錯誤').optional(),
    port: z.number().int().min(1).max(65535).optional(),
    username: z.string().trim().max(64).optional(),
    /** 機器人端地圖名稱、序號等其他非敏感設定 */
    extra: z.record(z.string().max(200)).optional(),
  })
  .strict();

const RobotBase = z.object({
  model: z.string().trim().min(1).max(32),
  serialNo: z.string().trim().max(64).nullable().optional(),
  floorId: z.string().regex(/^[a-z0-9]{1,8}$/),
  adapter: z.string().regex(/^[a-z0-9_-]{1,32}$/, '轉接器名稱只能用小寫英數、底線、連字號'),
  conn: Conn.default({}),
  /** 連線密碼（只寫不讀，加密存放）；null 清除，不給則不變 */
  secret: z.string().max(200).nullable().optional(),
  caps: z.array(z.enum(CAPS)).max(CAPS.length).default([]),
  modules: z.record(z.union([z.boolean(), z.string().max(64)])).default({}),
});
export const CreateRobot = RobotBase.extend({
  code: z.string().regex(/^[A-Z0-9][A-Z0-9-]{1,31}$/, '代碼只能用大寫英數與連字號，例：B2-003'),
  brand: z.enum(BRANDS),
}).strict();
const UpdateRobot = RobotBase.partial().extend({ enabled: z.boolean().optional() }).strict();

const robotTarget = (req: Request, res?: unknown) =>
  req.params.id ? `robot:${String(req.params.id)}` : ((res as { code?: string } | undefined)?.code ?? null);

/**
 * 機器人管理（介面規格 POST/PATCH/DELETE /robots，權限 robotmgr；T-25）。
 * 新增、修改、停用後立即重新載入登記清單：新機器人一送遙測就出現在監控頁，
 * 轉接器（含模擬器）從 GET /adapter-config/{name} 取得新清單。DELETE 是停用，不刪資料（歷史紀錄仍參照）。
 */
@Controller('robots')
export class RobotAdminController {
  constructor(
    @Inject(KYSELY) private readonly db: Database,
    private readonly registry: RobotRegistry,
    private readonly fleet: FleetService,
    private readonly streams: StreamsService,
  ) {}

  /** 機器人管理頁清單：含停用的，連線密碼只回是否已設定 */
  @Get('manage')
  @RequirePerm('robotmgr')
  async manage() {
    const rows = await this.db
      .selectFrom('robots')
      .select(['id', 'code', 'brand', 'model', 'serial_no', 'floor_id', 'adapter', 'conn', 'caps', 'modules', 'enabled', 'created_at'])
      .select(sql<boolean>`conn_secret IS NOT NULL`.as('has_secret'))
      .orderBy('floor_id')
      .orderBy('code')
      .execute();
    return rows.map((r) => ({
      id: r.id,
      code: r.code,
      brand: r.brand,
      model: r.model,
      serialNo: r.serial_no,
      floorId: r.floor_id,
      adapter: r.adapter,
      conn: r.conn,
      hasSecret: r.has_secret,
      caps: r.caps,
      modules: r.modules,
      enabled: r.enabled,
      createdAt: r.created_at.toISOString(),
      online: !!this.fleet.get(r.code)?.online,
    }));
  }

  @Post()
  @RequirePerm('robotmgr')
  @OpLog('robot.create', robotTarget)
  async create(@Body(new ZodPipe(CreateRobot)) b: z.infer<typeof CreateRobot>) {
    await this.checkFloor(b.floorId);
    try {
      const r = await this.db
        .insertInto('robots')
        .values({
          code: b.code,
          brand: b.brand,
          model: b.model,
          serial_no: b.serialNo ?? null,
          floor_id: b.floorId,
          adapter: b.adapter,
          conn: JSON.stringify(b.conn),
          conn_secret: b.secret ? sql`pgp_sym_encrypt(${b.secret}, ${dataEncKey()})` : null,
          caps: b.caps,
          modules: JSON.stringify(b.modules),
        })
        .returning(['id', 'code'])
        .executeTakeFirstOrThrow();
      await this.registry.load();
      void this.streams.sync();
      return r;
    } catch (e) {
      if (pgCode(e) === PG_UNIQUE_VIOLATION) throw new AppError('VALIDATION_FAILED', `代碼 ${b.code} 已存在`, { fields: { code: '代碼已存在' } });
      throw e;
    }
  }

  @Patch(':id')
  @RequirePerm('robotmgr')
  @OpLog('robot.update', robotTarget)
  async update(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(UpdateRobot)) b: z.infer<typeof UpdateRobot>) {
    if (b.floorId) await this.checkFloor(b.floorId);
    const r = await this.db
      .updateTable('robots')
      .set({
        ...(b.model !== undefined && { model: b.model }),
        ...(b.serialNo !== undefined && { serial_no: b.serialNo }),
        ...(b.floorId !== undefined && { floor_id: b.floorId }),
        ...(b.adapter !== undefined && { adapter: b.adapter }),
        ...(b.conn !== undefined && { conn: JSON.stringify(b.conn) }),
        ...(b.secret !== undefined && { conn_secret: b.secret ? sql`pgp_sym_encrypt(${b.secret}, ${dataEncKey()})` : null }),
        ...(b.caps !== undefined && { caps: b.caps }),
        ...(b.modules !== undefined && { modules: JSON.stringify(b.modules) }),
        ...(b.enabled !== undefined && { enabled: b.enabled }),
      })
      .where('id', '=', id)
      .returning(['id', 'code', 'enabled'])
      .executeTakeFirst();
    if (!r) throw new AppError('NOT_FOUND', '找不到機器人');
    await this.registry.load();
    void this.streams.sync();
    return r;
  }

  /** 停用（不刪除）：從監控畫面移除、執行中的任務回佇列（registry.removed$） */
  @Delete(':id')
  @HttpCode(200)
  @RequirePerm('robotmgr')
  @OpLog('robot.disable', robotTarget)
  async disable(@Param('id', ParseUUIDPipe) id: string) {
    const r = await this.db.updateTable('robots').set({ enabled: false }).where('id', '=', id).returning(['id', 'code']).executeTakeFirst();
    if (!r) throw new AppError('NOT_FOUND', '找不到機器人');
    await this.db.updateTable('chargers').set({ occupied_by: null }).where('occupied_by', '=', id).execute();
    await this.registry.load();
    void this.streams.sync();
    return { ...r, enabled: false };
  }

  private async checkFloor(floorId: string) {
    const f = await this.db.selectFrom('floors').select('id').where('id', '=', floorId).executeTakeFirst();
    if (!f) throw new AppError('VALIDATION_FAILED', '樓層不存在', { fields: { floorId: '樓層不存在' } });
  }
}
