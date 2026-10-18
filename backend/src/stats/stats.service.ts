import { Inject, Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { sql } from 'kysely';
import { AppError } from '../common/errors';
import { KYSELY, type Database } from '../db/database.module';
import { addDay, dayStart, DailyStatsService, taipeiDay } from './daily-stats.service';

export interface StatsQuery {
  from: string;
  to: string;
  floorId?: string;
  robotId?: string;
}

export interface StatsDay {
  date: string;
  tasksDone: number;
  tasksFailed: number;
  tasksCancelled: number;
  alarmsBusiness: number;
  alarmsSystem: number;
  talks: number;
  distanceM: number;
  busyH: number;
  chargingH: number;
  idleH: number;
  faultH: number;
  offlineH: number;
  /** 稼動率：執行任務、移動中的時間 ÷ 有紀錄的時間 */
  utilization: number | null;
}

export interface StatsRobot {
  id: string;
  code: string;
  floorId: string;
  tasksDone: number;
  distanceM: number;
  busyH: number;
  utilization: number | null;
  availability: number | null;
}

/** 單次統計最多一年 */
const MAX_DAYS = 366;
const H = (s: number) => Math.round((s / 3600) * 100) / 100;
const ratio = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);

/**
 * T-40 數據統計（介面規格 GET /stats/summary）：任務量、告警量、遠端對講、里程、各狀態時長與稼動率、可用率，
 * 依日期區間（台北日期）、樓層、機器人篩選；同樣的資料可匯出 Excel。
 */
@Injectable()
export class StatsService {
  constructor(
    @Inject(KYSELY) private readonly db: Database,
    private readonly daily: DailyStatsService,
  ) {}

