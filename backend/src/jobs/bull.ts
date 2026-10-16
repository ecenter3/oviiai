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
