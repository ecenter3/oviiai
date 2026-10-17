import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Subject } from 'rxjs';
import { AppError } from '../common/errors';
import { KYSELY, type Database } from '../db/database.module';
import { SettingsService } from '../settings/settings.service';
import { StorageService } from '../storage/storage.service';
import { grabFrame, Recorder, rtspUrl } from './ffmpeg';
import { type StreamInfo, StreamsService } from './streams.service';

export type MediaKind = 'snapshot' | 'clip';
export type MediaSource = 'manual' | 'patrol' | 'alarm';

export interface MediaView {
  id: string;
  kind: MediaKind;
  source: MediaSource;
  streamKey: string | null;
  robotId: string | null;
  robotCode: string | null;
  cameraId: string | null;
  cameraCode: string | null;
  cameraName: string | null;
  floorId: string | null;
  alarmId: string | null;
  createdAt: string;
  endedAt: string | null;
  durationS: number | null;
  sizeBytes: number | null;
  contentType: string | null;
  createdByName: string | null;
  /** 5 分鐘有效的預簽名網址 */
  url: string;
}

export interface MediaFilter {
  kind: MediaKind;
  robot?: string;
  camera?: string;
  floor?: string;
  source?: MediaSource;
  from?: Date;
  to?: Date;
}

export interface ActiveRecording {
  id: string;
  streamKey: string;
  name: string;
  startedAt: string;
  maxSec: number;
  userId: string;
}

interface Running {
  rec: Recorder;
  info: StreamInfo;
  userId: string;
  maxSec: number;
  finalize: Promise<MediaView | null>;
}

const TMP = join(tmpdir(), 'oviiai-rec');
const day = (d: Date) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(d).replace(/-/g, '');

/**
 * 抓拍與錄影（T-28）。畫面一律由後端從 MediaMTX 取（攝影機與機器人鏡頭同一套），
 * 存到物件儲存（SeaweedFS，S3 相容）media/，紀錄寫 media 表；瀏覽器以 5 分鐘預簽名網址讀取。
 */
@Injectable()
export class MediaService implements OnModuleDestroy {
  private readonly log = new Logger('Media');
  private readonly running = new Map<string, Running>();
  /** 新的抓拍或錄影（WebSocket media.new） */
  readonly created$ = new Subject<MediaView>();
  /** 錄影開始、結束（WebSocket media.recording） */
  readonly recordings$ = new Subject<{ active: ActiveRecording[] }>();

  constructor(
    @Inject(KYSELY) private readonly db: Database,
    private readonly storage: StorageService,
    private readonly streams: StreamsService,
    private readonly settings: SettingsService,
  ) {}

  async onModuleDestroy() {
    // 關機前把錄到一半的收尾、上傳
    await Promise.all([...this.running.values()].map(async (r) => (await r.rec.stop(), r.finalize)));
  }

  // ===== 抓拍 =====

  async snapshot(streamKey: string, userId: string | null, opts: { source?: MediaSource; alarmId?: string | null; taskId?: string | null } = {}): Promise<MediaView> {
    const info = await this.stream(streamKey);
    let jpg: Buffer;
    try {
      jpg = await grabFrame(streamKey);
    } catch (e) {
      throw new AppError('INVALID_STATE', `${info.name}：${e instanceof Error ? e.message : e}`);
    }
    const id = randomUUID();
    const key = `media/snapshots/${day(new Date())}/${id}.jpg`;
    await this.storage.put(key, jpg, 'image/jpeg');
    await this.db
      .insertInto('media')
      .values({
        id,
        kind: 'snapshot',
        source: opts.source ?? 'manual',
        stream_key: streamKey,
        robot_id: info.kind === 'robot' ? info.id : null,
        camera_id: info.kind === 'camera' ? info.id : null,
        floor_id: info.floorId,
        alarm_id: opts.alarmId ?? null,
        task_id: opts.taskId ?? null,
        object_key: key,
        size_bytes: jpg.length,
        content_type: 'image/jpeg',
        created_by: userId,
      })
      .execute();
    const v = await this.get(id);
    this.created$.next(v);
    return v;
  }

  // ===== 錄影 =====

  active(): ActiveRecording[] {
    return [...this.running.entries()]
      .filter(([, r]) => r.rec.running)
      .map(([id, r]) => ({ id, streamKey: r.info.key, name: r.info.name, startedAt: new Date(r.rec.startedAt).toISOString(), maxSec: r.maxSec, userId: r.userId }));
  }

