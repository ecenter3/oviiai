import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { sql } from 'kysely';
import { KYSELY, type Database } from '../db/database.module';
import { bullConnection, bullPrefix, closeBull } from '../jobs/bull';

const QUEUE = 'stats';
/** 每天台北時間 00:15 算前一天 */
const DAILY = { pattern: '15 0 * * *', tz: 'Asia/Taipei' };
/** 里程：兩筆遙測間超過這個速度視為跳點（重新定位、校正），不計入（同任務報告） */
const MAX_SPEED_MPS = 3;

export interface DayRobotStats {
  day: string;
  robotId: string;
  distanceM: number;
  busyS: number;
  chargingS: number;
  idleS: number;
  faultS: number;
  offlineS: number;
}

/** 狀態歸類：稼動（執行任務、移動中）、充電、待命、故障、離線 */
const BUCKET: Record<string, 'busy' | 'charging' | 'idle' | 'fault' | 'offline'> = {
  navigating: 'busy',
  patrolling: 'busy',
  returning: 'busy',
  teleop: 'busy',
  charging: 'charging',
  idle: 'idle',
  paused: 'idle',
  fault: 'fault',
  estop: 'fault',
  offline: 'offline',
};

/** 台北日期（YYYY-MM-DD）的起點 */
export const dayStart = (day: string) => new Date(`${day}T00:00:00+08:00`);
export const taipeiDay = (d: Date | number = Date.now()) =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(d));
export const addDay = (day: string, n: number) => taipeiDay(dayStart(day).getTime() + n * 86400_000 + 12 * 3600_000);

/**
 * T-40 每台每天的里程與狀態時長。過去的日子算好存在 robot_daily_stats（每日 00:15 排程算前一天，查詢時缺的補算），
 * 今天的即時計算、不存——原始遙測每台每秒一筆，跨月統計不能每次重掃。
 */