  async summary(q: StatsQuery) {
    const days = dayList(q.from, q.to);
    const from = dayStart(q.from);
    const to = dayStart(addDay(q.to, 1));
    let rq = this.db.selectFrom('robots').select(['id', 'code', 'floor_id']).orderBy('code');
    if (q.floorId) rq = rq.where('floor_id', '=', q.floorId);
    if (q.robotId) rq = rq.where('id', '=', q.robotId);
    const robots = await rq.execute();
    if (q.robotId && !robots.length) throw new AppError('NOT_FOUND', '找不到機器人');
    const ids = robots.map((r) => r.id);
    const tz = sql.lit('Asia/Taipei');

    // 機器人篩選（任務、告警、對講都可依樓層或機器人）
    const robotFilter = q.robotId ? sql`= ${q.robotId}` : null;
    const [tasks, alarms, talks, robotStats, schedules] = await Promise.all([
      sql<{ d: string; status: string; robot_id: string | null; n: number }>`
        SELECT (ended_at AT TIME ZONE ${tz})::date::text AS d, status, robot_id, count(*)::int AS n FROM tasks
        WHERE ended_at >= ${from} AND ended_at < ${to} AND status IN ('done', 'failed', 'cancelled')
          ${q.floorId ? sql`AND floor_id = ${q.floorId}` : sql``} ${robotFilter ? sql`AND robot_id ${robotFilter}` : sql``}
        GROUP BY 1, 2, 3`.execute(this.db),
      sql<{ d: string; category: string; status: string; n: number }>`
        SELECT (occurred_at AT TIME ZONE ${tz})::date::text AS d, category, status, count(*)::int AS n FROM alarms
        WHERE occurred_at >= ${from} AND occurred_at < ${to}
          ${q.floorId ? sql`AND floor_id = ${q.floorId}` : sql``} ${robotFilter ? sql`AND robot_id ${robotFilter}` : sql``}
        GROUP BY 1, 2, 3`.execute(this.db),
      ids.length
        ? sql<{ d: string; n: number }>`
            SELECT (at AT TIME ZONE ${tz})::date::text AS d, count(*)::int AS n FROM op_logs
            WHERE at >= ${from} AND at < ${to} AND action IN ('robot.talk_start', 'robot.speak') AND (detail->>'ok')::boolean IS NOT FALSE
              AND target IN (${sql.join(ids.map((id) => `robot:${id}`))})
            GROUP BY 1`.execute(this.db)
        : Promise.resolve({ rows: [] as { d: string; n: number }[] }),
      this.daily.get(days, ids),
      this.db
        .selectFrom('patrol_schedules as s')
        .leftJoin('paths as p', 'p.id', 's.path_id')
        .leftJoin('robots as r', 'r.id', 's.robot_id')
        .select(['s.id', 's.name', 's.start_time', 's.repeat', 's.enabled', 'p.floor_id', 'p.name as path_name', 'r.code as robot_code'])
        .$if(!!q.floorId, (qb) => qb.where('p.floor_id', '=', q.floorId!))
        .$if(!!q.robotId, (qb) => qb.where('s.robot_id', '=', q.robotId!))
        .orderBy('s.start_time')
        .execute(),
    ]);

    const byDay = new Map<string, StatsDay>(
      days.map((d) => [d, { date: d, tasksDone: 0, tasksFailed: 0, tasksCancelled: 0, alarmsBusiness: 0, alarmsSystem: 0, talks: 0, distanceM: 0, busyH: 0, chargingH: 0, idleH: 0, faultH: 0, offlineH: 0, utilization: null }]),
    );
    const secs = new Map<string, { busy: number; charging: number; idle: number; fault: number; offline: number }>();
    for (const t of tasks.rows) {
      const d = byDay.get(t.d);
      if (!d) continue;
      if (t.status === 'done') d.tasksDone += t.n;
      else if (t.status === 'failed') d.tasksFailed += t.n;
      else d.tasksCancelled += t.n;
    }
    const alarmStatus: Record<string, number> = {};
    for (const a of alarms.rows) {
      const d = byDay.get(a.d);
      if (!d) continue;
      if (a.category === 'business') d.alarmsBusiness += a.n;
      else d.alarmsSystem += a.n;
      alarmStatus[a.status] = (alarmStatus[a.status] ?? 0) + a.n;
    }
    for (const t of talks.rows) {
      const d = byDay.get(t.d);
      if (d) d.talks += t.n;
    }
    for (const r of robotStats) {
      const d = byDay.get(r.day);
      if (!d) continue;
      d.distanceM += r.distanceM;
      const s = secs.get(r.day) ?? { busy: 0, charging: 0, idle: 0, fault: 0, offline: 0 };
      s.busy += r.busyS;
      s.charging += r.chargingS;
      s.idle += r.idleS;
      s.fault += r.faultS;
      s.offline += r.offlineS;
      secs.set(r.day, s);
    }
    for (const [day, s] of secs) {
      const d = byDay.get(day)!;
      Object.assign(d, { busyH: H(s.busy), chargingH: H(s.charging), idleH: H(s.idle), faultH: H(s.fault), offlineH: H(s.offline) });
      d.utilization = ratio(s.busy, s.busy + s.charging + s.idle + s.fault + s.offline);
      d.distanceM = Math.round(d.distanceM * 10) / 10;
    }
    const list = [...byDay.values()];

    const sum = (k: keyof StatsDay) => list.reduce((a, d) => a + (Number(d[k]) || 0), 0);
    const tot = [...secs.values()].reduce((a, s) => ({ busy: a.busy + s.busy, charging: a.charging + s.charging, idle: a.idle + s.idle, fault: a.fault + s.fault, offline: a.offline + s.offline }), { busy: 0, charging: 0, idle: 0, fault: 0, offline: 0 });
    const all = tot.busy + tot.charging + tot.idle + tot.fault + tot.offline;

    const perRobot: StatsRobot[] = robots.map((r) => {
      const mine = robotStats.filter((x) => x.robotId === r.id);
      const b = mine.reduce((a, x) => a + x.busyS, 0);
      const total = mine.reduce((a, x) => a + x.busyS + x.chargingS + x.idleS + x.faultS + x.offlineS, 0);
      const down = mine.reduce((a, x) => a + x.faultS + x.offlineS, 0);
      return {
        id: r.id,
        code: r.code,
        floorId: r.floor_id,
        tasksDone: tasks.rows.filter((t) => t.robot_id === r.id && t.status === 'done').reduce((a, t) => a + t.n, 0),
        distanceM: Math.round(mine.reduce((a, x) => a + x.distanceM, 0) * 10) / 10,
        busyH: H(b),
        utilization: ratio(b, total),
        availability: ratio(total - down, total),
      };
    });

    return {
      from: q.from,
      to: q.to,
      generatedAt: new Date().toISOString(),
      robotCount: robots.length,
      totals: {
        tasksDone: sum('tasksDone'),
        tasksFailed: sum('tasksFailed'),
        tasksCancelled: sum('tasksCancelled'),
        alarmsBusiness: sum('alarmsBusiness'),
        alarmsSystem: sum('alarmsSystem'),
        alarmStatus,
        talks: sum('talks'),
        distanceM: Math.round(sum('distanceM') * 10) / 10,
        busyH: H(tot.busy),
        chargingH: H(tot.charging),
        idleH: H(tot.idle),
        faultH: H(tot.fault),
        offlineH: H(tot.offline),
        utilization: ratio(tot.busy, all),
        availability: ratio(all - tot.fault - tot.offline, all),
      },
      days: list,
      robots: perRobot,
      schedules: schedules.map((s) => ({ id: s.id, name: s.name, startTime: s.start_time.slice(0, 5), repeat: s.repeat, enabled: s.enabled, floorId: s.floor_id, pathName: s.path_name, robotCode: s.robot_code })),
    };
  }