  async startRecording(streamKey: string, userId: string): Promise<ActiveRecording> {
    const info = await this.stream(streamKey);
    if ([...this.running.values()].some((r) => r.info.key === streamKey && r.rec.running)) throw new AppError('INVALID_STATE', `${info.name} 已在錄影中`);
    const maxSec = await this.settings.getNumber('media.maxRecordSec', 600);
    await mkdir(TMP, { recursive: true });
    const id = randomUUID();
    const file = join(TMP, `${id}.mp4`);
    const rec = new Recorder(await rtspUrl(streamKey), file, maxSec);
    // 來源啟動失敗會很快結束：最多等 10 秒看到檔案開始寫入
    const started = await Promise.race([
      rec.done.then((r) => (r.ok ? 'ended' : r.error ?? 'failed')),
      waitForFile(file, 10_000).then((ok) => (ok ? 'ok' : 'slow')),
    ]);
    if (started !== 'ok' && started !== 'slow') {
      await rm(file, { force: true });
      throw new AppError('INVALID_STATE', `${info.name} 無法錄影：${started === 'ended' ? '影像來源立即結束' : started}`);
    }
    const r: Running = { rec, info, userId, maxSec, finalize: Promise.resolve(null) };
    r.finalize = rec.done.then(() => this.finalize(id, r)).catch((e) => {
      this.log.error(`錄影收尾失敗：${e instanceof Error ? e.message : e}`);
      return null;
    });
    this.running.set(id, r);
    this.log.log(`${info.name} 開始錄影（最長 ${maxSec} 秒）`);
    this.recordings$.next({ active: this.active() });
    return this.active().find((a) => a.id === id)!;
  }

  async stopRecording(id: string): Promise<MediaView> {
    const r = this.running.get(id);
    if (!r) throw new AppError('NOT_FOUND', '找不到錄影（可能已結束）');
    await r.rec.stop();
    const v = await r.finalize;
    if (!v) throw new AppError('INVALID_STATE', '錄影沒有內容（影像來源中斷）');
    return v;
  }

  /** ffmpeg 結束（手動停止或到達上限）：上傳、寫紀錄 */
  private async finalize(id: string, r: Running): Promise<MediaView | null> {
    const file = r.rec.file;
    try {
      const size = await stat(file).then((s) => s.size, () => 0);
      if (size < 1024) {
        this.log.warn(`${r.info.name} 錄影沒有內容，捨棄`);
        return null;
      }
      const startedAt = new Date(r.rec.startedAt);
      const endedAt = new Date(r.rec.endedAt ?? Date.now());
      const key = `media/clips/${day(startedAt)}/${id}.mp4`;
      await this.storage.put(key, await readFile(file), 'video/mp4');
      await this.db
        .insertInto('media')
        .values({
          id,
          kind: 'clip',
          source: 'manual',
          stream_key: r.info.key,
          robot_id: r.info.kind === 'robot' ? r.info.id : null,
          camera_id: r.info.kind === 'camera' ? r.info.id : null,
          floor_id: r.info.floorId,
          object_key: key,
          size_bytes: size,
          duration_s: Math.max(1, Math.round((endedAt.getTime() - startedAt.getTime()) / 1000)),
          content_type: 'video/mp4',
          created_by: r.userId,
          created_at: startedAt,
          ended_at: endedAt,
        })
        .execute();
      this.log.log(`${r.info.name} 錄影完成（${Math.round(size / 1024)} KB）`);
      const v = await this.get(id);
      this.created$.next(v);
      return v;
    } finally {
      await rm(file, { force: true });
      this.running.delete(id);
      this.recordings$.next({ active: this.active() });
    }
  }

  // ===== 查詢 =====

  async options() {
    const [robots, cameras] = await Promise.all([
      this.db.selectFrom('robots').select(['id', 'code', 'floor_id']).where('enabled', '=', true).orderBy('code').execute(),
      this.db.selectFrom('cameras').select(['id', 'code', 'name', 'floor_id']).orderBy('code').execute(),
    ]);
    return {
      robots: robots.map((r) => ({ id: r.id, code: r.code, floorId: r.floor_id })),
      cameras: cameras.map((c) => ({ id: c.id, code: c.code, name: c.name, floorId: c.floor_id })),
    };
  }

  async get(id: string): Promise<MediaView> {
    const row = await this.base().where('m.id', '=', id).executeTakeFirst();
    if (!row) throw new AppError('NOT_FOUND', '找不到檔案');
    return this.view(row);
  }