@Injectable()
export class DailyStatsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('DailyStats');
  private queue?: Queue;
  private worker?: Worker;

  constructor(@Inject(KYSELY) private readonly db: Database) {}

  async onModuleInit() {
    const connection = bullConnection();
    this.queue = new Queue(QUEUE, { connection, prefix: bullPrefix() });
    this.worker = new Worker(QUEUE, async () => this.ensure([addDay(taipeiDay(), -1)]), { connection, prefix: bullPrefix() });
    this.worker.on('failed', (_j, e) => this.log.error(`每日統計失敗：${e.message}`));
    await this.queue.upsertJobScheduler('daily-stats', DAILY, { name: 'daily-stats' }).catch((e) => this.log.error(`排程建立失敗：${e}`));
  }

  async onModuleDestroy() {
    await closeBull(this.worker, this.queue);
  }

  /** 取得這些日子、這些機器人的統計：過去缺的先算好存起來，今天即時算 */
  async get(days: string[], robotIds: string[]): Promise<DayRobotStats[]> {
    if (!days.length || !robotIds.length) return [];
    const today = taipeiDay();
    const past = days.filter((d) => d < today);
    await this.ensure(past, robotIds);
    const stored = past.length
      ? await this.db.selectFrom('robot_daily_stats').selectAll().where('day', 'in', past).where('robot_id', 'in', robotIds).execute()
      : [];
    const out: DayRobotStats[] = stored.map((r) => ({
      day: r.day, // DATE 型別原樣回傳字串（database.module）
      robotId: r.robot_id,
      distanceM: r.distance_m,
      busyS: r.busy_s,
      chargingS: r.charging_s,
      idleS: r.idle_s,
      faultS: r.fault_s,
      offlineS: r.offline_s,
    }));
    if (days.includes(today)) out.push(...(await this.compute(today)).filter((r) => robotIds.includes(r.robotId)));
    return out;
  }

  /**
   * 過去的日子：（日期、機器人）還沒算過的就算好存起來。一天一次查詢算所有機器人，只寫缺的那幾台；
   * 沒有活動的機器人也寫一筆 0，下次不必重算。robotIds 省略＝所有登記的機器人（每日排程）。
   */
  async ensure(days: string[], robotIds?: string[]): Promise<number> {
    const today = taipeiDay();
    const want = [...new Set(days.filter((d) => d < today))];
    if (!want.length) return 0;
    const ids = robotIds ?? (await this.db.selectFrom('robots').select('id').execute()).map((r) => r.id);
    if (!ids.length) return 0;
    const have = new Set(
      (await this.db.selectFrom('robot_daily_stats').select(['day', 'robot_id']).where('day', 'in', want).where('robot_id', 'in', ids).execute()).map(
        (r) => `${r.day}|${r.robot_id}`,
      ),
    );
    let n = 0;
    for (const day of want) {
      const missing = ids.filter((id) => !have.has(`${day}|${id}`));
      if (!missing.length) continue;
      const got = new Map((await this.compute(day)).map((r) => [r.robotId, r]));
      const zero = (robotId: string): DayRobotStats => ({ day, robotId, distanceM: 0, busyS: 0, chargingS: 0, idleS: 0, faultS: 0, offlineS: 0 });
      await this.db
        .insertInto('robot_daily_stats')
        .values(
          missing
            .map((id) => got.get(id) ?? zero(id))
            .map((r) => ({
              day: r.day,
              robot_id: r.robotId,
              distance_m: r.distanceM,
              busy_s: r.busyS,
              charging_s: r.chargingS,
              idle_s: r.idleS,
              fault_s: r.faultS,
              offline_s: r.offlineS,
            })),
        )
        .onConflict((oc) => oc.columns(['day', 'robot_id']).doNothing())
        .execute();
      n++;
    }
    if (n) this.log.log(`補算 ${n} 天的機器人統計`);
    return n;
  }

  /** 算一天（台北日期）所有機器人的里程與各狀態秒數；今天算到現在 */
  async compute(day: string): Promise<DayRobotStats[]> {
    const from = dayStart(day);
    const to = new Date(Math.min(dayStart(addDay(day, 1)).getTime(), Date.now()));
    if (to <= from) return [];
    const [states, dist] = await Promise.all([
      sql<{ robot_id: string; state: string; secs: number }>`
        WITH l AS (
          SELECT robot_id, state, at FROM robot_state_log WHERE at >= ${from} AND at < ${to}
          UNION ALL
          SELECT r.id, x.state, ${from}::timestamptz FROM robots r
          CROSS JOIN LATERAL (SELECT state FROM robot_state_log WHERE robot_id = r.id AND at < ${from} ORDER BY at DESC LIMIT 1) x
        ), seg AS (
          SELECT robot_id, state, at, coalesce(lead(at) OVER (PARTITION BY robot_id ORDER BY at), ${to}::timestamptz) AS nxt FROM l
        )
        SELECT robot_id, state, sum(extract(epoch FROM nxt - at))::float AS secs FROM seg GROUP BY robot_id, state`.execute(this.db),
      sql<{ robot_id: string; m: number }>`
        SELECT robot_id, sum(d)::float AS m FROM (
          SELECT robot_id, sqrt(power(x - lag(x) OVER w, 2) + power(y - lag(y) OVER w, 2)) AS d,
                 extract(epoch FROM at - lag(at) OVER w) AS dt
          FROM telemetry WHERE at >= ${from} AND at < ${to} AND x IS NOT NULL
          WINDOW w AS (PARTITION BY robot_id ORDER BY at)) s
        WHERE d IS NOT NULL AND dt > 0 AND d / dt <= ${MAX_SPEED_MPS}
        GROUP BY robot_id`.execute(this.db),
    ]);
    const by = new Map<string, DayRobotStats>();
    const get = (id: string) => {
      let r = by.get(id);
      if (!r) by.set(id, (r = { day, robotId: id, distanceM: 0, busyS: 0, chargingS: 0, idleS: 0, faultS: 0, offlineS: 0 }));
      return r;
    };
    for (const s of states.rows) {
      const b = BUCKET[s.state] ?? 'idle';
      const r = get(s.robot_id);
      const k = `${b}S` as 'busyS';
      r[k] += Math.round(s.secs);
    }
    for (const d of dist.rows) get(d.robot_id).distanceM = Math.round(d.m * 10) / 10;
    // 狀態紀錄、遙測沒有外鍵：已刪除的機器人（例：測試）留下的紀錄不算
    const alive = new Set((await this.db.selectFrom('robots').select('id').execute()).map((r) => r.id));
    return [...by.values()].filter((r) => alive.has(r.robotId));
  }
}
