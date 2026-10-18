import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { AppError } from '../common/errors';
import type { Paged } from '../common/pagination';
import { KYSELY, type Database } from '../db/database.module';

/** 查詢範圍上限：曲線、軌跡、運行日誌一次最多 31 天 */
const MAX_RANGE_MS = 31 * 86400_000;
/** 曲線最多約 360 點（每點一個時間桶），軌跡最多約 600 點 */
const CURVE_POINTS = 360;
const TRACK_POINTS = 600;
/** 耗電量（%/h）以最近這段時間的電量變化推算，太短會被 0.1% 的解析度放大成雜訊 */
const CONS_WINDOW_MS = 5 * 60_000;
/** 里程：兩筆遙測間超過這個速度視為跳點（重新定位、校正），不計入 */
const MAX_SPEED_MPS = 3;
/** 任務報告只列已結束的任務 */
const FINISHED = ['done', 'failed', 'cancelled'] as const;

export interface Range {
  from: Date;
  to: Date;
}

export interface EnergyPoint {
  at: string;
  battery: number | null;
  voltage: number | null;
  current: number | null;
  /** 耗電量 %/h：正為耗電、負為充電（由電量變化推算） */
  consumption: number | null;
  charging: boolean;
}

export interface ChargeSessionView {
  id: string;
  startedAt: string;
  endedAt: string | null;
  startPct: number | null;
  endPct: number | null;
  mode: string;
  chargerCode: string | null;
  minutes: number;
}

export interface RunlogEntry {
  at: string;
  end: string | null;
  state: string;
  reason: string | null;
  durationMs: number;
}

export interface TaskReportRow {
  id: string;
  code: string;
  kind: string;
  source: string;
  priority: string;
  status: string;
  floorId: string;
  robotId: string | null;
  robotCode: string | null;
  createdByName: string | null;
  note: string | null;
  /** 目標名稱：興趣點、路徑名稱；座標任務為 null */
  targetName: string | null;
  targetType: 'poi' | 'path' | 'point';
  startedAt: string | null;
  endedAt: string | null;
  failReason: string | null;
}

export interface TaskReport extends TaskReportRow {
  durationMs: number | null;
  distanceM: number;
  track: { x: number; y: number }[];
  /** 路徑任務的航點（報告上標號） */
  waypoints: { x: number; y: number }[];
  target: unknown;
  alarms: number;
  snapshots: number;
  clips: number;
  events: { at: string; type: string; data: unknown }[];
}

/**
 * T-39 第二期報表：能耗管理（telemetry、charge_sessions）、任務報告（tasks、telemetry 軌跡）、運行日誌（robot_state_log）。
 * 只讀；時間範圍由呼叫端給（前端以台北時間的日期換算成 UTC）。
 */
@Injectable()
export class ReportsService {
  constructor(@Inject(KYSELY) private readonly db: Database) {}

