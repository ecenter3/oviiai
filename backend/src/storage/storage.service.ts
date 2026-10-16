import { CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Readable } from 'node:stream';

/**
 * 物件儲存（SeaweedFS，S3 相容；docs/spec/README.md：取代手冊的 MinIO）。
 * 平面圖、保存期限到期前的 CSV 備查檔等。啟動時建立 bucket（已存在就略過）；連不上只記錄，不影響啟動。
 */
@Injectable()
export class StorageService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Storage');
  private readonly bucket = process.env.S3_BUCKET || 'rms';
  private readonly s3 = new S3Client({
    endpoint: process.env.S3_ENDPOINT || 'http://localhost:8333',
    region: process.env.S3_REGION || 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: process.env.S3_ACCESS_KEY || '', secretAccessKey: process.env.S3_SECRET_KEY || '' },
  });
  private ready: Promise<void> | null = null;

  onModuleInit() {
    this.ready = this.ensureBucket().catch((e) => {
      this.ready = null;
      this.log.warn(`物件儲存尚未就緒：${e instanceof Error ? e.message : e}`);
    });
  }

  onModuleDestroy() {
    this.s3.destroy();
  }

  async put(key: string, body: Buffer | string, contentType: string): Promise<void> {
    await (this.ready ??= this.ensureBucket());
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
  }

  async get(key: string): Promise<{ body: Readable; contentType: string | undefined; length: number | undefined }> {
    const r = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return { body: r.Body as Readable, contentType: r.ContentType, length: r.ContentLength };
  }

  async getBuffer(key: string): Promise<Buffer> {
    const { body } = await this.get(key);
    const chunks: Buffer[] = [];
    for await (const c of body) chunks.push(Buffer.from(c as Uint8Array));
    return Buffer.concat(chunks);
  }

  async remove(key: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  /** 健康檢查 */
  async check(): Promise<'ok' | 'error'> {
    try {
      await this.s3.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return 'ok';
    } catch {
      return 'error';
    }
  }

  private async ensureBucket() {
    try {
      await this.s3.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      await this.s3.send(new CreateBucketCommand({ Bucket: this.bucket })).catch((e: { name?: string }) => {
        if (e.name !== 'BucketAlreadyOwnedByYou' && e.name !== 'BucketAlreadyExists') throw e;
      });
    }
  }
}
