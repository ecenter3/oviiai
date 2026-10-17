import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { sql } from 'kysely';
import { AlarmsService } from '../alarms/alarms.service';
import { dataEncKey } from '../config';
import { KYSELY, type Database } from '../db/database.module';
import { mediaConfig } from './media-config';
import { MediaMtxClient, type MtxPathConf } from './mediamtx.client';
import { verifyStreamToken } from './stream-token';

export interface StreamInfo {
  key: string;
  kind: 'camera' | 'robot';
  /** camera id 或 robot id */
  id: string;
  code: string;
  name: string;
  floorId: string;
  /** rtsp：實際來源；test：測試影像源；null：沒有來源（不建路徑） */
  source: 'rtsp' | 'test' | null;
}

/** MediaMTX 回呼的內容（authMethod: http） */
export interface MediaAuthRequest {
  user?: string;
  password?: string;
  token?: string;
  ip?: string;
  action?: string;
  path?: string;
  protocol?: string;
  query?: string;
}

const SYNC_MS = 60_000;
const WATCH_MS = 5_000;
/** 有人要看（20 秒內取過憑證或正在讀）卻沒有畫面超過 15 秒 → stream_down（影像與整合 §1） */
export const WANTED_MS = 20_000;
export const DOWN_AFTER_MS = 15_000;

/** 機器人前鏡頭的路徑 */
export const robotStreamKey = (code: string) => `robot/${code}/front`;

/**
 * 影像路徑（工程開發手冊「影像與整合」§1、T-29）。
 *
 * - 攝影機（cameras.stream_key）與機器人前鏡頭（robot/{代碼}/front）由後端以 MediaMTX Control API 建立，
 *   RTSP 帳密只在記憶體與 API 呼叫中，不寫進設定檔。啟動時、攝影機或機器人有變、以及每 60 秒對齊一次。
 * - 沒有實際來源時（開發）：用 MediaMTX 內建 ffmpeg 的測試影像源（testsrc），有人看才啟動。
 * - 播放權限：MediaMTX 每次讀取都回呼 /internal/media/auth，帶後端核發的 60 秒憑證才放行。
 * - 影像中斷：有人要看卻超過 15 秒沒有畫面 → 二級 stream_down 告警。
 */
