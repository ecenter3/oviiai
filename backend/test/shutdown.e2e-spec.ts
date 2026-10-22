/**
 * 關閉後端時要等背景那一輪跑完、放掉 Redis 鎖（PR #19 審查第 2 點）。
 * 原本關閉時不等：那一輪在資料庫、Redis 關掉後繼續跑，鎖放不掉，下一個啟動的後端要等 TTL（10 秒）過期。
 * 充電排程 e2e 偶發「拿不到 charge:lock」就是上一個測試程序留下的鎖（鎖的值顯示是另一個 pid 的 tick-bg）。
 */
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type Redis from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { ChargingService } from '../src/charging/charging.service';
import { loadEnv } from '../src/config';
import { DispatchService } from '../src/dispatch/dispatch.service';
import { REDIS } from '../src/redis/redis.module';

loadEnv();
const ready = !!(process.env.DATABASE_URL && process.env.REDIS_URL && process.env.MQTT_URL);
const FLOOR = `z${Date.now().toString(36).slice(-6)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(fn: () => T | Promise<T>, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('等待逾時');
    await sleep(20);
  }
}

async function boot() {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = mod.createNestApplication<NestExpressApplication>();
  configureApp(app);
  await app.listen(0);
  return app;
}

describe.skipIf(!ready)('關閉時放掉背景排程的鎖（e2e）', () => {
  let probe: Redis | undefined;
  afterAll(async () => {
    await probe?.del('charge:lock', `dispatch:${FLOOR}`);
    probe?.disconnect();
  });

  it('充電排程：背景那一輪拿著 charge:lock 時關閉，等它跑完並放掉鎖', async () => {
    const app = await boot();
    probe = app.get<Redis>(REDIS).duplicate();
    const charging = app.get(ChargingService) as unknown as { tickLocked(): Promise<void> };
    let finished = false;
    // 讓背景那一輪跑 1.5 秒，確定關閉時它還拿著鎖
    charging.tickLocked = async () => {
      await sleep(1500);
      finished = true;
    };
    await until(async () => (await probe!.get('charge:lock'))?.startsWith(`tick-bg:${process.pid}:`));
    await app.close();
    expect(finished).toBe(true);
    expect(await probe.get('charge:lock')).toBeNull();
  });

  it('派工：某樓層那一輪拿著 dispatch 鎖時關閉，等它跑完並放掉鎖', async () => {
    const app = await boot();
    const dispatch = app.get(DispatchService) as unknown as { round(floor: string): Promise<number>; schedule(floor: string): void };
    let finished = false;
    dispatch.round = async () => {
      await sleep(1500);
      finished = true;
      return 0;
    };
    dispatch.schedule(FLOOR);
    await until(async () => !!(await probe!.get(`dispatch:${FLOOR}`)));
    await app.close();
    expect(finished).toBe(true);
    expect(await probe!.get(`dispatch:${FLOOR}`)).toBeNull();
  });
});
