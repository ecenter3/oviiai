import Redis from 'ioredis';
import type { Database } from '../src/db/database.module';

/**
 * 測試結束清掉「機器人已刪除、還在等回覆」的指令（cmd:pending）。測試機器人上線時後端會自動送 set_params，
 * 沒有轉接器回覆；測試在 15 秒逾時前就結束，指令留在 Redis，下次後端啟動時才判逾時（看起來像有殘留的機器人）。
 * 在刪掉測試機器人之後、db.destroy() 之前呼叫。別的測試檔還在用的機器人不受影響。
 */
export async function clearOrphanPendingCommands(db: Database): Promise<void> {
  if (!process.env.REDIS_URL) return;
  const redis = new Redis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
  try {
    await redis.connect();
    const ids = await redis.zrange('cmd:pending', '0', '-1');
    if (!ids.length) return;
    const recs = await redis.mget(ids.map((id) => `cmd:${id}`));
    const byRobot = new Map<string, string[]>();
    recs.forEach((raw, i) => {
      const robotId = raw ? (JSON.parse(raw) as { robotId: string }).robotId : null;
      if (robotId) byRobot.set(robotId, [...(byRobot.get(robotId) ?? []), ids[i]]);
    });
    if (!byRobot.size) return;
    const alive = new Set((await db.selectFrom('robots').select('id').where('id', 'in', [...byRobot.keys()]).execute()).map((r) => r.id));
    const orphan = [...byRobot].filter(([id]) => !alive.has(id)).flatMap(([, cmds]) => cmds);
    if (orphan.length) await redis.multi().zrem('cmd:pending', ...orphan).del(...orphan.map((id) => `cmd:${id}`)).exec();
  } finally {
    redis.disconnect();
  }
}