  async list(f: MediaFilter, page: number, size: number) {
    let q = this.base().where('m.kind', '=', f.kind);
    if (f.robot) q = q.where('m.robot_id', '=', f.robot);
    if (f.camera) q = q.where('m.camera_id', '=', f.camera);
    if (f.floor) q = q.where('m.floor_id', '=', f.floor);
    if (f.source) q = q.where('m.source', '=', f.source);
    if (f.from) q = q.where('m.created_at', '>=', f.from);
    if (f.to) q = q.where('m.created_at', '<', f.to);
    const [rows, total] = await Promise.all([
      q.orderBy('m.created_at', 'desc').orderBy('m.id', 'desc').limit(size).offset((page - 1) * size).execute(),
      q.clearSelect().select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
    ]);
    return { items: await Promise.all(rows.map((r) => this.view(r))), total: Number(total.n), page, size };
  }

  async downloadUrl(id: string, download: boolean): Promise<{ url: string; kind: MediaKind }> {
    const v = await this.get(id);
    const ext = v.kind === 'clip' ? 'mp4' : 'jpg';
    const who = v.robotCode ?? v.cameraCode ?? 'media';
    const at = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei', dateStyle: 'short', timeStyle: 'medium' }).format(new Date(v.createdAt)).replace(/[: ]/g, '').replace(/-/g, '');
    const row = await this.db.selectFrom('media').select('object_key').where('id', '=', id).executeTakeFirstOrThrow();
    return { url: await this.storage.presign(row.object_key, download ? { filename: `${who}-${at}.${ext}` } : {}), kind: v.kind };
  }

  async kindOf(id: string): Promise<MediaKind> {
    const r = await this.db.selectFrom('media').select('kind').where('id', '=', id).executeTakeFirst();
    if (!r || (r.kind !== 'snapshot' && r.kind !== 'clip')) throw new AppError('NOT_FOUND', '找不到檔案');
    return r.kind;
  }

  async remove(ids: string[]): Promise<number> {
    const rows = await this.db.selectFrom('media').select(['id', 'object_key']).where('id', 'in', ids).execute();
    for (const r of rows) await this.storage.remove(r.object_key).catch(() => undefined);
    if (rows.length) await this.db.deleteFrom('media').where('id', 'in', rows.map((r) => r.id)).execute();
    return rows.length;
  }

  // ===== 內部 =====

  private async stream(key: string): Promise<StreamInfo> {
    const info = await this.streams.get(key);
    if (!info || !info.source) throw new AppError('NOT_FOUND', '沒有這一路影像或沒有影像來源');
    return info;
  }

  private base() {
    return this.db
      .selectFrom('media as m')
      .leftJoin('robots as r', 'r.id', 'm.robot_id')
      .leftJoin('cameras as c', 'c.id', 'm.camera_id')
      .leftJoin('users as u', 'u.id', 'm.created_by')
      .select([
        'm.id',
        'm.kind',
        'm.source',
        'm.stream_key',
        'm.robot_id',
        'm.camera_id',
        'm.floor_id',
        'm.alarm_id',
        'm.object_key',
        'm.size_bytes',
        'm.duration_s',
        'm.content_type',
        'm.created_at',
        'm.ended_at',
        'r.code as robot_code',
        'c.code as camera_code',
        'c.name as camera_name',
        'u.display_name as created_by_name',
      ]);
  }

  private async view(r: {
    id: string;
    kind: string;
    source: MediaSource;
    stream_key: string | null;
    robot_id: string | null;
    camera_id: string | null;
    floor_id: string | null;
    alarm_id: string | null;
    object_key: string;
    size_bytes: string | null;
    duration_s: number | null;
    content_type: string | null;
    created_at: Date;
    ended_at: Date | null;
    robot_code: string | null;
    camera_code: string | null;
    camera_name: string | null;
    created_by_name: string | null;
  }): Promise<MediaView> {
    return {
      id: r.id,
      kind: r.kind as MediaKind,
      source: r.source,
      streamKey: r.stream_key,
      robotId: r.robot_id,
      robotCode: r.robot_code,
      cameraId: r.camera_id,
      cameraCode: r.camera_code,
      cameraName: r.camera_name,
      floorId: r.floor_id,
      alarmId: r.alarm_id,
      createdAt: r.created_at.toISOString(),
      endedAt: r.ended_at?.toISOString() ?? null,
      durationS: r.duration_s,
      sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes),
      contentType: r.content_type,
      createdByName: r.created_by_name,
      url: await this.storage.presign(r.object_key),
    };
  }
}

async function waitForFile(file: string, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if ((await stat(file).then((s) => s.size, () => 0)) > 0) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}