@Injectable()
export class StreamsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Streams');
  private catalog = new Map<string, StreamInfo>();
  private readonly wanted = new Map<string, number>();
  private readonly downSince = new Map<string, number>();
  private readonly alerted = new Set<string>();
  private syncTimer?: NodeJS.Timeout;
  private watchTimer?: NodeJS.Timeout;
  private syncing: Promise<void> = Promise.resolve();
  private lastSyncError = '';

  constructor(
    @Inject(KYSELY) private readonly db: Database,
    private readonly mtx: MediaMtxClient,
    private readonly alarms: AlarmsService,
  ) {}

  onModuleInit() {
    void this.sync();
    this.syncTimer = setInterval(() => void this.sync(), SYNC_MS);
    this.watchTimer = setInterval(() => void this.watch().catch(() => undefined), WATCH_MS);
  }

  onModuleDestroy() {
    clearInterval(this.syncTimer);
    clearInterval(this.watchTimer);
  }

  /** 目前可播放的路徑（依樓層） */
  async list(floor?: string): Promise<StreamInfo[]> {
    if (!this.catalog.size) await this.loadCatalog();
    return [...this.catalog.values()].filter((s) => (!floor || s.floorId === floor) && s.source !== null).sort((a, b) => a.key.localeCompare(b.key));
  }

  async get(key: string): Promise<StreamInfo | undefined> {
    if (!this.catalog.has(key)) await this.loadCatalog();
    return this.catalog.get(key);
  }

  /** 記下「有人要看」（核發憑證、MediaMTX 放行讀取時） */
  markWanted(key: string, now = Date.now()) {
    this.wanted.set(key, now);
  }

  /**
   * MediaMTX 回呼的授權判斷：內部帳號（後端抓拍錄影、測試影像源）可讀寫；
   * 瀏覽器只能讀，且要帶這一路有效的憑證。
   */
  authorize(req: MediaAuthRequest, now = Date.now()): boolean {
    const cfg = mediaConfig();
    if (req.user === cfg.internalUser && req.password === cfg.internalPassword && req.user && req.password) return true;
    if (req.action !== 'read' || !req.path) return false;
    const token = req.token || new URLSearchParams(req.query ?? '').get('token') || req.password || undefined;
    if (!verifyStreamToken(token, req.path, now)) return false;
    this.markWanted(req.path, now);
    return true;
  }

  /** 與 MediaMTX 對齊（依序執行；MediaMTX 沒開時只記錄一次警告） */
  sync(): Promise<void> {
    const run = this.syncing.then(() => this.syncOnce());
    this.syncing = run.catch(() => undefined);
    return run;
  }

  private async syncOnce(): Promise<void> {
    await this.loadCatalog();
    try {
      const desired = new Map<string, MtxPathConf>();
      for (const s of this.catalog.values()) {
        const conf = await this.confOf(s);
        if (conf) desired.set(s.key, conf);
      }
      const current = await this.mtx.configuredPaths();
      for (const p of current) {
        if (!desired.has(p.name)) await this.mtx.deletePath(p.name);
      }
      for (const [name, conf] of desired) {
        const cur = current.find((p) => p.name === name)?.conf as Record<string, unknown> | undefined;
        const same = cur && Object.entries(conf).every(([k, v]) => cur[k] === v);
        if (!same) await this.mtx.replacePath(name, conf);
      }
      if (this.lastSyncError) this.log.log('MediaMTX 已連上，影像路徑已對齊');
      this.lastSyncError = '';
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg !== this.lastSyncError) this.log.warn(`MediaMTX 路徑對齊失敗（影像功能暫不可用）：${msg}`);
      this.lastSyncError = msg;
    }
  }

  /** 每 5 秒：有人要看卻沒畫面超過 15 秒 → 告警；恢復後可再告警 */
  async watch(now = Date.now()): Promise<void> {
    const active = [...this.wanted.entries()].filter(([, t]) => now - t < WANTED_MS).map(([k]) => k);
    for (const [k, t] of this.wanted) if (now - t >= WANTED_MS && !this.downSince.has(k)) this.wanted.delete(k);
    if (!active.length && !this.downSince.size) return;
    const states = new Map((await this.mtx.paths()).map((p) => [p.name, p]));
    for (const key of new Set([...active, ...this.downSince.keys()])) {
      const st = states.get(key);
      const watching = active.includes(key) || (st?.readers.length ?? 0) > 0;
      if (st?.ready || !watching) {
        if (st?.ready && this.alerted.has(key)) this.log.log(`${key} 影像恢復`);
        this.downSince.delete(key);
        this.alerted.delete(key);
        continue;
      }
      const since = this.downSince.get(key) ?? now;
      this.downSince.set(key, since);
      if (now - since >= DOWN_AFTER_MS && !this.alerted.has(key)) {
        this.alerted.add(key);
        const info = await this.get(key);
        const secs = Math.round((now - since) / 1000);
        await this.alarms.raise({
          type: 'stream_down',
          source: `stream:${key}`,
          cameraId: info?.kind === 'camera' ? info.id : null,
          robotId: info?.kind === 'robot' ? info.id : null,
          floorId: info?.floorId ?? null,
          message: `${info?.name ?? key} 影像中斷 ${secs} 秒`,
          ext: { stream: key },
        });
      }
    }
  }

  private async loadCatalog() {
    const cams = await this.db
      .selectFrom('cameras')
      .select(['id', 'code', 'name', 'floor_id', 'stream_key'])
      .select(sql<boolean>`length(rtsp_url) > 0`.as('has_rtsp'))
      .where('enabled', '=', true)
      .execute();
    const robots = await this.db.selectFrom('robots').select(['id', 'code', 'floor_id']).where('enabled', '=', true).execute();
    const test = mediaConfig().testSource;
    const next = new Map<string, StreamInfo>();
    for (const c of cams) {
      next.set(c.stream_key, { key: c.stream_key, kind: 'camera', id: c.id, code: c.code, name: c.name, floorId: c.floor_id, source: c.has_rtsp ? 'rtsp' : test ? 'test' : null });
    }
    // 機器人前鏡頭：轉接器回報串流位址前（T-32），只有測試影像源
    for (const r of robots) {
      const key = robotStreamKey(r.code);
      next.set(key, { key, kind: 'robot', id: r.id, code: r.code, name: `${r.code} 前鏡頭`, floorId: r.floor_id, source: test ? 'test' : null });
    }
    this.catalog = next;
  }

  private async confOf(s: StreamInfo): Promise<MtxPathConf | null> {
    if (s.source === 'test') return testSourceConf();
    if (s.source !== 'rtsp' || s.kind !== 'camera') return null;
    const row = await this.db
      .selectFrom('cameras')
      .select(sql<string>`pgp_sym_decrypt(rtsp_url, ${dataEncKey()})`.as('url'))
      .where('id', '=', s.id)
      .executeTakeFirst();
    return row?.url ? { source: row.url, sourceOnDemand: true, rtspTransport: 'tcp' } : null;
  }
}

/** MediaMTX 內建 ffmpeg 產生的測試畫面（有人看才啟動，沒人看 10 秒後關閉）；GOP 1 秒讓抓拍、開播快 */
export function testSourceConf(): MtxPathConf {
  const { internalUser, internalPassword } = mediaConfig();
  return {
    sourceOnDemand: false,
    runOnDemand:
      'ffmpeg -hide_banner -loglevel error -re -f lavfi -i testsrc=size=640x360:rate=15 ' +
      '-c:v libx264 -preset ultrafast -tune zerolatency -g 15 -pix_fmt yuv420p ' +
      `-f rtsp -rtsp_transport tcp rtsp://${internalUser}:${internalPassword}@localhost:$RTSP_PORT/$MTX_PATH`,
    runOnDemandRestart: true,
    runOnDemandCloseAfter: '10s',
  };
}
