import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Response } from 'express';
import type Redis from 'ioredis';
import { sql } from 'kysely';
import { Subject } from 'rxjs';
import { AppError } from '../common/errors';
import { CSV_BOM, csvRow, formatTaipei } from '../common/csv';
import type { Paged } from '../common/pagination';
import { PG_UNIQUE_VIOLATION, pgCode } from '../common/pg-errors';
import { KYSELY, type Database } from '../db/database.module';
import { taipeiDate } from '../dispatch/task-state';
import { TasksService } from '../dispatch/tasks.service';
import { FleetService } from '../fleet/fleet.service';
import { RobotRegistry } from '../fleet/robot-registry';
import { REDIS } from '../redis/redis.module';
import { SettingsService } from '../settings/settings.service';
import { type AlarmStatus, canTransition, initialStatus, isFinal, sourceKey } from './alarm-state';

export type AlarmCategory = 'system' | 'business';

/** 正規化後的告警來源（後端邏輯 §5 第一步） */
export interface AlarmInput {
  type: string;
  robotId?: string | null;
  cameraId?: string | null;
  floorId?: string | null;
  x?: number | null;
  y?: number | null;
  message: string;
  /** AI 信心度 0–100（人臉、影像辨識）；低於 alarm.aiConfidence 進待人工複判 */
  confidence?: number | null;
  /** 去重來源鍵；沒給就用機器人／攝影機／樓層 */
  source?: string | null;
  ext?: Record<string, unknown> | null;
  at?: Date;
}

export interface AlarmRule {
  type: string;
  category: AlarmCategory;
  name: string;
  level: 1 | 2 | 3;
  popup: boolean;
  sound: boolean;
  needHandle: boolean;
  smsUserIds: string[];
  dedupSec: number;
}

export interface AlarmView {
  id: string;
  code: string;
  type: string;
  name: string;
  category: AlarmCategory;
  level: 1 | 2 | 3;
  floorId: string | null;
  robotId: string | null;
  robotCode: string | null;
  cameraId: string | null;
  x: number | null;
  y: number | null;
  message: string;
  confidence: number | null;
  status: AlarmStatus;
  handlerId: string | null;
  handlerName: string | null;
  repeatCount: number;
  occurredAt: string;
  handledAt: string | null;
  closedAt: string | null;
  /** 截圖與影片（T-26 媒體上線後提供下載 URL） */
  snapshotUrl: string | null;
  clipUrl: string | null;
  ext: unknown;
}

export interface AlarmEventView {
  at: string;
  userId: string | null;
  userName: string | null;
  from: AlarmStatus | null;
  to: AlarmStatus | null;
  note: string | null;
}

export interface AlarmFilter {
  categories: AlarmCategory[];
  level?: number[];
  type?: string[];
  status?: AlarmStatus[];
  floor?: string;
  robot?: string;
  from?: Date;
  to?: Date;
  q?: string;
}

/** WebSocket alarm.new：告警物件＋通知設定 */
export interface AlarmNew {
  alarm: AlarmView;
  notify: { popup: boolean; sound: boolean };
}

/** WebSocket alarm.updated */
export interface AlarmUpdated {
  id: string;
  code: string;
  category: AlarmCategory;
  status: AlarmStatus;
  handler: string | null;
  repeatCount: number;
  handledAt: string | null;
}

export const SYSTEM_NAME = '系統';
const EXPORT_BATCH = 1000;
const ADVISORY = `alarm-dedup`;

const STATUS_NAME: Record<AlarmStatus, string> = {
  review: '待人工複判',
  open: '未處理',
  handling: '處理中',
  reported: '已回報上位',
  closed: '已結案',
  false_alarm: '誤報',
  info: '無需處理',
};

/**
 * 告警管線（工程開發手冊 後端邏輯 §5、T-21）。
 *
 * 來源 → 正規化 → 去重（同 type＋同來源在 dedup_sec 內 → repeat_count+1）→ 查 alarm_rules
 * → 初始狀態（信心度 < aiConfidence → review；need_handle → open；否則 info）→ 寫 alarms＋alarm_events → 推 alarm.new。
 * 去重以 PostgreSQL advisory lock（type＋來源）序列化，多個來源同時送同一事件也只建一筆。
 */
