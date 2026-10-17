import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { RobotEvent, topics } from '@oviiai/contracts';
import { Subject, type Subscription } from 'rxjs';
import type { Principal } from '../auth/principal';
import { CommandBus } from '../commands/command-bus.service';
import { AppError } from '../common/errors';
import { FleetService } from '../fleet/fleet.service';
import { RobotRegistry } from '../fleet/robot-registry';
import type { RobotInfo } from '../fleet/types';
import { mediaConfig } from '../media/media-config';
import { MediaMtxClient } from '../media/mediamtx.client';
import { MqttService } from '../mqtt/mqtt.service';
import { issueShortToken, issueStreamToken } from '../media/stream-token';
import { StreamsService, TALK_READER, talkStreamKey } from '../media/streams.service';
import { StorageService } from '../storage/storage.service';

/** 按鍵說話（方案 B）的錄音上限。音檔放物件儲存，不受 MQTT 封包大小限制；5 MB 容得下 30 秒 48 kHz 單聲道 WAV */
export const SPEAK_MAX_MS = 30_000;
export const SPEAK_MAX_BYTES = 5 * 1024 * 1024;
/** 轉接器下載音檔的預簽名網址有效時間 */
export const SPEAK_URL_TTL_SEC = 300;
/** 物件儲存的前綴；指令結束就刪，殘留的由每日保存期限排程清（1 天） */
export const SPEAK_PREFIX = 'speak/';
const EXT: Record<string, string> = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav' };
/** 推流憑證只用在建立 WHIP 連線那一刻；拉流憑證只用在轉接器連上那一刻 */
const PUBLISH_TTL_SEC = 60;
const READ_TTL_SEC = 60;

/**
 * 雙向對講（工程開發手冊「影像與整合」§2；T-31）。
 *
 * 方案 A（能力 talk_live）：瀏覽器麥克風以 WHIP 推到 MediaMTX 的 talk/{代碼}（後端核發 publish 憑證，只能推這一路）；
 * 確認推上來後送 talk_start 給轉接器（帶 read 憑證），轉接器拉這路音訊送到機器人喇叭；
 * 機器人那端的聲音隨影像串流回來。一台同時只有一人對講（MediaMTX 路徑設 overridePublisher: false）。
 *
 * 方案 B（能力 talk）：按住錄音、放開送出；音檔暫存物件儲存，speak 指令帶 5 分鐘預簽名網址，指令結束即刪。
 */
