import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { Subscription } from 'rxjs';
import { CommandBus } from '../commands/command-bus.service';
import { AppError } from '../common/errors';
import { KYSELY, type Database } from '../db/database.module';
import { FleetService } from '../fleet/fleet.service';
import { RobotRegistry } from '../fleet/robot-registry';
import { StorageService } from '../storage/storage.service';

export const SUBSYSTEMS = ['motion', 'video', 'interaction', 'system'] as const;
export type Subsystem = (typeof SUBSYSTEMS)[number];
/** 上傳網址效期；超過這麼久還沒回報就當失敗（後端重啟漏掉回覆時） */
const UPLOAD_TTL_SEC = 15 * 60;
/**
 * 單檔上限（PR #18 審查第 2 點）。預簽名 PUT 限制不了大小，所以給轉接器 maxBytes 讓它先壓縮或截斷，
 * 回報完成時後端再量一次，超過就刪掉並標記失敗；失敗、逾時的也一併刪掉已傳上來的檔案。
 */
export const LOG_MAX_BYTES = 200 * 1024 * 1024;
const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;

export interface RobotLogView {
  id: string;
  robotId: string;
  robotCode: string;
  subsystem: Subsystem;
  status: 'requested' | 'uploaded' | 'failed';
  sizeBytes: number | null;
  error: string | null;
  requestedByName: string | null;
  createdAt: string;
  uploadedAt: string | null;
  fileName: string;
}

const stamp = (d: Date) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei', dateStyle: 'short', timeStyle: 'medium' }).format(d).replace(/[-: ]/g, '');

/**
 * 日誌管理（T-42，權限 logs）：向機器人要某個子系統的日誌。後端給轉接器一個 15 分鐘的預簽名 PUT 網址，
 * 指令 upload_logs 完成（done）後記下大小、可以下載；失敗、逾時記原因。保存 30 天（maintenance/retention.service 每日清）。
 */
