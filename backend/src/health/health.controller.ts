import { Controller, Get, Inject, Optional } from '@nestjs/common';
import type Redis from 'ioredis';
import { sql } from 'kysely';
import { Public } from '../auth/public.decorator';
import { KYSELY, type Database } from '../db/database.module';
import { MqttService } from '../mqtt/mqtt.service';
import { REDIS } from '../redis/redis.module';
import { StorageService } from '../storage/storage.service';

type Check = 'ok' | 'down' | 'unknown';

export interface HealthReport {
  status: 'ok' | 'degraded';
  ts: number;
  checks: Record<string, Check>;
}

const TIMEOUT_MS = 1500;

async function probe(fn: () => Promise<unknown>): Promise<Check> {
  try {
    await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), TIMEOUT_MS))]);
    return 'ok';
  } catch {
    return 'down';
  }
}

@Controller('health')
export class HealthController {
  constructor(
    @Inject(KYSELY) private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly mqtt: MqttService,
    @Optional() private readonly storage?: StorageService,
  ) {}

  // mediamtx、各轉接器心跳在對應模組（T-29）接上
  @Public()
  @Get()
  async check(): Promise<HealthReport> {
    const [db, redis, s3] = await Promise.all([
      probe(() => sql`select 1`.execute(this.db)),
      probe(() => this.redis.ping()),
      this.storage ? probe(async () => ((await this.storage!.check()) === 'ok' ? undefined : Promise.reject(new Error('s3')))) : Promise.resolve<Check>('unknown'),
    ]);
    const checks: Record<string, Check> = {
      db,
      redis,
      mqtt: this.mqtt.connected ? 'ok' : 'down',
      s3,
      mediamtx: 'unknown',
    };
    const status = Object.values(checks).includes('down') ? 'degraded' : 'ok';
    return { status, ts: Date.now(), checks };
  }
}