@Injectable()
export class IntercomService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Intercom');
  /** 按鍵說話：cmdId → 物件儲存的音檔；指令結束（完成、失敗、逾時）就刪 */
  private readonly speakObjects = new Map<string, string>();
  private sub?: Subscription;
  /**
   * 對講被結束（不是自己按掛斷）：通知對講者的瀏覽器（WebSocket talk.ended）。
   * robot_failed：轉接器拉流失敗或中斷；stopped：系統管理員結束。
   */
  readonly ended$ = new Subject<{
    userId: string;
    robotId: string;
    code: string;
    reason: 'robot_failed' | 'stopped';
    /** 誰結束的（顯示名稱）；byUserId 與對講者相同表示本人在別的視窗或裝置結束 */
    by?: string;
    byUserId?: string;
    detail?: string;
  }>();
  /** 進行中的對講（顯示用；是否有人在講以 MediaMTX 路徑是否有推流者為準） */
  private readonly sessions = new Map<string, { userId: string; username: string; since: number }>();

  constructor(
    private readonly registry: RobotRegistry,
    private readonly fleet: FleetService,
    private readonly bus: CommandBus,
    private readonly mtx: MediaMtxClient,
    private readonly streams: StreamsService,
    private readonly storage: StorageService,
    private readonly mqtt: MqttService,
  ) {}

  onModuleInit() {
    // 轉接器回報拉流失敗（PR #15 審查第 3 點）
    this.mqtt.subscribe(topics.event('+'), 1, (topic, payload) => {
      let body: unknown;
      try {
        body = JSON.parse(payload.toString('utf8'));
      } catch {
        return;
      }
      const ev = RobotEvent.safeParse(body);
      if (ev.success && ev.data.type === 'talk_failed') {
        void this.onTalkFailed(topic.split('/')[2], String(ev.data.data?.reason ?? '')).catch((e) => this.log.error(String(e)));
      }
    });
    this.sub = this.bus.results$.subscribe(({ data }) => {
      const key = this.speakObjects.get(data.cmdId);
      if (!key || data.status === 'accepted') return;
      this.speakObjects.delete(data.cmdId);
      void this.storage.remove(key).catch((e) => this.log.warn(`刪除語音檔 ${key} 失敗：${e instanceof Error ? e.message : e}`));
    });
  }

  onModuleDestroy() {
    this.sub?.unsubscribe();
  }

  private async robot(id: string, cap: 'talk' | 'talk_live'): Promise<RobotInfo> {
    const r = await this.registry.resolveId(id);
    if (!r) throw new AppError('NOT_FOUND', '找不到機器人或已停用');
    if (!r.caps.includes(cap)) throw new AppError('INVALID_STATE', `${r.code} 不支援${cap === 'talk_live' ? '即時對講' : '語音播放'}`, { cap });
    if (!this.fleet.get(r.code)?.online) throw new AppError('ROBOT_OFFLINE', `${r.code} 離線中`);
    return r;
  }

  private async publishing(key: string): Promise<boolean> {
    return !!(await this.mtx.paths()).find((p) => p.name === key)?.ready;
  }

  /** 方案 A 第一步：核發推流憑證與 WHIP 位址 */
  async start(robotId: string, actor: Principal) {
    const r = await this.robot(robotId, 'talk_live');
    const key = talkStreamKey(r.code);
    if (!(await this.streams.get(key))) {
      await this.streams.sync();
      if (!(await this.streams.get(key))) throw new AppError('NOT_FOUND', `${r.code} 沒有對講路徑`);
    }
    if (await this.publishing(key)) {
      const s = this.sessions.get(r.code);
      throw new AppError('INVALID_STATE', `${r.code} 正由 ${s?.username ?? '其他人'} 對講中`, { holder: s?.username ?? null });
    }
    const t = issueStreamToken(key, actor.sub, Date.now(), { action: 'publish', ttlSec: PUBLISH_TTL_SEC });
    return { whipUrl: `${mediaConfig().publicUrl}/${key}/whip`, token: t.token, expiresAt: new Date(t.expiresAt).toISOString() };
  }

  /** 方案 A 第二步：瀏覽器推流成功後，叫轉接器開始拉這路音訊 */
  async started(robotId: string, actor: Principal) {
    const r = await this.robot(robotId, 'talk_live');
    const key = talkStreamKey(r.code);
    // WHIP 回應後 MediaMTX 要等 ICE 連上才算有推流者：最多等 5 秒
    let ok = false;
    for (let i = 0; i < 25 && !ok; i++) {
      ok = await this.publishing(key);
      if (!ok) await new Promise((res) => setTimeout(res, 200));
    }
    if (!ok) throw new AppError('INVALID_STATE', '還沒收到控制室的聲音，請確認麥克風與網路後再試');
    // 短憑證：轉接器放在 RTSP 網址的帳密裡（ffmpeg 帳密上限 128 bytes）
    const token = issueShortToken(key, 'read', READ_TTL_SEC);
    const rec = await this.bus.send(r, 'talk_start', { url: `${mediaConfig().adapterRtsp}/${key}`, user: TALK_READER, token }, actor.sub);
    this.sessions.set(r.code, { userId: actor.sub, username: actor.username, since: Date.now() });
    this.log.log(`${r.code} 開始對講（${actor.username}）`);
    return { cmdId: rec.cmdId };
  }

  /**
   * 結束對講：叫轉接器停止；對講者自己的瀏覽器會關掉 WHIP 連線。
   * 只有對講者本人或系統管理員能結束（PR #15 審查第 2 點）；管理員結束別人的對講時踢掉推流者並通知對方。
   */
  async stop(robotId: string, actor: Principal) {
    const r = await this.registry.resolveId(robotId);
    if (!r) throw new AppError('NOT_FOUND', '找不到機器人或已停用');
    const s = this.sessions.get(r.code);
    if (s && s.userId !== actor.sub && !actor.isSystem) {
      throw new AppError('INVALID_STATE', `${r.code} 正由 ${s.username} 對講中，只有對講者本人或系統管理員能結束`, { holder: s.username });
    }
    if (s) {
      // 通知對講者的畫面（系統管理員結束、或本人在別的視窗結束），並踢掉推流：不然那個視窗的麥克風還開著、
      // 路徑一直被佔住。對講者自己按掛斷時畫面已先收掉，收到通知不會再動作；推流也已先結束，踢不到。
      this.ended$.next({ userId: s.userId, robotId: r.id, code: r.code, reason: 'stopped', by: actor.displayName, byUserId: actor.sub });
      await this.mtx.kickPublisher(talkStreamKey(r.code));
    }
    this.sessions.delete(r.code);
    if (this.fleet.get(r.code)?.online) await this.bus.send(r, 'talk_stop', {}, actor.sub).catch(() => undefined);
    this.log.log(`${r.code} 結束對講（${actor.username}）`);
  }

  /** 轉接器拉流失敗或中斷：結束這次對講並通知對講者（不然控制室還以為在講） */
  private async onTalkFailed(code: string, reason: string) {
    const s = this.sessions.get(code);
    const r = this.registry.get(code);
    if (!s || !r) return; // 已經掛斷（瀏覽器先關、轉接器後斷）
    this.sessions.delete(code);
    this.log.warn(`${code} 機器人端對講中斷：${reason || '原因不明'}，結束 ${s.username} 的對講`);
    this.ended$.next({ userId: s.userId, robotId: r.id, code, reason: 'robot_failed', detail: reason });
    await this.mtx.kickPublisher(talkStreamKey(code));
  }

  /** 方案 B：按鍵說話，speak 指令帶音檔 */
  async speak(robotId: string, actor: Principal, audio: { buffer: Buffer; mime: string; durationMs: number }) {
    const r = await this.robot(robotId, 'talk');
    if (!/^audio\/[a-z0-9.+-]+(;.*)?$/i.test(audio.mime)) throw new AppError('VALIDATION_FAILED', '只接受音訊檔', { fields: { file: '格式錯誤' } });
    if (!audio.buffer.length) throw new AppError('VALIDATION_FAILED', '錄音是空的');
    if (audio.buffer.length > SPEAK_MAX_BYTES) throw new AppError('VALIDATION_FAILED', '錄音太大（最多 5 MB）');
    if (!(audio.durationMs > 0 && audio.durationMs <= SPEAK_MAX_MS + 1000)) throw new AppError('VALIDATION_FAILED', '錄音最長 30 秒');
    // 音檔放物件儲存，指令只帶 5 分鐘預簽名網址（PR #15 審查第 1 點：base64 塞進 MQTT 可能超過 EMQX 封包上限，
    // 後端會被斷線，所有機器人的指令、遙測跟著中斷）
    const mime = audio.mime.split(';')[0].toLowerCase();
    const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(new Date()).replace(/-/g, '');
    const key = `${SPEAK_PREFIX}${day}/${randomUUID()}.${EXT[mime] ?? 'bin'}`;
    await this.storage.put(key, audio.buffer, mime);
    const url = await this.storage.presign(key, { ttlSec: SPEAK_URL_TTL_SEC, for: 'adapter' });
    let rec;
    try {
      rec = await this.bus.send(r, 'speak', { audio: { url, mime, bytes: audio.buffer.length, durationMs: Math.round(audio.durationMs) } }, actor.sub);
    } catch (e) {
      await this.storage.remove(key).catch(() => undefined);
      throw e;
    }
    this.speakObjects.set(rec.cmdId, key);
    return { cmdId: rec.cmdId };
  }
}
