import { readFile } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { Readable as R } from 'node:stream';

/** e2e 用的物件儲存（CI 沒有 SeaweedFS）：存在記憶體，介面與 StorageService 相同 */
export class FakeStorage {
  readonly objects = new Map<string, { body: Buffer; contentType: string; at: Date }>();

  async put(key: string, body: Buffer | string, contentType: string) {
    this.objects.set(key, { body: Buffer.from(body), contentType, at: new Date() });
  }

  async putFile(key: string, file: string, contentType: string) {
    this.objects.set(key, { body: await readFile(file), contentType, at: new Date() });
  }

  async get(key: string): Promise<{ body: Readable; contentType: string | undefined; length: number | undefined }> {
    const o = this.objects.get(key);
    if (!o) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
    return { body: R.from(o.body), contentType: o.contentType, length: o.body.length };
  }

  async getBuffer(key: string) {
    const o = this.objects.get(key);
    if (!o) throw new Error('NoSuchKey');
    return o.body;
  }

  async remove(key: string) {
    this.objects.delete(key);
  }

  async presign(key: string, opts: { filename?: string; ttlSec?: number; for?: 'browser' | 'adapter' } = {}) {
    const host = opts.for === 'adapter' ? 'fake-s3-adapter' : 'fake-s3';
    return `http://${host}/${key}?signed=1&ttl=${opts.ttlSec ?? 300}${opts.filename ? `&dl=${encodeURIComponent(opts.filename)}` : ''}`;
  }

  async list(prefix: string) {
    return [...this.objects].filter(([k]) => k.startsWith(prefix)).map(([key, o]) => ({ key, lastModified: o.at }));
  }

  async check() {
    return 'ok' as const;
  }
}