@Injectable()
export class RobotLogsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('RobotLogs');
  private sub?: Subscription;

  constructor(
    @Inject(KYSELY) private readonly db: Database,
    private readonly storage: StorageService,
    private readonly bus: CommandBus,
    private readonly registry: RobotRegistry,
    private readonly fleet: FleetService,
  ) {}

  onModuleInit() {
    this.sub = this.bus.results$.subscribe((r) => {
      if (r.data.type !== 'upload_logs' || r.data.status === 'accepted') return;
      void this.onResult(r.data.cmdId, r.data.status === 'done', r.data.error?.msg ?? r.data.error?.code).catch((e) => this.log.error(String(e)));
    });
  }

  onModuleDestroy() {
    this.sub?.unsubscribe();
  }

  async request(robotId: string, subsystem: Subsystem, userId: string): Promise<RobotLogView> {
    const r = await this.registry.resolveId(robotId);
    if (!r) throw new AppError('NOT_FOUND', '找不到機器人或已停用');
    if (!this.fleet.get(r.code)?.online) throw new AppError('ROBOT_OFFLINE', `${r.code} 離線，無法取得日誌`);
    const now = new Date();
    const key = `robot-logs/${r.code}/${stamp(now).slice(0, 8)}/${randomUUID()}.log`;
    const url = await this.storage.presignPut(key, { ttlSec: UPLOAD_TTL_SEC });
    const { id } = await this.db.insertInto('robot_logs').values({ robot_id: r.id, subsystem, object_key: key, requested_by: userId }).returning('id').executeTakeFirstOrThrow();
    try {
      const rec = await this.bus.send(r, 'upload_logs', { subsystem, url, maxBytes: LOG_MAX_BYTES }, userId);
      await this.db.updateTable('robot_logs').set({ cmd_id: rec.cmdId }).where('id', '=', id).execute();
    } catch (e) {
      await this.db.updateTable('robot_logs').set({ status: 'failed', error: e instanceof Error ? e.message : String(e) }).where('id', '=', id).execute();
      throw e;
    }
    return this.get(id);
  }

  /** 指令結束：成功就確認檔案在、沒超過上限、記大小；失敗記原因並刪掉可能已傳上來的檔案 */
  async onResult(cmdId: string, ok: boolean, error?: string) {
    const row = await this.db.selectFrom('robot_logs').select(['id', 'object_key', 'status']).where('cmd_id', '=', cmdId).executeTakeFirst();
    if (!row || row.status !== 'requested') return;
    const size = await this.storage.size(row.object_key);
    if (ok && size != null && size <= LOG_MAX_BYTES) {
      await this.db.updateTable('robot_logs').set({ status: 'uploaded', size_bytes: size, uploaded_at: sql`now()` }).where('id', '=', row.id).execute();
      return;
    }
    const why = !ok ? (error ?? '機器人回報失敗') : size == null ? '機器人回報完成，但找不到上傳的檔案' : `檔案 ${mb(size)} 超過上限 ${mb(LOG_MAX_BYTES)}，已刪除`;
    if (size != null) await this.removeObject(row.object_key);
    await this.db.updateTable('robot_logs').set({ status: 'failed', error: why, size_bytes: size }).where('id', '=', row.id).execute();
    if (ok && size != null) this.log.warn(`日誌 ${row.id} ${why}`);
  }

  private async removeObject(key: string) {
    await this.storage.remove(key).catch((e) => this.log.warn(`刪除 ${key} 失敗：${e instanceof Error ? e.message : e}`));
  }

  async list(f: { robotId?: string; subsystem?: Subsystem }, page: number, size: number) {
    // 超過上傳網址效期還沒回報（例：後端重啟漏掉回覆）：當失敗，已傳上來的檔案（大小未經檢查）刪掉
    const expired = await this.db
      .updateTable('robot_logs')
      .set({ status: 'failed', error: '逾時：機器人沒有在 15 分鐘內上傳' })
      .where('status', '=', 'requested')
      .where('created_at', '<', new Date(Date.now() - UPLOAD_TTL_SEC * 1000))
      .returning('object_key')
      .execute();
    for (const e of expired) await this.removeObject(e.object_key);
    let q = this.base();
    if (f.robotId) q = q.where('l.robot_id', '=', f.robotId);
    if (f.subsystem) q = q.where('l.subsystem', '=', f.subsystem);
    const [rows, total] = await Promise.all([
      q.orderBy('l.created_at', 'desc').limit(size).offset((page - 1) * size).execute(),
      q.clearSelect().select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
    ]);
    return { items: rows.map(view), total: Number(total.n), page, size };
  }

  async get(id: string): Promise<RobotLogView> {
    const r = await this.base().where('l.id', '=', id).executeTakeFirst();
    if (!r) throw new AppError('NOT_FOUND', '找不到日誌');
    return view(r);
  }

  async downloadUrl(id: string) {
    const v = await this.get(id);
    if (v.status !== 'uploaded') throw new AppError('INVALID_STATE', '日誌還沒上傳完成');
    const row = await this.db.selectFrom('robot_logs').select('object_key').where('id', '=', id).executeTakeFirstOrThrow();
    return { url: await this.storage.presign(row.object_key, { filename: v.fileName }) };
  }

  private base() {
    return this.db
      .selectFrom('robot_logs as l')
      .innerJoin('robots as r', 'r.id', 'l.robot_id')
      .leftJoin('users as u', 'u.id', 'l.requested_by')
      .select(['l.id', 'l.robot_id', 'r.code', 'l.subsystem', 'l.status', 'l.size_bytes', 'l.error', 'l.created_at', 'l.uploaded_at', 'u.display_name as requested_by_name']);
  }
}

function view(r: {
  id: string;
  robot_id: string;
  code: string;
  subsystem: Subsystem;
  status: 'requested' | 'uploaded' | 'failed';
  size_bytes: string | null;
  error: string | null;
  created_at: Date;
  uploaded_at: Date | string | null;
  requested_by_name: string | null;
}): RobotLogView {
  return {
    id: r.id,
    robotId: r.robot_id,
    robotCode: r.code,
    subsystem: r.subsystem,
    status: r.status,
    sizeBytes: r.size_bytes == null ? null : Number(r.size_bytes),
    error: r.error,
    requestedByName: r.requested_by_name,
    createdAt: r.created_at.toISOString(),
    uploadedAt: r.uploaded_at ? new Date(r.uploaded_at).toISOString() : null,
    fileName: `${r.code}_${r.subsystem}_${stamp(r.created_at)}.log`,
  };
}
