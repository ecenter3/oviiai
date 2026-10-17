import { Injectable } from '@nestjs/common';
import { mediaConfig } from './media-config';

export interface MtxPathConf {
  source?: string;
  sourceOnDemand?: boolean;
  runOnDemand?: string;
  runOnDemandRestart?: boolean;
  runOnDemandCloseAfter?: string;
  rtspTransport?: string;
  /** false：已有人推流時拒絕第二個推流者（對講一次一人） */
  overridePublisher?: boolean;
}

export interface MtxPathState {
  name: string;
  ready: boolean;
  readers: unknown[];
  source: { type: string } | null;
}

const TIMEOUT_MS = 3_000;

/** MediaMTX Control API（v3）。路徑名稱可以含 /（cam/CAM-1F-01） */
@Injectable()
export class MediaMtxClient {
  private url(p: string) {
    return `${mediaConfig().api}/v3/${p}`;
  }

  private async call<T>(method: string, p: string, body?: unknown): Promise<T> {
    const r = await fetch(this.url(p), {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!r.ok) throw new Error(`MediaMTX ${method} ${p}：${r.status} ${(await r.text()).slice(0, 200)}`);
    const text = await r.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** 新增或整個取代路徑設定 */
  replacePath(name: string, conf: MtxPathConf) {
    return this.call('POST', `config/paths/replace/${encodePath(name)}`, conf);
  }

  deletePath(name: string) {
    return this.call('DELETE', `config/paths/delete/${encodePath(name)}`);
  }

  async configuredPaths(): Promise<{ name: string; conf: MtxPathConf }[]> {
    const r = await this.call<{ items: ({ name: string } & MtxPathConf)[] }>('GET', 'config/paths/list?itemsPerPage=1000');
    return r.items.map(({ name, ...conf }) => ({ name, conf }));
  }

  async paths(): Promise<MtxPathState[]> {
    const r = await this.call<{ items: MtxPathState[] }>('GET', 'paths/list?itemsPerPage=1000');
    return r.items;
  }

  async ping(): Promise<boolean> {
    try {
      await this.call('GET', 'paths/list?itemsPerPage=1');
      return true;
    } catch {
      return false;
    }
  }
}

/** 每一段各自編碼、保留 / */
const encodePath = (name: string) => name.split('/').map(encodeURIComponent).join('/');
