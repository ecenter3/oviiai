import type { Readable } from 'node:stream';
import { Readable as R } from 'node:stream';

/** e2e 用的物件儲存（CI 沒有 SeaweedFS）：存在記憶體，介面與 StorageService 相同 */
export class FakeStorage {
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();

  async put(key: string, body: Buffer | string, contentType: string) {
    this.objects.set(key, { body: Buffer.from(body), contentType });
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

  async check() {
    return 'ok' as const;
  }
}
