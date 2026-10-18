import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Insertable } from 'kysely';
import { sql } from 'kysely';
import type { Subscription } from 'rxjs';
import { AlarmsService } from '../alarms/alarms.service';
import { AppError } from '../common/errors';
import { KYSELY, type Database } from '../db/database.module';
import type { DB } from '../db/types';
import { TasksService } from '../dispatch/tasks.service';
import { FleetService } from '../fleet/fleet.service';
import type { SensorSample } from '../fleet/types';

/** 一般情況每台每 30 秒存一筆；超標期間每 2 秒一筆（留下峰值） */
export const SAMPLE_MS = 30_000;
export const OVER_SAMPLE_MS = 2_000;
const FLUSH_MS = 5_000;
const MAX_BUFFER = 20_000;
/** 連續這麼多筆超標才發告警，避免單筆雜訊 */
export const CONFIRM_SAMPLES = 2;
const RELOAD_MS = 30_000;
export const FREQ_MS = { '1h': 3_600_000, '4h': 4 * 3_600_000 } as const;
/** 「立即檢測」的機器人要在這段時間內到達才算 */
const FORCE_TTL_MS = 60 * 60_000;

export type Freq = 'pass' | '1h' | '4h';

export interface Threshold {
  kind: string;
  name: string;
  unit: string;
  min: number | null;
  max: number | null;
  alarmType: string | null;
  sort: number;
}

export interface PointInfo {
  id: string;
  poiId: string;
  name: string;
  floorId: string;
  x: number;
  y: number;
  freq: Freq;
  radiusM: number;
  enabled: boolean;
}

type Row = Insertable<DB['env_readings']>;

/** 超出閾值：high／low；沒有超標 null */
export function exceed(th: Pick<Threshold, 'min' | 'max'>, v: number): 'high' | 'low' | null {
  if (th.max != null && v > th.max) return 'high';
  if (th.min != null && v < th.min) return 'low';
  return null;
}

const fmt = (v: number) => String(Math.round(v * 10) / 10);

/**
 * 環境監測、定點檢測（第二期 T-41）。
 *
 * 遙測的 sensors 只收 env_thresholds 列出的項目（例：odom_total_m 不是環境數值），寫入 env_readings：
 * 一般每台 30 秒一筆、超標期間 2 秒一筆。數值連續 2 筆超出閾值就發該項目的業務告警（gas、temp_humidity…），
 * 回到範圍內才會再發；同一台同一項目的告警由告警管線依 dedup_sec 合併。
 *
 * 定點檢測：機器人進入檢測點（興趣點）半徑內時記一筆，標上 point_id。頻率「每次經過」每次進入記一筆；
 * 「每 1／4 小時」距該點上一筆超過間隔才記（停在點上也會依間隔再記）。「立即檢測」派一張需要 env 能力的任務過去，
 * 到達時不論頻率都記。
 */
