import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { sql } from 'kysely';
import { CSV_BOM, csvRow, formatTaipei } from '../common/csv';
import { KYSELY, type Database } from '../db/database.module';
import { bullConnection, bullPrefix, closeBull } from '../jobs/bull';
import { StorageService } from '../storage/storage.service';

const QUEUE = 'maintenance';
/** 每天台北時間 03:30 */
const DAILY = { pattern: '30 3 * * *', tz: 'Asia/Taipei' };
/** 一次最多清這麼多筆；積壓的下一天繼續 */
const MAX_ROWS = 50_000;
/** 已經結束、可以清的告警狀態（未處理、處理中的不清） */
const FINAL = ['closed', 'false_alarm', 'info'];
/** 已結束的任務狀態（排隊、執行中、暫停的不清） */
const TASK_ENDED = ['done', 'cancelled', 'failed', 'rejected'];

export interface RetentionResult {
  alarms: number;
  oplogs: number;
  tasks: number;
  media: number;
  files: string[];
}

/**
 * 資料保存期限（工程開發手冊「資料庫」§7：任務、告警、操作日誌 1 年；PR #9 審查第 4 點、PR #10 審查第 6 點）。
 * 每日排程：超過 1 年的已結束告警（連同處理歷程）、已結束任務（連同任務歷程）與操作日誌，
 * 先匯出 CSV 存到物件儲存 retention/ 備查，成功才刪除；抓拍錄影 30 天（告警關聯的 1 年）直接刪檔。
 */
