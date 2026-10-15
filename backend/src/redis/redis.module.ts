import { Global, Inject, Injectable, Logger, Module, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

export const REDIS = Symbol('REDIS');

export function createRedis(url = process.env.REDIS_URL ?? 'redis://localhost:6379'): Redis {
  const log = new Logger('Redis');
  // 連不上時自動重試；指令在離線期間排隊，不讓啟動失敗（Redis 重啟時機器人狀態數秒內恢復，見技術設計 D8）
  const r = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 3 });
  let warned = false;
  r.on('error', (e) => {
    if (!warned) log.warn(`Redis 連線錯誤：${e.message}（持續重試中）`);
    warned = true;
  });
  r.on('ready', () => {
    if (warned) log.log('Redis 已重新連線');
    warned = false;
  });
  return r;
}

@Injectable()
class RedisCloser implements OnModuleDestroy {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}
  async onModuleDestroy() {
    this.redis.disconnect();
  }
}

@Global()
@Module({
  providers: [{ provide: REDIS, useFactory: () => createRedis() }, RedisCloser],
  exports: [REDIS],
})
export class RedisModule {}