@Injectable()
export class EnvService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Env');
  private sub?: Subscription;
  private timers: NodeJS.Timeout[] = [];
  private buffer: Row[] = [];
  private thresholds = new Map<string, Threshold>();
  private points: PointInfo[] = [];
  /** 機器人 → 上次存一般數值的時間 */
  private readonly lastWrite = new Map<string, number>();
  /** `${robotId}:${kind}` → 連續超標筆數、是否已發告警 */
  private readonly over = new Map<string, { n: number; alarmed: boolean }>();
  /** `${robotId}:${pointId}`：目前在檢測點範圍內 */
  private readonly inside = new Set<string>();
  /** 檢測點 → 上一筆定點量測時間 */
  private readonly lastPoint = new Map<string, number>();
  /** 檢測點 → 立即檢測的期限 */
  private readonly forced = new Map<string, number>();
  private chain: Promise<void> = Promise.resolve();

  constructor(
    @Inject(KYSELY) private readonly db: Database,
    private readonly fleet: FleetService,
    private readonly alarms: AlarmsService,
    private readonly tasks: TasksService,
  ) {}

  async onModuleInit() {
    await this.reload().catch((e) => this.log.error(`載入環境閾值、檢測點失敗：${e instanceof Error ? e.message : e}`));
    // 依序處理：同一台的連續超標判斷與檢測點進出要照順序
    this.sub = this.fleet.sensors$.subscribe((s) => {
      this.chain = this.chain.then(() => this.ingest(s)).catch((e) => this.log.error(e instanceof Error ? e.stack : String(e)));
    });
    this.timers.push(setInterval(() => void this.flush(), FLUSH_MS));
    this.timers.push(setInterval(() => void this.reload().catch((e) => this.log.warn(String(e))), RELOAD_MS));
  }

  async onModuleDestroy() {
    this.sub?.unsubscribe();
    this.timers.forEach(clearInterval);
    await this.chain;
    await this.flush();
  }

  /** 測試用：等目前收到的數值都處理完並寫入 */
  async drain(): Promise<void> {
    await this.chain;
    await this.flush();
  }

  // ===== 閾值、檢測點快取 =====

  async reload(): Promise<void> {
    const [ths, pts, last] = await Promise.all([
      this.listThresholds(),
      this.db
        .selectFrom('inspection_points as p')
        .innerJoin('pois as o', 'o.id', 'p.poi_id')
        .select(['p.id', 'p.poi_id', 'o.name', 'o.floor_id', 'o.x', 'o.y', 'p.freq', 'p.radius_m', 'p.enabled'])
        .execute(),
      this.db
        .selectFrom('env_readings')
        .select(['point_id', (eb) => eb.fn.max('at').as('at')])
        .where('point_id', 'is not', null)
        .where('at', '>', new Date(Date.now() - FREQ_MS['4h']))
        .groupBy('point_id')
        .execute(),
    ]);
    this.thresholds = new Map(ths.map((t) => [t.kind, t]));
    this.points = pts.map((p) => ({ id: p.id, poiId: p.poi_id, name: p.name, floorId: p.floor_id, x: p.x, y: p.y, freq: p.freq, radiusM: p.radius_m, enabled: p.enabled }));
    for (const l of last) {
      const at = new Date(l.at as Date).getTime();
      if (l.point_id && at > (this.lastPoint.get(l.point_id) ?? 0)) this.lastPoint.set(l.point_id, at);
    }
  }

  async listThresholds(): Promise<Threshold[]> {
    const rows = await this.db.selectFrom('env_thresholds').selectAll().orderBy('sort').execute();
    return rows.map((r) => ({ kind: r.kind, name: r.name, unit: r.unit, min: r.min, max: r.max, alarmType: r.alarm_type, sort: r.sort }));
  }

  async updateThresholds(items: { kind: string; min: number | null; max: number | null; alarmType: string | null }[], userId: string): Promise<Threshold[]> {
    const known = new Set((await this.listThresholds()).map((t) => t.kind));
    const types = new Set((await this.db.selectFrom('alarm_rules').select('type').where('category', '=', 'business').execute()).map((r) => r.type));
    for (const i of items) {
      if (!known.has(i.kind)) throw new AppError('VALIDATION_FAILED', `沒有環境項目 ${i.kind}`, { fields: { [i.kind]: '沒有這個項目' } });
      if (i.min != null && i.max != null && i.min >= i.max) throw new AppError('VALIDATION_FAILED', '下限要小於上限', { fields: { [i.kind]: '下限要小於上限' } });
      if (i.alarmType && !types.has(i.alarmType)) throw new AppError('VALIDATION_FAILED', `告警類型 ${i.alarmType} 不是業務告警`, { fields: { [i.kind]: '告警類型不存在' } });
    }
    await this.db.transaction().execute(async (trx) => {
      for (const i of items) {
        await trx
          .updateTable('env_thresholds')
          .set({ min: i.min, max: i.max, alarm_type: i.alarmType, updated_by: userId, updated_at: new Date() })
          .where('kind', '=', i.kind)
          .execute();
      }
    });
    await this.reload();
    return this.listThresholds();
  }

  pointsCache(): readonly PointInfo[] {
    return this.points;
  }

  // ===== 收數值 =====

  async ingest(s: SensorSample): Promise<void> {
    const vals = Object.entries(s.sensors).filter(([k, v]) => this.thresholds.has(k) && Number.isFinite(v.value));
    if (!vals.length) return;
    const robot = s.robot;
    const at = new Date(s.at);
    const row = (kind: string, value: number, pointId: string | null): Row => ({
      at,
      robot_id: robot.id,
      floor_id: robot.floor,
      x: s.x,
      y: s.y,
      kind,
      value,
      unit: this.thresholds.get(kind)!.unit,
      point_id: pointId,
    });

    // 檢測點：進入半徑內（或停在點上已超過頻率間隔）就記一筆
    const here: PointInfo[] = [];
    for (const p of this.points) {
      if (!p.enabled || p.floorId !== robot.floor) continue;
      const key = `${robot.id}:${p.id}`;
      const near = Math.hypot(s.x - p.x, s.y - p.y) <= p.radiusM;
      if (!near) {
        this.inside.delete(key);
        continue;
      }
      here.push(p);
      const entering = !this.inside.has(key);
      this.inside.add(key);
      const forced = (this.forced.get(p.id) ?? 0) > s.at;
      const due = p.freq === 'pass' ? entering : s.at - (this.lastPoint.get(p.id) ?? 0) >= FREQ_MS[p.freq];
      if (!forced && !due) continue;
      this.forced.delete(p.id);
      this.lastPoint.set(p.id, s.at);
      for (const [k, v] of vals) this.push(row(k, v.value, p.id));
    }

    // 閾值
    let anyOver = false;
    for (const [kind, v] of vals) {
      const th = this.thresholds.get(kind)!;
      const key = `${robot.id}:${kind}`;
      const st = this.over.get(key) ?? { n: 0, alarmed: false };
      const dir = exceed(th, v.value);
      if (!dir) {
        this.over.delete(key);
        continue;
      }
      anyOver = true;
      st.n++;
      this.over.set(key, st);
      if (st.alarmed || st.n < CONFIRM_SAMPLES || !th.alarmType) continue;
      st.alarmed = true;
      const limit = dir === 'high' ? `超過上限 ${fmt(th.max!)} ${th.unit}` : `低於下限 ${fmt(th.min!)} ${th.unit}`;
      const where = here.length ? `（檢測點 ${here.map((p) => p.name).join('、')}）` : '';
      await this.alarms.raise({
        type: th.alarmType,
        robotId: robot.id,
        floorId: robot.floor,
        x: s.x,
        y: s.y,
        source: `robot:${robot.id}:env:${kind}`,
        message: `${robot.code} ${th.name} ${fmt(v.value)} ${th.unit}，${limit}${where}`,
        ext: { env: { kind, value: v.value, unit: th.unit, min: th.min, max: th.max, pointIds: here.map((p) => p.id) } },
        at,
      });
    }

    // 一般取樣
    const last = this.lastWrite.get(robot.id) ?? 0;
    if (s.at - last >= (anyOver ? OVER_SAMPLE_MS : SAMPLE_MS) || s.at < last) {
      this.lastWrite.set(robot.id, s.at);
      for (const [k, v] of vals) this.push(row(k, v.value, null));
    }
  }

  private push(r: Row) {
    if (this.buffer.length >= MAX_BUFFER) this.buffer.shift();
    this.buffer.push(r);
  }

  async flush(): Promise<number> {
    if (!this.buffer.length) return 0;
    const rows = this.buffer;
    this.buffer = [];
    try {
      await this.db.insertInto('env_readings').values(rows).execute();
      return rows.length;
    } catch (e) {
      this.buffer = rows.concat(this.buffer).slice(-MAX_BUFFER);
      this.log.error(`環境數值寫入失敗（${rows.length} 筆待重試）：${e instanceof Error ? e.message : e}`);
      return 0;
    }
  }

  // ===== 查詢 =====

  /** 環境監測頁：各項目的趨勢（時間桶平均、最高、最低）、目前數值（各機器人最近 15 分鐘）、超標告警次數 */
  async summary(f: { floorId: string; from: Date; to: Date }) {
    const span = f.to.getTime() - f.from.getTime();
    const bucketSec = Math.max(60, Math.ceil(span / 1000 / 240 / 60) * 60);
    const [series, latest, alarms, thresholds] = await Promise.all([
      sql<{ kind: string; b: Date; avg: number; min: number; max: number }>`
        SELECT kind, time_bucket(make_interval(secs => ${bucketSec}), at) AS b, avg(value)::float8 AS avg, min(value)::float8 AS min, max(value)::float8 AS max
          FROM env_readings WHERE floor_id = ${f.floorId} AND at >= ${f.from} AND at < ${f.to}
         GROUP BY 1, 2 ORDER BY 1, 2`.execute(this.db),
      sql<{ robot_id: string; code: string | null; kind: string; value: number; unit: string; at: Date; x: number | null; y: number | null }>`
        SELECT DISTINCT ON (e.robot_id, e.kind) e.robot_id, r.code, e.kind, e.value::float8 AS value, e.unit, e.at, e.x, e.y
          FROM env_readings e LEFT JOIN robots r ON r.id = e.robot_id
         WHERE e.floor_id = ${f.floorId} AND e.at > now() - interval '15 minutes'
         ORDER BY e.robot_id, e.kind, e.at DESC`.execute(this.db),
      sql<{ kind: string; n: string }>`
        SELECT ext->'env'->>'kind' AS kind, count(*) AS n FROM alarms
         WHERE floor_id = ${f.floorId} AND occurred_at >= ${f.from} AND occurred_at < ${f.to} AND ext ? 'env'
         GROUP BY 1`.execute(this.db),
      this.listThresholds(),
    ]);
    const kinds = new Map<string, { kind: string; points: { at: string; avg: number; min: number; max: number }[] }>();
    for (const r of series.rows) {
      if (!kinds.has(r.kind)) kinds.set(r.kind, { kind: r.kind, points: [] });
      kinds.get(r.kind)!.points.push({ at: new Date(r.b).toISOString(), avg: r.avg, min: r.min, max: r.max });
    }
    const robots = new Map<string, { robotId: string; code: string; at: string; x: number | null; y: number | null; values: Record<string, { value: number; unit: string; over: 'high' | 'low' | null }> }>();
    const th = new Map(thresholds.map((t) => [t.kind, t]));
    for (const r of latest.rows) {
      const cur = robots.get(r.robot_id) ?? { robotId: r.robot_id, code: r.code ?? '—', at: new Date(r.at).toISOString(), x: r.x, y: r.y, values: {} };
      if (new Date(r.at).toISOString() > cur.at) Object.assign(cur, { at: new Date(r.at).toISOString(), x: r.x, y: r.y });
      const t = th.get(r.kind);
      cur.values[r.kind] = { value: r.value, unit: r.unit, over: t ? exceed(t, r.value) : null };
      robots.set(r.robot_id, cur);
    }
    const order = (k: string) => th.get(k)?.sort ?? 99;
    return {
      floorId: f.floorId,
      bucketSec,
      thresholds,
      series: [...kinds.values()].sort((a, b) => order(a.kind) - order(b.kind)),
      latest: [...robots.values()].sort((a, b) => a.code.localeCompare(b.code)),
      alarms: Object.fromEntries(alarms.rows.map((r) => [r.kind, Number(r.n)])),
      alarmTotal: alarms.rows.reduce((s, r) => s + Number(r.n), 0),
    };
  }

  /** 平面圖的量測位置：依格子（公尺）彙總某個項目，標示最高、最低、平均與是否超標 */
  async map(f: { floorId: string; from: Date; to: Date; kind: string; cell: number }) {
    const t = (await this.listThresholds()).find((x) => x.kind === f.kind);
    if (!t) throw new AppError('VALIDATION_FAILED', `沒有環境項目 ${f.kind}`, { fields: { kind: '沒有這個項目' } });
    const rows = await sql<{ cx: number; cy: number; n: string; avg: number; min: number; max: number; last: Date }>`
      SELECT (floor(x / ${f.cell}) + 0.5) * ${f.cell} AS cx, (floor(y / ${f.cell}) + 0.5) * ${f.cell} AS cy,
             count(*) AS n, avg(value)::float8 AS avg, min(value)::float8 AS min, max(value)::float8 AS max, max(at) AS last
        FROM env_readings
       WHERE floor_id = ${f.floorId} AND kind = ${f.kind} AND at >= ${f.from} AND at < ${f.to} AND x IS NOT NULL
       GROUP BY 1, 2 ORDER BY 1, 2 LIMIT 2000`.execute(this.db);
    return {
      kind: f.kind,
      unit: t.unit,
      cell: f.cell,
      cells: rows.rows.map((r) => ({
        x: Number(r.cx),
        y: Number(r.cy),
        n: Number(r.n),
        avg: r.avg,
        min: r.min,
        max: r.max,
        lastAt: new Date(r.last).toISOString(),
        over: exceed(t, r.max) === 'high' ? 'high' : exceed(t, r.min) === 'low' ? 'low' : null,
      })),
    };
  }

  // ===== 定點檢測 =====

  async listPoints(floorId?: string) {
    let q = this.db
      .selectFrom('inspection_points as p')
      .innerJoin('pois as o', 'o.id', 'p.poi_id')
      .select(['p.id', 'p.poi_id', 'o.name', 'o.floor_id', 'o.x', 'o.y', 'p.freq', 'p.radius_m', 'p.enabled', 'p.created_at'])
      .orderBy('o.floor_id')
      .orderBy('o.name');
    if (floorId) q = q.where('o.floor_id', '=', floorId);
    const pts = await q.execute();
    const ids = pts.map((p) => p.id);
    const latest = ids.length
      ? (
          await sql<{ point_id: string; kind: string; value: number; unit: string; at: Date; code: string | null }>`
            SELECT DISTINCT ON (e.point_id, e.kind) e.point_id, e.kind, e.value::float8 AS value, e.unit, e.at, r.code
              FROM env_readings e LEFT JOIN robots r ON r.id = e.robot_id
             WHERE e.point_id = ANY(${ids}::uuid[]) AND e.at > now() - interval '30 days'
             ORDER BY e.point_id, e.kind, e.at DESC`.execute(this.db)
        ).rows
      : [];
    const th = new Map((await this.listThresholds()).map((t) => [t.kind, t]));
    return pts.map((p) => {
      const mine = latest.filter((l) => l.point_id === p.id).sort((a, b) => (th.get(a.kind)?.sort ?? 99) - (th.get(b.kind)?.sort ?? 99));
      const last = mine.reduce<(typeof mine)[number] | null>((a, b) => (!a || b.at > a.at ? b : a), null);
      const values = Object.fromEntries(mine.map((l) => [l.kind, { value: l.value, unit: l.unit, at: new Date(l.at).toISOString(), over: th.get(l.kind) ? exceed(th.get(l.kind)!, l.value) : null }]));
      return {
        id: p.id,
        poiId: p.poi_id,
        name: p.name,
        floorId: p.floor_id,
        x: p.x,
        y: p.y,
        freq: p.freq,
        radiusM: p.radius_m,
        enabled: p.enabled,
        createdAt: p.created_at.toISOString(),
        lastAt: last ? new Date(last.at).toISOString() : null,
        lastRobot: last?.code ?? null,
        values,
        status: !last ? 'none' : Object.values(values).some((v) => v.over) ? 'over' : 'ok',
        measuring: (this.forced.get(p.id) ?? 0) > Date.now(),
      };
    });
  }

  async createPoint(b: { poiId: string; freq: Freq; radiusM?: number }, userId: string) {
    const poi = await this.db.selectFrom('pois').select(['id', 'kind']).where('id', '=', b.poiId).executeTakeFirst();
    if (!poi) throw new AppError('VALIDATION_FAILED', '找不到興趣點', { fields: { poiId: '找不到興趣點' } });
    const dup = await this.db.selectFrom('inspection_points').select('id').where('poi_id', '=', b.poiId).executeTakeFirst();
    if (dup) throw new AppError('INVALID_STATE', '這個位置已經是檢測點');
    const { id } = await this.db
      .insertInto('inspection_points')
      .values({ poi_id: b.poiId, freq: b.freq, ...(b.radiusM !== undefined && { radius_m: b.radiusM }), created_by: userId })
      .returning('id')
      .executeTakeFirstOrThrow();
    await this.reload();
    return this.point(id);
  }

  async updatePoint(id: string, b: { freq?: Freq; radiusM?: number; enabled?: boolean }) {
    const r = await this.db
      .updateTable('inspection_points')
      .set({ ...(b.freq !== undefined && { freq: b.freq }), ...(b.radiusM !== undefined && { radius_m: b.radiusM }), ...(b.enabled !== undefined && { enabled: b.enabled }) })
      .where('id', '=', id)
      .executeTakeFirst();
    if (!r.numUpdatedRows) throw new AppError('NOT_FOUND', '找不到檢測點');
    await this.reload();
    return this.point(id);
  }

  async removePoint(id: string) {
    const r = await this.db.deleteFrom('inspection_points').where('id', '=', id).executeTakeFirst();
    if (!r.numDeletedRows) throw new AppError('NOT_FOUND', '找不到檢測點');
    this.forced.delete(id);
    await this.reload();
  }

  /** 立即檢測：派一張 env 任務到檢測點（需要 env 能力的機器人），到達時不論頻率都記一筆 */
  async measure(id: string, b: { robotId?: string | null }, actor: { id: string; username: string }) {
    const p = await this.point(id);
    const task = await this.tasks.create({ kind: 'env', priority: 'P3', floorId: p.floorId, target: { poiId: p.poiId }, robotId: b.robotId ?? null, note: `定點檢測 ${p.name}` }, actor);
    this.forced.set(id, Date.now() + FORCE_TTL_MS);
    return { taskId: task.id, taskCode: task.code, status: task.status };
  }

  /** 檢測點的量測紀錄：同一次量測（同時間、同機器人）的各項目併成一列 */
  async pointReadings(id: string, f: { from: Date; to: Date }, page: number, size: number) {
    await this.point(id);
    const base = sql`FROM env_readings e LEFT JOIN robots r ON r.id = e.robot_id WHERE e.point_id = ${id} AND e.at >= ${f.from} AND e.at < ${f.to}`;
    const [rows, total] = await Promise.all([
      sql<{ at: Date; code: string | null; values: Record<string, number> }>`
        SELECT e.at, r.code, jsonb_object_agg(e.kind, e.value) AS values ${base}
         GROUP BY e.at, e.robot_id, r.code ORDER BY e.at DESC LIMIT ${size} OFFSET ${(page - 1) * size}`.execute(this.db),
      sql<{ n: string }>`SELECT count(*) AS n FROM (SELECT 1 ${base} GROUP BY e.at, e.robot_id) t`.execute(this.db),
    ]);
    return { items: rows.rows.map((r) => ({ at: new Date(r.at).toISOString(), robotCode: r.code, values: r.values })), total: Number(total.rows[0].n), page, size };
  }

  private async point(id: string) {
    const p = (await this.listPoints()).find((x) => x.id === id);
    if (!p) throw new AppError('NOT_FOUND', '找不到檢測點');
    return p;
  }
}