  /** 匯出 Excel：總覽、每日、各機器人三張工作表 */
  async xlsx(q: StatsQuery, scope: { floorName?: string; robotCode?: string }): Promise<Buffer> {
    const s = await this.summary(q);
    const wb = new ExcelJS.Workbook();
    wb.creator = 'OViiAI';
    const head = (ws: ExcelJS.Worksheet) => {
      ws.getRow(1).font = { bold: true };
      ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFBCD4EE' } };
      ws.views = [{ state: 'frozen', ySplit: 1 }];
    };
    const o = wb.addWorksheet('總覽');
    o.columns = [
      { header: '項目', key: 'k', width: 22 },
      { header: '數值', key: 'v', width: 26 },
    ];
    const t = s.totals;
    o.addRows([
      { k: '期間', v: `${s.from} ～ ${s.to}` },
      { k: '範圍', v: scope.robotCode ?? scope.floorName ?? '全部樓層' },
      { k: '機器人數', v: s.robotCount },
      { k: '完成任務', v: t.tasksDone },
      { k: '失敗任務', v: t.tasksFailed },
      { k: '取消任務', v: t.tasksCancelled },
      { k: '業務告警', v: t.alarmsBusiness },
      { k: '系統告警', v: t.alarmsSystem },
      { k: '遠端對講（次）', v: t.talks },
      { k: '里程（m）', v: t.distanceM },
      { k: '任務時長（h）', v: t.busyH },
      { k: '充電時長（h）', v: t.chargingH },
      { k: '待命時長（h）', v: t.idleH },
      { k: '故障／急停（h）', v: t.faultH },
      { k: '離線時長（h）', v: t.offlineH },
      { k: '稼動率（%）', v: t.utilization ?? '—' },
      { k: '可用率（%）', v: t.availability ?? '—' },
      { k: '產生時間', v: new Date(s.generatedAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false }) },
    ]);
    head(o);
    const d = wb.addWorksheet('每日');
    d.columns = [
      ['date', '日期', 12],
      ['tasksDone', '完成任務', 10],
      ['tasksFailed', '失敗任務', 10],
      ['tasksCancelled', '取消任務', 10],
      ['alarmsBusiness', '業務告警', 10],
      ['alarmsSystem', '系統告警', 10],
      ['talks', '遠端對講', 10],
      ['distanceM', '里程(m)', 10],
      ['busyH', '任務時長(h)', 12],
      ['chargingH', '充電時長(h)', 12],
      ['idleH', '待命時長(h)', 12],
      ['faultH', '故障急停(h)', 12],
      ['offlineH', '離線時長(h)', 12],
      ['utilization', '稼動率(%)', 10],
    ].map(([key, header, width]) => ({ key: key as string, header: header as string, width: width as number }));
    d.addRows(s.days);
    head(d);
    const r = wb.addWorksheet('各機器人');
    r.columns = [
      ['code', '機器人', 14],
      ['floorId', '樓層', 8],
      ['tasksDone', '完成任務', 10],
      ['distanceM', '里程(m)', 10],
      ['busyH', '任務時長(h)', 12],
      ['utilization', '稼動率(%)', 10],
      ['availability', '可用率(%)', 10],
    ].map(([key, header, width]) => ({ key: key as string, header: header as string, width: width as number }));
    r.addRows(s.robots);
    head(r);
    return Buffer.from(await wb.xlsx.writeBuffer());
  }
}

/** 日期區間（含兩端）；最多一年；不超過今天 */
export function dayList(from: string, to: string): string[] {
  if (to < from) throw new AppError('VALIDATION_FAILED', '結束日期不能早於開始日期', { fields: { to: '結束日期不能早於開始日期' } });
  const out: string[] = [];
  const today = taipeiDay();
  for (let d = from; d <= to && d <= today; d = addDay(d, 1)) {
    out.push(d);
    if (out.length > MAX_DAYS) throw new AppError('VALIDATION_FAILED', `統計期間最多 ${MAX_DAYS} 天`, { fields: { from: '期間太長' } });
  }
  return out;
}
