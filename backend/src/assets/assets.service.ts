import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CommandBus } from '../commands/command-bus.service';
import { AppError } from '../common/errors';
import { KYSELY, type Database } from '../db/database.module';
import { FleetService } from '../fleet/fleet.service';
import { RobotRegistry } from '../fleet/robot-registry';
import { StorageService } from '../storage/storage.service';

export type AssetKind = 'audio' | 'image' | 'text';
export const AUDIO_MAX_BYTES = 10 * 1024 * 1024;
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const AUDIO_EXT: Record<string, string> = { 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/ogg': 'ogg', 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/aac': 'aac' };
const IMAGE_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
/** 推送時給轉接器的下載網址效期 */
const PUSH_URL_TTL_SEC = 300;

export interface AssetView {
  id: string;
  kind: AssetKind;
  name: string;
  note: string | null;
  mime: string | null;
  sizeBytes: number | null;
  durationMs: number | null;
  text: string | null;
  createdByName: string | null;
  createdAt: string;
  /** 音訊、圖片：5 分鐘預簽名網址（試聽、預覽） */
  url: string | null;
}

export interface PushResult {
  robotId: string;
  code: string;
  ok: boolean;
  cmdId?: string;
  reason?: string;
}

/**
 * 音視頻管理（T-42）：喊話音檔、警示圖、詞條（文字轉語音）。檔案放物件儲存 assets/。
 * 推送：音訊、詞條送 speak（需要 talk 或 talk_live 能力），警示圖送 show_image（需要 screen 能力）；
 * 轉接器拿 5 分鐘預簽名網址下載。離線或沒有能力的機器人不送，回傳原因。
 */
@Injectable()
export class AssetsService {
  constructor(
    @Inject(KYSELY) private readonly db: Database,
    private readonly storage: StorageService,
    private readonly bus: CommandBus,
    private readonly registry: RobotRegistry,
    private readonly fleet: FleetService,
  ) {}

  async list(kind?: AssetKind): Promise<AssetView[]> {
    let q = this.base().orderBy('a.created_at', 'desc');
    if (kind) q = q.where('a.kind', '=', kind);
    return Promise.all((await q.execute()).map((r) => this.view(r)));
  }

  async get(id: string): Promise<AssetView> {
    const r = await this.base().where('a.id', '=', id).executeTakeFirst();
    if (!r) throw new AppError('NOT_FOUND', '找不到這個素材');
    return this.view(r);
  }

  async upload(kind: 'audio' | 'image', file: { buffer: Buffer; mime: string; originalname: string }, meta: { name?: string; note?: string | null; durationMs?: number }, userId: string) {
    const mime = file.mime.split(';')[0].toLowerCase();
    const ext = (kind === 'audio' ? AUDIO_EXT : IMAGE_EXT)[mime];
    if (!ext) throw new AppError('VALIDATION_FAILED', kind === 'audio' ? '音訊只接受 mp3、wav、ogg、webm、m4a、aac' : '圖片只接受 png、jpg、gif、webp', { fields: { file: '格式不支援' } });
    if (!file.buffer.length) throw new AppError('VALIDATION_FAILED', '檔案是空的', { fields: { file: '檔案是空的' } });
    if (file.buffer.length > (kind === 'audio' ? AUDIO_MAX_BYTES : IMAGE_MAX_BYTES)) throw new AppError('VALIDATION_FAILED', kind === 'audio' ? '音訊最大 10 MB' : '圖片最大 5 MB', { fields: { file: '檔案太大' } });
    const key = `assets/${kind}/${randomUUID()}.${ext}`;
    await this.storage.put(key, file.buffer, mime);
    const name = (meta.name?.trim() || file.originalname.replace(/\.[^.]+$/, '')).slice(0, 40);
    const { id } = await this.db
      .insertInto('broadcast_assets')
      .values({ kind, name, note: meta.note ?? null, object_key: key, mime, size_bytes: file.buffer.length, duration_ms: kind === 'audio' ? (meta.durationMs ?? null) : null, created_by: userId })
      .returning('id')
      .executeTakeFirstOrThrow();
    return this.get(id);
  }

  async createText(b: { name: string; text: string; note?: string | null }, userId: string) {
    const { id } = await this.db
      .insertInto('broadcast_assets')
      .values({ kind: 'text', name: b.name, text: b.text, note: b.note ?? null, created_by: userId })
      .returning('id')
      .executeTakeFirstOrThrow();
    return this.get(id);
  }

