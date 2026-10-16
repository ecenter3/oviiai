import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { KYSELY, type Database } from '../db/database.module';
import { FleetService } from '../fleet/fleet.service';

/** 系統規格書 §4.1 統計卡：線上／巡邏中／充電中／故障台數、今日任務數、未處理告警數 */
export interface Stats {
  ts: number;
  total: number;
  online: number;
  /** 執行任務中：導航或巡邏 */
  working: number;
  charging: number;
  /** 故障或急停 */
  fault: number;
  todayTasks: number;
  openAlarms: number;
}

const WORKING = new Set(['navigating', 'patrolling']);
const FAULT = new Set(['fault', 'estop']);

@Injectable()
export class StatsService {
  constructor(
    private readonly fleet: FleetService,
    @Inject(KYSELY) private readonly db: Database,
  ) {}

  async compute(): Promise<Stats> {
    const all = this.fleet.all();
    const online = all.filter((r) => r.online);
    // 「今日」以台北時間計
    const [tasks, alarms] = await Promise.all([
      this.db
        .selectFrom('tasks')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('created_at', '>=', sql<Date>`date_trunc('day', now() AT TIME ZONE 'Asia/Taipei') AT TIME ZONE 'Asia/Taipei'`)
        .executeTakeFirstOrThrow(),
      this.db
        .selectFrom('alarms')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('status', 'in', ['review', 'open', 'handling'])
        .executeTakeFirstOrThrow(),
    ]);
    return {
      ts: Date.now(),
      total: all.length,
      online: online.length,
      working: online.filter((r) => WORKING.has(r.state)).length,
      charging: online.filter((r) => r.state === 'charging' || r.charging).length,
      fault: online.filter((r) => FAULT.has(r.state)).length,
      todayTasks: Number(tasks.n),
      openAlarms: Number(alarms.n),
    };
  }
}
