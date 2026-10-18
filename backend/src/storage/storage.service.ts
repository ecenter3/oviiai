import { CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createReadStream } from 'node:fs';
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
  /**
   * 預簽名網址給瀏覽器直接下載（介面規格 GET /media/:id/url）：簽在瀏覽器連得到的位址（S3_PUBLIC_ENDPOINT，
   * 正式環境經 Nginx），簽名包含主機名稱，所以要用這個位址簽，不能簽完再換。
   */
  private readonly publicS3 = new S3Client({
    endpoint: process.env.S3_PUBLIC_ENDPOINT || process.env.S3_ENDPOINT || 'http://localhost:8333',
    region: process.env.S3_REGION || 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: process.env.S3_ACCESS_KEY || '', secretAccessKey: process.env.S3_SECRET_KEY || '' },
  });
  /**
   * 轉接器下載用的預簽名網址（按鍵說話的音檔；PR #15 審查第 1 點）：簽在轉接器主機連得到的位址。
   * S3_ADAPTER_ENDPOINT 沒設就用 S3_ENDPOINT（轉接器與後端同一台）。
   */
  private readonly adapterS3 = new S3Client({
    endpoint: process.env.S3_ADAPTER_ENDPOINT || process.env.S3_ENDPOINT || 'http://localhost:8333',
    region: process.env.S3_REGION || 'us-east-1',
    forcePathStyle: true,
    // 預簽名 PUT（日誌上傳）：SDK 預設把「空內容」的 checksum 簽進網址，轉接器上傳實際內容時 SeaweedFS 回 400 BadDigest（實測）
    requestChecksumCalculation: 'WHEN_REQUIRED',
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
    this.publicS3.destroy();
    this.adapterS3.destroy();
  }

  /** 預簽名網址（預設 5 分鐘）；filename 給了就以附件下載；for: 'adapter' 簽給轉接器（S3_ADAPTER_ENDPOINT） */
  async presign(key: string, opts: { filename?: string; ttlSec?: number; for?: 'browser' | 'adapter' } = {}): Promise<string> {
    const cmd = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ...(opts.filename && { ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(opts.filename)}` }),
    });
    return getSignedUrl(opts.for === 'adapter' ? this.adapterS3 : this.publicS3, cmd, { expiresIn: opts.ttlSec ?? 300 });
  }

  /** 給轉接器上傳用的預簽名 PUT 網址（日誌上傳；T-42），簽在轉接器連得到的位址 */
  async presignPut(key: string, opts: { ttlSec?: number; contentType?: string } = {}): Promise<string> {
    await this.ready;
    const cmd = new PutObjectCommand({ Bucket: this.bucket, Key: key, ...(opts.contentType && { ContentType: opts.contentType }) });
    return getSignedUrl(this.adapterS3, cmd, { expiresIn: opts.ttlSec ?? 900 });
  }

  /** 物件大小；不存在回 null */
  async size(key: string): Promise<number | null> {
    try {
      const r = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return r.ContentLength ?? 0;
    } catch {
      return null;
    }
  }

  async put(key: string, body: Buffer | string, contentType: string): Promise<void> {
    await (this.ready ??= this.ensureBucket());
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
  }

  /**
   * 上傳本機檔案：串流分段上傳（每段 8 MB、同時 2 段），不把整個檔案讀進記憶體
   * （600 秒錄影約 300 MB；PR #12 審查第 2 點）。
   */
  async putFile(key: string, file: string, contentType: string): Promise<void> {
    await (this.ready ??= this.ensureBucket());
    const up = new Upload({
      client: this.s3,
      params: { Bucket: this.bucket, Key: key, Body: createReadStream(file), ContentType: contentType },
      partSize: 8 * 1024 * 1024,
      queueSize: 2,
      leavePartsOnError: false,
    });
    await up.done();
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

  /** 列出前綴下的物件（保存期限清理用） */
  async list(prefix: string): Promise<{ key: string; lastModified: Date }[]> {
    const out: { key: string; lastModified: Date }[] = [];
    let token: string | undefined;
    do {
      const r = await this.s3.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }));
      for (const o of r.Contents ?? []) if (o.Key) out.push({ key: o.Key, lastModified: o.LastModified ?? new Date(0) });
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return out;
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