  async update(id: string, b: { name?: string; note?: string | null; text?: string }) {
    const cur = await this.get(id);
    if (b.text !== undefined && cur.kind !== 'text') throw new AppError('VALIDATION_FAILED', '只有詞條可以改內容', { fields: { text: '只有詞條可以改內容' } });
    await this.db
      .updateTable('broadcast_assets')
      .set({ ...(b.name !== undefined && { name: b.name }), ...(b.note !== undefined && { note: b.note }), ...(b.text !== undefined && { text: b.text }) })
      .where('id', '=', id)
      .execute();
    return this.get(id);
  }

  async remove(id: string) {
    const row = await this.db.deleteFrom('broadcast_assets').where('id', '=', id).returning('object_key').executeTakeFirst();
    if (!row) throw new AppError('NOT_FOUND', '找不到這個素材');
    if (row.object_key) await this.storage.remove(row.object_key).catch(() => undefined);
  }

  /** 推送到機器人：每台各送一個指令（不等完成，結果由 robot.cmdResult 推給畫面） */
  async push(id: string, robotIds: string[], opts: { seconds?: number }, userId: string): Promise<PushResult[]> {
    const a = await this.db.selectFrom('broadcast_assets').selectAll().where('id', '=', id).executeTakeFirst();
    if (!a) throw new AppError('NOT_FOUND', '找不到這個素材');
    const need = a.kind === 'image' ? ['screen'] : ['talk', 'talk_live'];
    const url = a.object_key ? await this.storage.presign(a.object_key, { ttlSec: PUSH_URL_TTL_SEC, for: 'adapter' }) : null;
    const out: PushResult[] = [];
    for (const robotId of [...new Set(robotIds)]) {
      const r = await this.registry.resolveId(robotId);
      if (!r) {
        out.push({ robotId, code: '?', ok: false, reason: '找不到機器人或已停用' });
        continue;
      }
      if (!need.some((c) => r.caps.includes(c))) {
        out.push({ robotId, code: r.code, ok: false, reason: a.kind === 'image' ? '沒有螢幕（screen 能力）' : '沒有喇叭（talk 能力）' });
        continue;
      }
      if (!this.fleet.get(r.code)?.online) {
        out.push({ robotId, code: r.code, ok: false, reason: '離線' });
        continue;
      }
      const args =
        a.kind === 'text'
          ? { text: a.text }
          : a.kind === 'audio'
            ? { audio: { url, mime: a.mime, bytes: a.size_bytes, ...(a.duration_ms && { durationMs: a.duration_ms }) }, assetId: a.id }
            : { image: { url, mime: a.mime, bytes: a.size_bytes }, assetId: a.id, ...(opts.seconds && { seconds: opts.seconds }) };
      try {
        const rec = await this.bus.send(r, a.kind === 'image' ? 'show_image' : 'speak', args, userId);
        out.push({ robotId, code: r.code, ok: true, cmdId: rec.cmdId });
      } catch (e) {
        out.push({ robotId, code: r.code, ok: false, reason: e instanceof AppError ? e.message : String(e) });
      }
    }
    return out;
  }

  private base() {
    return this.db
      .selectFrom('broadcast_assets as a')
      .leftJoin('users as u', 'u.id', 'a.created_by')
      .select(['a.id', 'a.kind', 'a.name', 'a.note', 'a.object_key', 'a.mime', 'a.size_bytes', 'a.duration_ms', 'a.text', 'a.created_at', 'u.display_name as created_by_name']);
  }

  private async view(r: {
    id: string;
    kind: AssetKind;
    name: string;
    note: string | null;
    object_key: string | null;
    mime: string | null;
    size_bytes: number | null;
    duration_ms: number | null;
    text: string | null;
    created_at: Date;
    created_by_name: string | null;
  }): Promise<AssetView> {
    return {
      id: r.id,
      kind: r.kind,
      name: r.name,
      note: r.note,
      mime: r.mime,
      sizeBytes: r.size_bytes,
      durationMs: r.duration_ms,
      text: r.text,
      createdByName: r.created_by_name,
      createdAt: r.created_at.toISOString(),
      url: r.object_key ? await this.storage.presign(r.object_key) : null,
    };
  }
}
