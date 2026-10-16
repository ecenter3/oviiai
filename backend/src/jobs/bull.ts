import type { ConnectionOptions } from 'bullmq';

/**
 * BullMQ 連線（工程開發手冊：Redis 排程佇列）。BullMQ 自帶 ioredis，給連線參數讓它自己建立連線。
 * BULL_PREFIX 區隔不同環境（e2e 測試各用自己的前綴，不會被開著的開發後端搶走工作）。
 */
export function bullConnection(): ConnectionOptions {
  const u = new URL(process.env.REDIS_URL || 'redis://localhost:6379');
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    username: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    db: u.pathname.length > 1 ? Number(u.pathname.slice(1)) : 0,
    maxRetriesPerRequest: null,
  };
}

export const bullPrefix = () => process.env.BULL_PREFIX || 'rms';

/**
 * 關閉 worker 與 queue，最多等 graceMs：正在跑的工作有機會做完，但關機不會被卡住
 * （docker stop、測試結束時）。逾時就強制關閉，沒做完的工作下次啟動由 BullMQ 重新處理。
 */
export async function closeBull(worker: { close(force?: boolean): Promise<void> } | undefined, queue: { close(): Promise<void> } | undefined, graceMs = 3_000): Promise<void> {
  if (worker) {
    let timer: NodeJS.Timeout | undefined;
    const graceful = worker.close().then(() => true);
    const timeout = new Promise<boolean>((r) => (timer = setTimeout(() => r(false), graceMs)));
    const ok = await Promise.race([graceful, timeout]);
    clearTimeout(timer);
    if (!ok) await worker.close(true).catch(() => undefined);
  }
  await queue?.close().catch(() => undefined);
}