@Injectable()
export class AlarmsService {
  private readonly log = new Logger('Alarms');
  readonly created$ = new Subject<AlarmNew>();
  readonly updated$ = new Subject<AlarmUpdated>();
  /** 回報上位系統（介面待定，整合模組訂閱） */
  readonly reported$ = new Subject<AlarmView>();

  constructor(
    private readonly registry: RobotRegistry,
    private readonly fleet: FleetService,
    private readonly tasks: TasksService,
    private readonly settings: SettingsService,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(KYSELY) private readonly db: Database,
  ) {}

  // ===== 管線 =====

  /** 送入一筆告警；回傳新建或合併後的告警（未知類型回 null） */
  async raise(input: AlarmInput): Promise<{ alarm: AlarmView; repeated: boolean } | null> {
    const rule = await this.rule(input.type);
    if (!rule) {
      this.log.warn(`未定義的告警類型 ${input.type}，丟棄：${input.message}`);
      return null;
    }
    const at = input.at ?? new Date();
    let floorId = input.floorId ?? null;
    let { x = null, y = null } = input;
    if (input.robotId) {
      const robot = this.registry.all().find((r) => r.id === input.robotId);
      const live = robot && this.fleet.get(robot.code);
      floorId ??= robot?.floor ?? null;
      if (x === null && live) [x, y] = [live.x, live.y];
    }
    const key = sourceKey({ ...input, floorId });
    const aiConfidence = await this.settings.getNumber('alarm.aiConfidence', 70);
    const status = initialStatus({ need_handle: rule.needHandle }, input.confidence, aiConfidence);

    const r = await this.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`${ADVISORY}:${input.type}:${key}`}))`.execute(trx);
      const dup = await trx
        .selectFrom('alarms')
        .select(['id'])
        .where('type', '=', input.type)
        .where('source_key', '=', key)
        .where('occurred_at', '>', new Date(at.getTime() - rule.dedupSec * 1000))
        .where('status', 'not in', ['closed', 'false_alarm'])
        .orderBy('occurred_at', 'desc')
        .limit(1)
        .executeTakeFirst();
      if (dup) {
        await trx.updateTable('alarms').set({ repeat_count: sql`repeat_count + 1` }).where('id', '=', dup.id).execute();
        return { id: dup.id, repeated: true };
      }
      const id = await this.insertWithCode(trx, (code) =>
        trx
          .insertInto('alarms')
          .values({
            code,
            type: rule.type,
            category: rule.category,
            level: rule.level,
            floor_id: floorId,
            robot_id: input.robotId ?? null,
            camera_id: input.cameraId ?? null,
            x,
            y,
            message: input.message,
            confidence: input.confidence ?? null,
            status,
            ext: input.ext ? JSON.stringify(input.ext) : null,
            occurred_at: at,
            closed_at: status === 'info' ? at : null,
            source_key: key,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
          .then((x) => x.id),
      );
      await trx.insertInto('alarm_events').values({ alarm_id: id, user_name: SYSTEM_NAME, to_status: status, note: '建立' }).execute();
      return { id, repeated: false };
    });

    const alarm = await this.get(r.id);
    if (r.repeated) {
      this.updated$.next(this.updatedOf(alarm));
    } else {
      this.log.log(`${alarm.code} ${rule.name}（${rule.level} 級，${STATUS_NAME[alarm.status]}）：${alarm.message}`);
      this.created$.next({ alarm, notify: { popup: rule.popup, sound: rule.sound } });
    }
    return { alarm, repeated: r.repeated };
  }

  /** 狀態轉換；不合法回 409 INVALID_STATE */
  async transition(id: string, to: AlarmStatus, note: string | null, user: { id: string; name: string }): Promise<AlarmView> {
    await this.db.transaction().execute(async (trx) => {
      const cur = await trx.selectFrom('alarms').select(['status']).where('id', '=', id).forUpdate().executeTakeFirst();
      if (!cur) throw new AppError('NOT_FOUND', '告警不存在');
      const from = cur.status as AlarmStatus;
      if (!canTransition(from, to)) {
        throw new AppError('INVALID_STATE', `告警狀態「${STATUS_NAME[from]}」不能改為「${STATUS_NAME[to]}」`, { from, to });
      }
      const now = new Date();
      await trx
        .updateTable('alarms')
        .set({ status: to, handler_id: user.id, handled_at: now, ...(isFinal(to) ? { closed_at: now } : {}) })
        .where('id', '=', id)
        .execute();
      await trx
        .insertInto('alarm_events')
        .values({ alarm_id: id, user_id: user.id, user_name: user.name, from_status: from, to_status: to, note: note || null })
        .execute();
    });
    const alarm = await this.get(id);
    this.updated$.next(this.updatedOf(alarm));
    return alarm;
  }

  /**
   * 回報上位系統（介面規格 POST /alarms/:id/report）。依合法轉換，未處理的先轉處理中再轉已回報，兩步都留歷程。
   * 上位系統介面待定（系統規格書 §11，第二期），目前只發出 reported$ 給整合模組。
   */
  async report(id: string, note: string | null, user: { id: string; name: string }): Promise<AlarmView> {
    const cur = await this.get(id);
    if (cur.status === 'open') await this.transition(id, 'handling', null, user);
    const alarm = await this.transition(id, 'reported', note, user);
    this.reported$.next(alarm);
    return alarm;
  }

  /** 派最近機器人到告警位置查看：建立 inspect 任務（一級 P1、二級 P2、三級 P3），並記入處理歷程 */
  async dispatch(id: string, user: { id: string; username: string; name: string }) {
    const a = await this.get(id);
    if (!a.floorId || a.x === null || a.y === null) throw new AppError('INVALID_STATE', '這筆告警沒有位置，無法派機器人');
    const priority = (['P1', 'P2', 'P3'] as const)[a.level - 1];
    const task = await this.tasks.create(
      { kind: 'inspect', priority, floorId: a.floorId, target: { x: a.x, y: a.y }, robotId: null, note: `查看告警 ${a.code}`, source: 'alarm' },
      { id: user.id, username: user.username },
    );
    await this.db
      .insertInto('alarm_events')
      .values({ alarm_id: id, user_id: user.id, user_name: user.name, note: `派機器人查看（任務 ${task.code}）` })
      .execute();
    return { taskId: task.id, taskCode: task.code, status: task.status };
  }

  // ===== 查詢 =====

  async get(id: string): Promise<AlarmView> {
    const row = await this.base().where('a.id', '=', id).executeTakeFirst();
    if (!row) throw new AppError('NOT_FOUND', '告警不存在');
    return toView(row);
  }

  async events(id: string): Promise<AlarmEventView[]> {
    const rows = await this.db.selectFrom('alarm_events').selectAll().where('alarm_id', '=', id).orderBy('at').orderBy('id').execute();
    return rows.map((e) => ({
      at: e.at.toISOString(),
      userId: e.user_id,
      userName: e.user_name,
      from: e.from_status as AlarmStatus | null,
      to: e.to_status as AlarmStatus | null,
      note: e.note,
    }));
  }

  async list(f: AlarmFilter, page: number, size: number): Promise<Paged<AlarmView> & { unhandled: number }> {
    const q = this.filtered(f);
    const [rows, total, unhandled] = await Promise.all([
      q
        .orderBy('a.occurred_at', 'desc')
        .orderBy('a.id', 'desc')
        .limit(size)
        .offset((page - 1) * size)
        .execute(),
      this.filtered(f)
        .clearSelect()
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .executeTakeFirstOrThrow(),
      this.filtered({ ...f, status: ['review', 'open', 'handling'] })
        .clearSelect()
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .executeTakeFirstOrThrow(),
    ]);
    return { items: rows.map(toView), total: Number(total.n), page, size, unhandled: Number(unhandled.n) };
  }

  async exportCsv(f: AlarmFilter, res: Response): Promise<void> {
    const stamp = formatTaipei(new Date()).slice(0, 10).replace(/-/g, '');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="alarms-${stamp}.csv"`);
    res.write(CSV_BOM + csvRow(['編號', '時間', '類別', '告警名稱', '級別', '樓層', '機器人', '內容', 'AI 信心度', '處理狀態', '處理人', '處理時間', '重複次數']));
    let offset = 0;
    for (;;) {
      const rows = await this.filtered(f).orderBy('a.occurred_at', 'desc').orderBy('a.id', 'desc').limit(EXPORT_BATCH).offset(offset).execute();
      for (const r of rows.map(toView)) {
        const line = csvRow([
          r.code,
          formatTaipei(new Date(r.occurredAt)),
          r.category === 'system' ? '系統' : '業務',
          r.name,
          `${r.level} 級`,
          r.floorId,
          r.robotCode,
          r.message,
          r.confidence,
          STATUS_NAME[r.status],
          r.handlerName,
          r.handledAt ? formatTaipei(new Date(r.handledAt)) : '',
          r.repeatCount,
        ]);
        if (!res.write(line)) await new Promise((resolve) => res.once('drain', resolve));
      }
      if (rows.length < EXPORT_BATCH) break;
      offset += EXPORT_BATCH;
    }
    res.end();
  }

  /** 未處理（待複判、未處理、處理中）筆數 */
  async activeCount(): Promise<number> {
    const r = await this.db
      .selectFrom('alarms')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('status', 'in', ['review', 'open', 'handling'])
      .executeTakeFirstOrThrow();
    return Number(r.n);
  }

  // ===== 告警設置 =====

  async rules(): Promise<AlarmRule[]> {
    const rows = await this.db.selectFrom('alarm_rules').selectAll().orderBy('category', 'desc').orderBy('level').orderBy('type').execute();
    return rows.map(toRule);
  }

  async rule(type: string): Promise<AlarmRule | null> {
    const r = await this.db.selectFrom('alarm_rules').selectAll().where('type', '=', type).executeTakeFirst();
    return r ? toRule(r) : null;
  }

  async updateRules(list: Omit<AlarmRule, 'category' | 'name'>[]): Promise<AlarmRule[]> {
    const known = new Set((await this.rules()).map((r) => r.type));
    const unknown = list.filter((r) => !known.has(r.type)).map((r) => r.type);
    if (unknown.length) throw new AppError('VALIDATION_FAILED', `未知的告警類型：${unknown.join('、')}`);
    const ids = [...new Set(list.flatMap((r) => r.smsUserIds))];
    if (ids.length) {
      const found = await this.db.selectFrom('users').select('id').where('id', 'in', ids).execute();
      if (found.length !== ids.length) throw new AppError('VALIDATION_FAILED', '簡訊接收人有不存在的帳號');
    }
    await this.db.transaction().execute(async (trx) => {
      for (const r of list) {
        await trx
          .updateTable('alarm_rules')
          .set({ level: r.level, popup: r.popup, sound: r.sound, need_handle: r.needHandle, sms_user_ids: r.smsUserIds, dedup_sec: r.dedupSec })
          .where('type', '=', r.type)
          .execute();
      }
    });
    return this.rules();
  }

  // ===== 內部 =====

  private updatedOf(a: AlarmView): AlarmUpdated {
    return { id: a.id, code: a.code, category: a.category, status: a.status, handler: a.handlerName, repeatCount: a.repeatCount, handledAt: a.handledAt };
  }

  private base() {
    return this.db
      .selectFrom('alarms as a')
      .innerJoin('alarm_rules as r', 'r.type', 'a.type')
      .leftJoin('robots as b', 'b.id', 'a.robot_id')
      .leftJoin('users as u', 'u.id', 'a.handler_id')
      .selectAll('a')
      .select(['r.name as rule_name', 'b.code as robot_code', 'u.display_name as handler_name']);
  }

  private filtered(f: AlarmFilter) {
    let q = this.base().where('a.category', 'in', f.categories.length ? f.categories : ['__none__']);
    if (f.level?.length) q = q.where('a.level', 'in', f.level);
    if (f.type?.length) q = q.where('a.type', 'in', f.type);
    if (f.status?.length) q = q.where('a.status', 'in', f.status);
    if (f.floor) q = q.where('a.floor_id', '=', f.floor);
    if (f.robot) q = q.where('a.robot_id', '=', f.robot);
    if (f.from) q = q.where('a.occurred_at', '>=', f.from);
    if (f.to) q = q.where('a.occurred_at', '<', f.to);
    if (f.q) {
      const like = `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      q = q.where((eb) => eb.or([eb('a.message', 'ilike', like), eb('a.code', 'ilike', like), eb('r.name', 'ilike', like), eb('b.code', 'ilike', like)]));
    }
    return q;
  }

  /** A-20261016-0007：台北日期＋當日流水號；重複時以資料庫當天最大編號重設流水號再試 */
  private async insertWithCode(trx: Database, insert: (code: string) => Promise<string>): Promise<string> {
    const day = taipeiDate().replace(/-/g, '');
    const k = `alarm:seq:${day}`;
    for (let attempt = 0; ; attempt++) {
      const n = await this.redis.incr(k);
      if (n === 1) await this.redis.expire(k, 3 * 86400);
      const code = `A-${day}-${String(n).padStart(4, '0')}`;
      try {
        await sql`SAVEPOINT alarm_code`.execute(trx);
        const id = await insert(code);
        await sql`RELEASE SAVEPOINT alarm_code`.execute(trx);
        return id;
      } catch (e) {
        if (pgCode(e) !== PG_UNIQUE_VIOLATION || attempt >= 4) throw e;
        await sql`ROLLBACK TO SAVEPOINT alarm_code`.execute(trx);
        const row = await trx
          .selectFrom('alarms')
          .select((eb) => eb.fn.max('code').as('max'))
          .where('code', 'like', `A-${day}-%`)
          .executeTakeFirst();
        const max = row?.max ? Number(String(row.max).slice(-4)) : 0;
        await this.redis.eval(
          `local cur = tonumber(redis.call('get', KEYS[1]) or '0'); if cur < tonumber(ARGV[1]) then redis.call('set', KEYS[1], ARGV[1]) end; redis.call('expire', KEYS[1], ARGV[2]); return 1`,
          1,
          k,
          String(max),
          String(3 * 86400),
        );
      }
    }
  }
}

type Row = {
  id: string;
  code: string;
  type: string;
  category: string;
  level: number;
  floor_id: string | null;
  robot_id: string | null;
  camera_id: string | null;
  x: number | null;
  y: number | null;
  message: string;
  confidence: string | null;
  status: string;
  handler_id: string | null;
  ext: unknown;
  repeat_count: number;
  occurred_at: Date;
  handled_at: Date | null;
  closed_at: Date | null;
  rule_name: string;
  robot_code: string | null;
  handler_name: string | null;
};

function toView(r: Row): AlarmView {
  return {
    id: r.id,
    code: r.code,
    type: r.type,
    name: r.rule_name,
    category: r.category as AlarmCategory,
    level: r.level as 1 | 2 | 3,
    floorId: r.floor_id,
    robotId: r.robot_id,
    robotCode: r.robot_code,
    cameraId: r.camera_id,
    x: r.x,
    y: r.y,
    message: r.message,
    confidence: r.confidence === null ? null : Number(r.confidence),
    status: r.status as AlarmStatus,
    handlerId: r.handler_id,
    handlerName: r.handler_name,
    repeatCount: r.repeat_count,
    occurredAt: r.occurred_at.toISOString(),
    handledAt: r.handled_at?.toISOString() ?? null,
    closedAt: r.closed_at?.toISOString() ?? null,
    snapshotUrl: null,
    clipUrl: null,
    ext: r.ext,
  };
}

function toRule(r: {
  type: string;
  category: 'system' | 'business';
  name: string;
  level: number;
  popup: boolean;
  sound: boolean;
  need_handle: boolean;
  sms_user_ids: string[];
  dedup_sec: number;
}): AlarmRule {
  return {
    type: r.type,
    category: r.category,
    name: r.name,
    level: r.level as 1 | 2 | 3,
    popup: r.popup,
    sound: r.sound,
    needHandle: r.need_handle,
    smsUserIds: r.sms_user_ids,
    dedupSec: r.dedup_sec,
  };
}