@Injectable()
export class RetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Retention');
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    @Inject(KYSELY) private readonly db: Database,
    private readonly storage: StorageService,
  ) {}

  async onModuleInit() {
    const connection = bullConnection();
    this.queue = new Queue(QUEUE, { connection, prefix: bullPrefix() });
    this.worker = new Worker(QUEUE, async () => this.purge(), { connection, prefix: bullPrefix() });
    this.worker.on('failed', (_j, e) => this.log.error(`保存期限清理失敗：${e.message}`));
    await this.queue.upsertJobScheduler('retention', DAILY, { name: 'retention' }).catch((e) => this.log.error(`排程建立失敗：${e}`));
  }

  async onModuleDestroy() {
    await closeBull(this.worker, this.queue);
  }

  /** 清除 now 往前 1 年以前的資料 */
  async purge(now = new Date()): Promise<RetentionResult> {
    const cutoff = new Date(now);
    cutoff.setFullYear(cutoff.getFullYear() - 1);
    const stamp = formatTaipei(now).slice(0, 10).replace(/-/g, '');
    const files: string[] = [];

    // 告警＋處理歷程
    const alarms = await this.db
      .selectFrom('alarms as a')
      .leftJoin('alarm_rules as r', 'r.type', 'a.type')
      .select(['a.id', 'a.code', 'a.occurred_at', 'a.category', 'a.type', 'r.name', 'a.level', 'a.floor_id', 'a.message', 'a.status', 'a.closed_at', 'a.repeat_count'])
      .where('a.occurred_at', '<', cutoff)
      .where('a.status', 'in', FINAL)
      .orderBy('a.occurred_at')
      .limit(MAX_ROWS)
      .execute();
    if (alarms.length) {
      const events = await this.db
        .selectFrom('alarm_events')
        .select(['alarm_id', 'at', 'user_name', 'from_status', 'to_status', 'note'])
        .where('alarm_id', 'in', alarms.map((a) => a.id))
        .orderBy('at')
        .execute();
      const byAlarm = new Map<string, string[]>();
      for (const e of events) {
        const l = byAlarm.get(e.alarm_id) ?? [];
        l.push(`${formatTaipei(e.at)} ${e.user_name ?? ''} ${e.from_status ?? ''}→${e.to_status ?? ''} ${e.note ?? ''}`.trim());
        byAlarm.set(e.alarm_id, l);
      }
      let csv = CSV_BOM + csvRow(['編號', '時間', '類別', '類型', '名稱', '級別', '樓層', '內容', '狀態', '結束時間', '重複次數', '處理歷程']);
      for (const a of alarms) {
        csv += csvRow([a.code, formatTaipei(a.occurred_at), a.category, a.type, a.name, a.level, a.floor_id, a.message, a.status, a.closed_at ? formatTaipei(a.closed_at) : '', a.repeat_count, (byAlarm.get(a.id) ?? []).join(' | ')]);
      }
      const key = `retention/alarms-${stamp}-${Date.now()}.csv`;
      await this.storage.put(key, csv, 'text/csv; charset=utf-8');
      files.push(key);
      await this.db.deleteFrom('alarms').where('id', 'in', alarms.map((a) => a.id)).execute(); // alarm_events ON DELETE CASCADE
    }

    // 任務＋任務歷程：以結束時間計（沒有結束時間的用建立時間）
    const tasks = await this.db
      .selectFrom('tasks as t')
      .leftJoin('robots as r', 'r.id', 't.robot_id')
      .select(['t.id', 't.code', 't.kind', 't.priority', 't.source', 't.floor_id', 't.status', 't.created_at', 't.started_at', 't.ended_at', 't.fail_reason', 't.note', 'r.code as robot_code'])
      .where('t.status', 'in', TASK_ENDED)
      .where((eb) => eb(eb.fn.coalesce('t.ended_at', 't.created_at'), '<', cutoff))
      .orderBy('t.created_at')
      .limit(MAX_ROWS)
      .execute();
    if (tasks.length) {
      const ids = tasks.map((t) => t.id);
      const events = await this.db.selectFrom('task_events').select(['task_id', 'at', 'type', 'data']).where('task_id', 'in', ids).orderBy('at').execute();
      const byTask = new Map<string, string[]>();
      for (const e of events) {
        const l = byTask.get(e.task_id) ?? [];
        l.push(`${formatTaipei(e.at)} ${e.type}${e.data ? ` ${JSON.stringify(e.data)}` : ''}`);
        byTask.set(e.task_id, l);
      }
      const fmt = (d: Date | null) => (d ? formatTaipei(d) : '');
      let csv = CSV_BOM + csvRow(['編號', '類型', '優先級', '來源', '樓層', '機器人', '狀態', '建立時間', '開始時間', '結束時間', '失敗原因', '備註', '任務歷程']);
      for (const t of tasks) {
        csv += csvRow([t.code, t.kind, t.priority, t.source, t.floor_id, t.robot_code, t.status, fmt(t.created_at), fmt(t.started_at), fmt(t.ended_at), t.fail_reason, t.note, (byTask.get(t.id) ?? []).join(' | ')]);
      }
      const key = `retention/tasks-${stamp}-${Date.now()}.csv`;
      await this.storage.put(key, csv, 'text/csv; charset=utf-8');
      files.push(key);
      await this.db.transaction().execute(async (trx) => {
        // 其他資料對這些任務的參照先斷開（被插隊的任務記著 P1、媒體記著任務）
        await trx.updateTable('tasks').set({ preempted_by: null }).where('preempted_by', 'in', ids).execute();
        await sql`UPDATE media SET task_id = NULL WHERE task_id = ANY(${ids}::uuid[])`.execute(trx);
        await trx.deleteFrom('tasks').where('id', 'in', ids).execute(); // task_events ON DELETE CASCADE；巡邏排程 last_task_id SET NULL
      });
    }

    // 抓拍、錄影（資料庫 §7：媒體 30 天；告警關聯的保存 1 年）：刪物件儲存的檔案與紀錄，不另匯出
    const mediaCut = new Date(now.getTime() - 30 * 86_400_000);
    const media = await this.db
      .selectFrom('media')
      .select(['id', 'object_key'])
      .where('kind', 'in', ['snapshot', 'clip'])
      .where((eb) => eb.or([eb.and([eb('alarm_id', 'is', null), eb('created_at', '<', mediaCut)]), eb('created_at', '<', cutoff)]))
      .orderBy('created_at')
      .limit(MAX_ROWS)
      .execute();
    for (const m of media) await this.storage.remove(m.object_key).catch(() => undefined);
    if (media.length) await this.db.deleteFrom('media').where('id', 'in', media.map((m) => m.id)).execute();

    // 操作日誌
    const logs = await this.db.selectFrom('op_logs').selectAll().where('at', '<', cutoff).orderBy('at').limit(MAX_ROWS).execute();
    if (logs.length) {
      let csv = CSV_BOM + csvRow(['時間', '帳號', '動作', '對象', 'IP', '內容']);
      for (const l of logs) csv += csvRow([formatTaipei(l.at), l.username, l.action, l.target, l.ip, l.detail]);
      const key = `retention/oplogs-${stamp}-${Date.now()}.csv`;
      await this.storage.put(key, csv, 'text/csv; charset=utf-8');
      files.push(key);
      await this.db.deleteFrom('op_logs').where('id', 'in', logs.map((l) => l.id)).execute();
    }

    if (alarms.length || logs.length || tasks.length || media.length) {
      this.log.log(`清除超過保存期限：告警 ${alarms.length}、任務 ${tasks.length}、操作日誌 ${logs.length}、抓拍錄影 ${media.length} 筆，備查檔：${files.join('、')}`);
    }
    return { alarms: alarms.length, oplogs: logs.length, tasks: tasks.length, media: media.length, files };
  }
}
