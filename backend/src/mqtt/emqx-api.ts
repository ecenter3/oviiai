import { Injectable, Logger } from '@nestjs/common';

/**
 * EMQX 管理 API（只用來踢連線）。金鑰由 EMQX 啟動時的 api_key.bootstrap_file 建立（dev compose、deploy.md 第 10 節）。
 * 沒設定 EMQX_API_KEY／EMQX_API_SECRET 時不踢，啟動時警告一次。
 */
@Injectable()
export class EmqxApi {
  private readonly log = new Logger('EmqxApi');
  private readonly base = (process.env.EMQX_API_URL ?? 'http://localhost:18083/api/v5').replace(/\/$/, '');
  private readonly auth =
    process.env.EMQX_API_KEY && process.env.EMQX_API_SECRET ? `Basic ${Buffer.from(`${process.env.EMQX_API_KEY}:${process.env.EMQX_API_SECRET}`).toString('base64')}` : null;
  private warned = false;

  get configured(): boolean {
    return !!this.auth;
  }

  /** 踢掉一個連線（clean session，訂閱一併清掉）；不在線回 false */
  async kick(clientId: string): Promise<boolean> {
    if (!this.auth) {
      if (!this.warned) this.log.warn('沒有設定 EMQX_API_KEY／EMQX_API_SECRET，機器人改派轉接器時無法立即踢掉舊轉接器的連線');
      this.warned = true;
      return false;
    }
    const r = await fetch(`${this.base}/clients/${encodeURIComponent(clientId)}`, { method: 'DELETE', headers: { Authorization: this.auth }, signal: AbortSignal.timeout(5000) });
    if (r.status === 404) return false;
    if (!r.ok) throw new Error(`EMQX API ${r.status}`);
    return true;
  }
}

/** 轉接器的 MQTT client id（adapters/common/bridge.py 用同樣的格式） */
export const adapterClientId = (name: string) => `adapter-${name}`;