  // ------------------------------------------------------------ 能耗
  async energy(robotId: string, r: Range) {
    const robot = await this.robot(robotId);
    checkRange(r);
    const span = r.to.getTime() - r.from.getTime();
    const bucketSec = Math.max(2, Math.ceil(span / 1000 / CURVE_POINTS));
    const rows = await sql<{ t: Date; battery: number | null; voltage: number | null; current: number | null; charging: boolean | null }>`
      SELECT time_bucket(make_interval(secs => ${bucketSec}), at) AS t,
             avg(battery)::real AS battery, avg(voltage)::real AS voltage, avg(current)::real AS current, bool_or(charging) AS charging
      FROM telemetry
      WHERE robot_id = ${robot.id} AND at >= ${new Date(r.from.getTime() - CONS_WINDOW_MS)} AND at < ${r.to}
      GROUP BY t ORDER BY t`.execute(this.db);
    // 往前多讀 5 分鐘只為了推算耗電量（短區間，例：實時 1 分鐘，才不會一開始都是 0）；回傳只留區間內的點
    const fromMs = r.from.getTime();
    const points = withConsumption(rows.rows.map((x) => ({ t: new Date(x.t).getTime(), battery: x.battery, voltage: x.voltage, current: x.current, charging: !!x.charging }))).filter(
      (p) => Date.parse(p.at) >= fromMs - bucketSec * 1000,
    );

    const sessions = await this.db
      .selectFrom('charge_sessions as s')
      .leftJoin('chargers as c', 'c.id', 's.charger_id')
      .select(['s.id', 's.started_at', 's.ended_at', 's.start_pct', 's.end_pct', 's.mode', 'c.code as charger_code'])
      .where('s.robot_id', '=', robot.id)
      .where('s.started_at', '<', r.to)
      .where((eb) => eb.or([eb('s.ended_at', 'is', null), eb('s.ended_at', '>', r.from)]))
      .orderBy('s.started_at', 'desc')
      .limit(500)
      .execute();
    const now = Date.now();
    const charges: ChargeSessionView[] = sessions.map((s) => ({
      id: s.id,
      startedAt: s.started_at.toISOString(),
      endedAt: s.ended_at ? new Date(s.ended_at).toISOString() : null,
      startPct: s.start_pct,
      endPct: s.end_pct,
      mode: s.mode,
      chargerCode: s.charger_code ?? null,
      minutes: Math.round(((s.ended_at ? new Date(s.ended_at).getTime() : now) - s.started_at.getTime()) / 60_000),
    }));
    const done = charges.filter((c) => c.endedAt && c.startPct != null && c.endPct != null);
    const totalMin = charges.reduce((a, c) => a + c.minutes, 0);
    const gained = done.reduce((a, c) => a + Math.max(0, c.endPct! - c.startPct!), 0);
    const doneMin = done.reduce((a, c) => a + c.minutes, 0);
    // 放電：區間內電量下降的總和（充電時不算）
    let used = 0;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1].battery;
      const b = points[i].battery;
      if (a != null && b != null && b < a && !points[i].charging) used += a - b;
    }
    return {
      robotId: robot.id,
      code: robot.code,
      bucketSec,
      points,
      latest: points.at(-1) ?? null,
      charges,
      summary: {
        chargeCount: charges.length,
        chargeMinutes: totalMin,
        avgChargeMinutes: charges.length ? Math.round(totalMin / charges.length) : null,
        chargedPct: round1(gained),
        /** 平均充電速率 %/h（只算有開始、結束電量的） */
        chargeRatePctH: doneMin > 0 ? round1((gained / doneMin) * 60) : null,
        usedPct: round1(used),
      },
    };
  }

  // ------------------------------------------------------------ 軌跡
  /** 介面規格 GET /robots/:id/track：telemetry 降採樣（每桶取第一筆位置）＋里程 */
  async track(robotId: string, r: Range) {
    const robot = await this.robot(robotId);
    checkRange(r);
    return { robotId: robot.id, code: robot.code, floorId: robot.floor_id, ...(await this.trackOf(robot.id, r)) };
  }

  private async trackOf(robotId: string, r: Range) {
    const span = r.to.getTime() - r.from.getTime();
    const bucketSec = Math.max(1, Math.ceil(span / 1000 / TRACK_POINTS));
    const [pts, dist] = await Promise.all([
      sql<{ x: number; y: number }>`
        SELECT time_bucket(make_interval(secs => ${bucketSec}), at) AS b, first(x, at) AS x, first(y, at) AS y FROM telemetry
        WHERE robot_id = ${robotId} AND at >= ${r.from} AND at <= ${r.to} AND x IS NOT NULL
        GROUP BY b ORDER BY b`.execute(this.db),
      sql<{ m: number | null }>`
        SELECT sum(d) AS m FROM (
          SELECT sqrt(power(x - lag(x) OVER w, 2) + power(y - lag(y) OVER w, 2)) AS d,
                 extract(epoch FROM at - lag(at) OVER w) AS dt
          FROM telemetry WHERE robot_id = ${robotId} AND at >= ${r.from} AND at <= ${r.to} AND x IS NOT NULL
          WINDOW w AS (ORDER BY at)) s
        WHERE d IS NOT NULL AND dt > 0 AND d / dt <= ${MAX_SPEED_MPS}`.execute(this.db),
    ]);
    return { points: pts.rows.map((p) => ({ x: round2(p.x), y: round2(p.y) })), distanceM: round1(Number(dist.rows[0]?.m ?? 0)) };
  }

  // ------------------------------------------------------------ 任務報告
  async taskReports(f: { from: Date; to: Date; floor?: string; robot?: string; q?: string }, page: number, size: number): Promise<Paged<TaskReportRow>> {
    checkRange(f, 366 * 86400_000);
    let q = this.taskQuery()
      .where('t.status', 'in', [...FINISHED])
      .where('t.started_at', 'is not', null)
      .where('t.started_at', '>=', f.from)
      .where('t.started_at', '<', f.to);
    if (f.floor) q = q.where('t.floor_id', '=', f.floor);
    if (f.robot) q = q.where('t.robot_id', '=', f.robot);
    if (f.q) {
      const like = `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      q = q.where((eb) => eb.or([eb('t.code', 'ilike', like), eb('t.note', 'ilike', like), eb('p.name', 'ilike', like), eb('pa.name', 'ilike', like)]));
    }
    const [{ total }, rows] = await Promise.all([
      q.clearSelect().select((eb) => eb.fn.countAll<string>().as('total')).executeTakeFirstOrThrow(),
      q.orderBy('t.started_at', 'desc').limit(size).offset((page - 1) * size).execute(),
    ]);
    return { items: rows.map(reportRow), total: Number(total), page, size };
  }

  async taskReport(id: string): Promise<TaskReport> {
    const row = await this.taskQuery().select(['t.target', 'pa.points as path_points']).where('t.id', '=', id).executeTakeFirst();
    if (!row) throw new AppError('NOT_FOUND', '找不到任務');
    const base = reportRow(row);
    const start = row.started_at ? new Date(row.started_at) : null;
    const end = row.ended_at ? new Date(row.ended_at) : start ? new Date() : null;
    const window = start && end && row.robot_id ? { from: start, to: end } : null;
    const [track, alarms, media, events] = await Promise.all([
      window ? this.trackOf(row.robot_id!, window) : Promise.resolve({ points: [], distanceM: 0 }),
      window
        ? this.db
            .selectFrom('alarms')
            .select((eb) => eb.fn.countAll<string>().as('n'))
            .where('robot_id', '=', row.robot_id!)
            .where('occurred_at', '>=', window.from)
            .where('occurred_at', '<=', window.to)
            .executeTakeFirstOrThrow()
        : Promise.resolve({ n: '0' }),
      this.db
        .selectFrom('media')
        .select(['kind', (eb) => eb.fn.countAll<string>().as('n')])
        .where((eb) =>
          window
            ? eb.or([eb('task_id', '=', id), eb.and([eb('robot_id', '=', row.robot_id!), eb('created_at', '>=', window.from), eb('created_at', '<=', window.to)])])
            : eb('task_id', '=', id),
        )
        .groupBy('kind')
        .execute(),
      this.db.selectFrom('task_events').select(['at', 'type', 'data']).where('task_id', '=', id).orderBy('at').orderBy('id').execute(),
    ]);
    const count = (k: string) => Number(media.find((m) => m.kind === k)?.n ?? 0);
    return {
      ...base,
      durationMs: start && row.ended_at ? new Date(row.ended_at).getTime() - start.getTime() : null,
      distanceM: track.distanceM,
      track: track.points,
      waypoints: (row.path_points ?? []).map((p) => ({ x: p.x, y: p.y })),
      target: row.target,
      alarms: Number(alarms.n),
      snapshots: count('snapshot'),
      clips: count('clip'),
      events: events.map((e) => ({ at: e.at.toISOString(), type: e.type, data: e.data })),
    };
  }

  private taskQuery() {
    return this.db
      .selectFrom('tasks as t')
      .leftJoin('robots as r', 'r.id', 't.robot_id')
      .leftJoin('users as cu', 'cu.id', 't.created_by')
      .leftJoin('pois as p', (j) => j.on(sql`p.id::text`, '=', sql`t.target->>'poiId'`))
      .leftJoin('paths as pa', (j) => j.on(sql`pa.id::text`, '=', sql`t.target->>'pathId'`))
      .select([
        't.id',
        't.code',
        't.kind',
        't.source',
        't.priority',
        't.status',
        't.floor_id',
        't.robot_id',
        't.note',
        't.started_at',
        't.ended_at',
        't.fail_reason',
        'r.code as robot_code',
        'cu.display_name as created_by_name',
        'p.name as poi_name',
        'pa.name as path_name',
      ]);
  }

  // ------------------------------------------------------------ 運行日誌
  /** 狀態時間軸：區間內每次狀態變化，加上區間開始時正在持續的那一段；新的在前 */
  async runlog(robotId: string, r: Range) {
    const robot = await this.robot(robotId);
    checkRange(r);
    const [before, rows] = await Promise.all([
      this.db
        .selectFrom('robot_state_log')
        .select(['at', 'state', 'reason'])
        .where('robot_id', '=', robot.id)
        .where('at', '<', r.from)
        .orderBy('at', 'desc')
        .limit(1)
        .executeTakeFirst(),
      this.db
        .selectFrom('robot_state_log')
        .select(['at', 'state', 'reason'])
        .where('robot_id', '=', robot.id)
        .where('at', '>=', r.from)
        .where('at', '<', r.to)
        .orderBy('at')
        .limit(5000)
        .execute(),
    ]);
    const list = [...(before ? [{ ...before, at: r.from, carried: true }] : []), ...rows.map((x) => ({ ...x, carried: false }))];
    const now = Date.now();
    const cap = Math.min(now, r.to.getTime());
    const entries: (RunlogEntry & { carried: boolean })[] = list.map((e, i) => {
      const next = list[i + 1];
      const startMs = new Date(e.at).getTime();
      const endMs = next ? new Date(next.at).getTime() : null;
      return {
        at: new Date(e.at).toISOString(),
        end: endMs ? new Date(endMs).toISOString() : r.to.getTime() <= now ? r.to.toISOString() : null,
        state: e.state,
        reason: e.reason,
        durationMs: (endMs ?? cap) - startMs,
        carried: e.carried,
      };
    });
    // 各狀態總時長（可用率參考）
    const totals: Record<string, number> = {};
    for (const e of entries) totals[e.state] = (totals[e.state] ?? 0) + e.durationMs;
    return { robotId: robot.id, code: robot.code, floorId: robot.floor_id, entries: entries.reverse(), totals, truncated: rows.length >= 5000 };
  }

  private async robot(id: string) {
    const r = await this.db.selectFrom('robots').select(['id', 'code', 'floor_id']).where('id', '=', id).executeTakeFirst();
    if (!r) throw new AppError('NOT_FOUND', '找不到機器人');
    return r;
  }
}

function checkRange(r: Range, max = MAX_RANGE_MS) {
  const span = r.to.getTime() - r.from.getTime();
  if (!(span > 0)) throw new AppError('VALIDATION_FAILED', '結束時間必須晚於開始時間', { fields: { to: '結束時間必須晚於開始時間' } });
  if (span > max) throw new AppError('VALIDATION_FAILED', `查詢範圍最多 ${Math.round(max / 86400_000)} 天`, { fields: { from: '範圍太大' } });
}

/** 每點的耗電量 %/h：和 5 分鐘前（或區間第一點）的電量比 */
export function withConsumption(rows: { t: number; battery: number | null; voltage: number | null; current: number | null; charging: boolean }[]): EnergyPoint[] {
  let j = 0;
  return rows.map((p, i) => {
    while (j < i && (p.t - rows[j].t > CONS_WINDOW_MS || rows[j].battery == null)) j++;
    const ref = rows[j];
    const dtH = (p.t - ref.t) / 3600_000;
    const consumption = j < i && p.battery != null && ref.battery != null && dtH > 0 ? round1((ref.battery - p.battery) / dtH) : null;
    return { at: new Date(p.t).toISOString(), battery: r1(p.battery), voltage: r2(p.voltage), current: r2(p.current), consumption, charging: p.charging };
  });
}

type ReportDbRow = {
  id: string;
  code: string;
  kind: string;
  source: string;
  priority: string;
  status: string;
  floor_id: string;
  robot_id: string | null;
  note: string | null;
  started_at: Date | string | null;
  ended_at: Date | string | null;
  fail_reason: string | null;
  robot_code: string | null;
  created_by_name: string | null;
  poi_name: string | null;
  path_name: string | null;
};

function reportRow(r: ReportDbRow): TaskReportRow {
  return {
    id: r.id,
    code: r.code,
    kind: r.kind,
    source: r.source,
    priority: r.priority,
    status: r.status,
    floorId: r.floor_id,
    robotId: r.robot_id,
    robotCode: r.robot_code,
    createdByName: r.created_by_name,
    note: r.note,
    targetName: r.path_name ?? r.poi_name ?? null,
    targetType: r.path_name != null ? 'path' : r.poi_name != null ? 'poi' : 'point',
    startedAt: r.started_at ? new Date(r.started_at).toISOString() : null,
    endedAt: r.ended_at ? new Date(r.ended_at).toISOString() : null,
    failReason: r.fail_reason,
  };
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
const r1 = (n: number | null) => (n == null ? null : round1(n));
const r2 = (n: number | null) => (n == null ? null : round2(n));
