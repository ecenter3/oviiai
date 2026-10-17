import { Injectable, Logger } from '@nestjs/common';
import type { Principal } from '../auth/principal';
import { CommandBus } from '../commands/command-bus.service';
import { AppError } from '../common/errors';
import { FleetService } from '../fleet/fleet.service';
import { RobotRegistry } from '../fleet/robot-registry';
import type { RobotInfo } from '../fleet/types';
import { mediaConfig } from '../media/media-config';
import { MediaMtxClient } from '../media/mediamtx.client';
import { issueShortToken, issueStreamToken } from '../media/stream-token';
import { StreamsService, TALK_READER, talkStreamKey } from '../media/streams.service';

/** 按鍵說話（方案 B）的錄音上限 */
export const SPEAK_MAX_MS = 30_000;
export const SPEAK_MAX_BYTES = 1024 * 1024;
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
 * 方案 B（能力 talk）：按住錄音、放開送出，speak 指令帶音檔（base64，最長 30 秒、1 MB）。音檔不留存。
 */
@Injectable()
export class IntercomService {
  private readonly log = new Logger('Intercom');
  /** 進行中的對講（顯示用；是否有人在講以 MediaMTX 路徑是否有推流者為準） */
  private readonly sessions = new Map<string, { userId: string; username: string; since: number }>();

  constructor(
    private readonly registry: RobotRegistry,
    private readonly fleet: FleetService,
    private readonly bus: CommandBus,
    private readonly mtx: MediaMtxClient,
    private readonly streams: StreamsService,
  ) {}

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

  /** 結束對講：叫轉接器停止；瀏覽器自己關掉 WHIP 連線 */
  async stop(robotId: string, actor: Principal) {
    const r = await this.registry.resolveId(robotId);
    if (!r) throw new AppError('NOT_FOUND', '找不到機器人或已停用');
    this.sessions.delete(r.code);
    if (this.fleet.get(r.code)?.online) await this.bus.send(r, 'talk_stop', {}, actor.sub).catch(() => undefined);
    this.log.log(`${r.code} 結束對講（${actor.username}）`);
  }

  /** 方案 B：按鍵說話，speak 指令帶音檔 */
  async speak(robotId: string, actor: Principal, audio: { buffer: Buffer; mime: string; durationMs: number }) {
    const r = await this.robot(robotId, 'talk');
    if (!/^audio\/[a-z0-9.+-]+(;.*)?$/i.test(audio.mime)) throw new AppError('VALIDATION_FAILED', '只接受音訊檔', { fields: { file: '格式錯誤' } });
    if (!audio.buffer.length) throw new AppError('VALIDATION_FAILED', '錄音是空的');
    if (audio.buffer.length > SPEAK_MAX_BYTES) throw new AppError('VALIDATION_FAILED', '錄音太大（最多 1 MB）');
    if (!(audio.durationMs > 0 && audio.durationMs <= SPEAK_MAX_MS + 1000)) throw new AppError('VALIDATION_FAILED', '錄音最長 30 秒');
    const rec = await this.bus.send(
      r,
      'speak',
      { audio: { mime: audio.mime.split(';')[0], data: audio.buffer.toString('base64'), durationMs: Math.round(audio.durationMs) } },
      actor.sub,
    );
    return { cmdId: rec.cmdId };
  }
}
