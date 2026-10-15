import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from 'kysely';
import { describe, expect, it } from 'vitest';
import type { DB } from '../db/types';
import type { MqttService } from '../mqtt/mqtt.service';
import { HealthController } from './health.controller';

// 不連資料庫的 Kysely：DummyDriver 對任何查詢回空結果
const db = new Kysely<DB>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (k) => new PostgresIntrospector(k),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});

describe('HealthController', () => {
  it('列出每個相依服務；任一 down 就是 degraded', async () => {
    const redis = { ping: async () => 'PONG' } as never;
    const ok = await new HealthController(db, redis, { connected: true } as MqttService).check();
    expect(Object.keys(ok.checks).sort()).toEqual(['db', 'mediamtx', 'mqtt', 'redis', 's3']);
    expect(ok).toMatchObject({ status: 'ok', checks: { db: 'ok', redis: 'ok', mqtt: 'ok' } });

    const downRedis = { ping: async () => Promise.reject(new Error('ECONNREFUSED')) } as never;
    const bad = await new HealthController(db, downRedis, { connected: false } as MqttService).check();
    expect(bad).toMatchObject({ status: 'degraded', checks: { redis: 'down', mqtt: 'down' } });
  });
});
