import { Inject, Injectable, Logger } from '@nestjs/common';
import { ALL_PERMS } from '@oviiai/contracts';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { sql } from 'kysely';
import { createHash } from 'node:crypto';
import { AppError } from '../common/errors';
import { dataEncKey } from '../config';
import { KYSELY, type Database } from '../db/database.module';
import { CHARGE_MODE, ChargeModeValue, RULES, type RuleKey } from '../dispatch/rules';
import { RobotRegistry } from '../fleet/robot-registry';
import { sniffPlan } from '../floors/floors.controller';
import { streamKey } from '../maps/map-admin.controller';
import { StreamsService } from '../media/streams.service';
import { PatrolService } from '../nav/patrol.service';
import { SettingsService } from '../settings/settings.service';
import { StorageService } from '../storage/storage.service';
import { SECRET_SETTING, SITE_VERSION, SitePackage, stripCredentials, upgrade } from './site-package';

export type Action = 'add' | 'update' | 'delete' | 'disable' | 'keep';
export interface Change {
  key: string;
  action: Action;
  /** update：哪些欄位不同 */
  fields?: string[];
  note?: string;
}
export interface Section {
  entity: Entity;
  changes: Change[];
}
export type Entity = 'floors' | 'robots' | 'chargers' | 'cameras' | 'pois' | 'zones' | 'paths' | 'patrolSchedules' | 'taskTemplates' | 'settings' | 'alarmRules' | 'roles';
export interface ImportPreview {
  version: number;
  summary: Record<Action, number>;
  sections: Section[];
  warnings: string[];
  applied: boolean;
}

export const PACKAGE_MAX_BYTES = 80 * 1024 * 1024;
/** 這些設定不屬於「場域設定」：登入鎖定等安全政策留在各系統自己決定 */
const LOCAL_SETTINGS = /^auth\./;
const EXTRA_SETTINGS: Record<string, (v: unknown) => boolean> = {
  'media.maxStreams': (v) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 64,
  'media.maxRecordSec': (v) => Number.isInteger(v) && (v as number) >= 10 && (v as number) <= 3600,
};

const stable = (v: unknown): string =>
  v === null || typeof v !== 'object'
    ? JSON.stringify(v ?? null)
    : Array.isArray(v)
      ? `[${v.map(stable).join(',')}]`
      : `{${Object.keys(v as object)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
          .join(',')}}`;
const num = (s: string | null) => (s === null ? null : Number(s));
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const hhmm = (t: string) => t.slice(0, 5);

/** 同名的興趣點、區域、路徑、排程、範本：依出現順序加上 #2、#3 才能一一對應 */
function keyed<T>(items: T[], base: (t: T) => string): { key: string; item: T }[] {
  const n = new Map<string, number>();
  return items.map((item) => {
    const b = base(item);
    const i = (n.get(b) ?? 0) + 1;
    n.set(b, i);
    return { key: i === 1 ? b : `${b} #${i}`, item };
  });
}

/** 比對：套件有、系統沒有 → add；都有但欄位不同 → update；系統有、套件沒有 → removal() 決定 */
function diff<T extends object>(pkg: { key: string; item: T }[], cur: { key: string; item: T }[], removal: (t: T) => { action: Action; note?: string }): Change[] {
  const out: Change[] = [];
  const curMap = new Map(cur.map((c) => [c.key, c.item]));
  const pkgKeys = new Set(pkg.map((p) => p.key));
  for (const p of pkg) {
    const c = curMap.get(p.key);
    if (!c) out.push({ key: p.key, action: 'add' });
    else {
      const fields = Object.keys(p.item).filter((f) => stable((p.item as Record<string, unknown>)[f]) !== stable((c as Record<string, unknown>)[f]));
      if (fields.length) out.push({ key: p.key, action: 'update', fields });
    }
  }
  for (const c of cur) if (!pkgKeys.has(c.key)) out.push({ key: c.key, ...removal(c.item) });
  return out;
}

/**
 * 場域設定匯出、匯入（介面規格 GET /site/export、POST /site/import；T-44）。
 * 匯出：zip（site.json＋平面圖），不含任何秘密。匯入：先比對出新增／修改／刪除（dryRun），
 * 確認後在單一交易中套用，失敗全部還原；平面圖先上傳，交易失敗就刪掉新上傳的。
 * 刪除的處理：機器人改停用（歷史紀錄參照）、有告警紀錄的攝影機與使用中的充電樁改停用、樓層與角色不刪。
 */
@Injectable()
export class SiteTransferService {
  private readonly log = new Logger('SiteTransfer');

  constructor(
    @Inject(KYSELY) private readonly db: Database,
    private readonly storage: StorageService,
    private readonly registry: RobotRegistry,
    private readonly streams: StreamsService,
    private readonly patrol: PatrolService,
    private readonly settings: SettingsService,
  ) {}

  // ===================== 匯出 =====================

  async snapshot(): Promise<{ pkg: SitePackage; plans: Record<string, Uint8Array> }> {
    const db = this.db;
    const plans: Record<string, Uint8Array> = {};
    const floorRows = await db.selectFrom('floors').selectAll().orderBy('sort').orderBy('id').execute();
    const floors: SitePackage['floors'] = [];
    for (const f of floorRows) {
      let plan: string | null = null;
      if (f.plan_key) {
        const body = await this.storage.getBuffer(f.plan_key).catch(() => null);
        const t = body && sniffPlan(body);
        if (body && t) {
          plan = `plans/${f.id}.${t.ext}`;
          plans[plan] = body;
        }
      }
      floors.push({ id: f.id, name: f.name, sort: f.sort, widthM: num(f.width_m), heightM: num(f.height_m), robotQuota: f.robot_quota, plan });
    }
    const robots = (await db.selectFrom('robots').selectAll().orderBy('code').execute()).map((r) => {
      const conn = { ...((r.conn ?? {}) as Record<string, unknown>) };
      for (const k of Object.keys(conn)) if (SECRET_SETTING.test(k)) delete conn[k];
      return {
        code: r.code,
        brand: r.brand as SitePackage['robots'][number]['brand'],
        model: r.model,
        serialNo: r.serial_no,
        floorId: r.floor_id,
        adapter: r.adapter,
        conn,
        caps: r.caps as SitePackage['robots'][number]['caps'],
        modules: (r.modules ?? {}) as Record<string, unknown>,
        params: (r.params ?? {}) as Record<string, unknown>,
        enabled: r.enabled,
      };
    });
    const chargers = (await db.selectFrom('chargers').selectAll().orderBy('code').execute()).map((c) => ({
      code: c.code,
      floorId: c.floor_id,
      x: c.x,
      y: c.y,
      brand: c.brand as SitePackage['chargers'][number]['brand'],
      robotDock: (c.robot_dock ?? {}) as Record<string, unknown>,
      enabled: c.enabled,
    }));
    const cameras = (
      await db
        .selectFrom('cameras')
        .select(['code', 'name', 'floor_id', 'x', 'y', 'enabled'])
        .select(sql<string | null>`CASE WHEN octet_length(rtsp_url) > 0 THEN pgp_sym_decrypt(rtsp_url, ${dataEncKey()}) END`.as('url'))
        .orderBy('code')
        .execute()
    ).map((c) => ({ code: c.code, name: c.name, floorId: c.floor_id, x: c.x, y: c.y, rtspUrl: c.url ? stripCredentials(c.url) : null, enabled: c.enabled }));
    const pois = (await db.selectFrom('pois').selectAll().orderBy('floor_id').orderBy('name').orderBy('id').execute()).map((p) => ({
      floorId: p.floor_id,
      name: p.name,
      x: p.x,
      y: p.y,
      yaw: p.yaw,
      kind: p.kind,
    }));
    const zones = (await db.selectFrom('zones').selectAll().orderBy('floor_id').orderBy('name').orderBy('id').execute()).map((z) => ({ floorId: z.floor_id, name: z.name, kind: z.kind, polygon: z.polygon }));
    const pathRows = await db.selectFrom('paths').selectAll().orderBy('floor_id').orderBy('name').orderBy('id').execute();
    const paths = pathRows.map((p) => ({ floorId: p.floor_id, name: p.name, points: p.points, lengthM: Number(p.length_m) }));
    const pathById = new Map(pathRows.map((p) => [p.id, p]));
    const codeById = new Map((await db.selectFrom('robots').select(['id', 'code']).execute()).map((r) => [r.id, r.code]));
    const patrolSchedules = (await db.selectFrom('patrol_schedules').selectAll().orderBy('name').orderBy('id').execute()).flatMap((s) => {
      const p = pathById.get(s.path_id);
      if (!p) return [];
      return [
        {
          name: s.name,
          path: { floorId: p.floor_id, name: p.name },
          robotCode: s.robot_id ? (codeById.get(s.robot_id) ?? null) : null,
          startTime: hhmm(s.start_time),
          repeat: s.repeat,
          onceDate: s.once_date,
          loops: s.loops,
          priority: s.priority,
          enabled: s.enabled,
        },
      ];
    });
    const taskTemplates = (await db.selectFrom('task_templates').selectAll().orderBy('name').orderBy('id').execute()).map((t) => ({
      name: t.name,
      kind: t.kind,
      priority: t.priority,
      floorId: t.floor_id,
      target: t.target ?? null,
    }));
    const settings: Record<string, unknown> = {};
    for (const s of await db.selectFrom('settings').select(['key', 'value']).orderBy('key').execute()) {
      if (!SECRET_SETTING.test(s.key) && !LOCAL_SETTINGS.test(s.key)) settings[s.key] = s.value;
    }
    const alarmRules = (await db.selectFrom('alarm_rules').selectAll().orderBy('type').execute()).map((a) => ({
      type: a.type,
      category: a.category,
      name: a.name,
      level: a.level,
      popup: a.popup,
      sound: a.sound,
      needHandle: a.need_handle,
      dedupSec: a.dedup_sec,
    }));
    const roles = (await db.selectFrom('roles').select(['name', 'description', 'perms']).orderBy('name').execute()).map((r) => ({ name: r.name, description: r.description, perms: r.perms }));
    const pkg: SitePackage = {
      version: SITE_VERSION,
      exportedAt: new Date().toISOString(),
      floors,
      robots,
      chargers,
      cameras,
      pois,
      zones,
      paths,
      patrolSchedules,
      taskTemplates,
      settings,
      alarmRules,
      roles,
    };
    return { pkg, plans };
  }

  async exportZip(): Promise<Buffer> {
    const { pkg, plans } = await this.snapshot();
    const readme = [
      'OViiAI 場域設定包',
      `匯出時間：${pkg.exportedAt}`,
      '',
      '內容：樓層與平面圖、機器人、充電樁、攝影機、興趣點、區域、路徑、巡邏排程、任務範本、派工充電告警規則、角色。',
      '不含：使用者帳號、攝影機 RTSP 帳密、機器人連線密碼、轉接器金鑰、座標校正、歷史資料（任務、告警、影像）。',
      '匯入後：到「地圖管理」重新輸入攝影機帳密、「機器人管理」輸入連線密碼，並在現場重做座標校正。',
      '',
    ].join('\r\n');
    const files: Record<string, Uint8Array> = { 'site.json': strToU8(JSON.stringify(pkg, null, 2)), '說明.txt': strToU8(readme) };
    for (const [k, v] of Object.entries(plans)) files[k] = v;
    return Buffer.from(zipSync(files, { level: 6 }));
  }

  // ===================== 匯入 =====================

  /** 讀上傳檔：zip（site.json＋plans/）或單獨的 site.json */
  read(buf: Buffer): { pkg: SitePackage; plans: Record<string, Uint8Array> } {
    let json: string;
    let plans: Record<string, Uint8Array> = {};
    if (buf[0] === 0x50 && buf[1] === 0x4b) {
      let files: Record<string, Uint8Array>;
      try {
        let total = 0;
        files = unzipSync(buf, {
          filter: (f) => {
            total += f.originalSize;
            // 解壓縮炸彈：宣告的總大小過大就拒絕
            if (total > PACKAGE_MAX_BYTES * 2) throw new AppError('VALIDATION_FAILED', '設定包解壓縮後太大');
            return f.name === 'site.json' || /^plans\/[a-z0-9]{1,8}\.(png|jpg|webp)$/.test(f.name);
          },
        });
      } catch (e) {
        if (e instanceof AppError) throw e;
        throw new AppError('VALIDATION_FAILED', '無法解開設定包（不是有效的 zip）');
      }
      if (!files['site.json']) throw new AppError('VALIDATION_FAILED', '設定包裡沒有 site.json');
      json = strFromU8(files['site.json']);
      delete files['site.json'];
      plans = files;
    } else json = buf.toString('utf8').replace(/^﻿/, '');
    let raw: unknown;
    try {
      raw = JSON.parse(json);
    } catch {
      throw new AppError('VALIDATION_FAILED', 'site.json 不是有效的 JSON');
    }
    const up = upgrade(raw);
    if (up.error) throw new AppError('VALIDATION_FAILED', up.error);
    const parsed = SitePackage.safeParse(up.pkg);
    if (!parsed.success) {
      const issues = parsed.error.issues.slice(0, 20).map((i) => `${i.path.join('.')}：${i.message}`);
      throw new AppError('VALIDATION_FAILED', `site.json 格式錯誤：${issues[0]}`, { issues });
    }
    const pkg = parsed.data;
    for (const f of pkg.floors) {
      if (f.plan && !plans[f.plan]) throw new AppError('VALIDATION_FAILED', `設定包缺少 ${f.plan}`);
      if (f.plan && !sniffPlan(Buffer.from(plans[f.plan]))) throw new AppError('VALIDATION_FAILED', `${f.plan} 不是 PNG、JPEG 或 WebP`);
    }
    this.checkRefs(pkg);
    return { pkg, plans };
  }

  /** 設定包內部的參照：樓層存在、排程的路徑存在 */
  private checkRefs(pkg: SitePackage) {
    const floors = new Set(pkg.floors.map((f) => f.id));
    const bad: string[] = [];
    const need = (what: string, floorId: string | null) => floorId && !floors.has(floorId) && bad.push(`${what}的樓層 ${floorId} 不在設定包中`);
    for (const r of pkg.robots) need(`機器人 ${r.code} `, r.floorId);
    for (const c of pkg.chargers) need(`充電樁 ${c.code} `, c.floorId);
    for (const c of pkg.cameras) need(`攝影機 ${c.code} `, c.floorId);
    for (const p of [...pkg.pois, ...pkg.zones, ...pkg.paths]) need(`${p.name} `, p.floorId);
    for (const t of pkg.taskTemplates) need(`任務範本 ${t.name} `, t.floorId);
    const paths = new Set(pkg.paths.map((p) => `${p.floorId}/${p.name}`));
    for (const s of pkg.patrolSchedules) if (!paths.has(`${s.path.floorId}/${s.path.name}`)) bad.push(`巡邏排程 ${s.name} 的路徑 ${s.path.name} 不在設定包中`);
    for (const [kind, codes] of [
      ['機器人', pkg.robots.map((r) => r.code)],
      ['充電樁', pkg.chargers.map((c) => c.code)],
      ['攝影機', pkg.cameras.map((c) => c.code)],
      ['樓層', pkg.floors.map((f) => f.id)],
      ['角色', pkg.roles.map((r) => r.name)],
    ] as const) {
      const seen = new Set<string>();
      for (const c of codes) if (seen.has(c) || !seen.add(c)) bad.push(`${kind} ${c} 重複`);
    }
    if (bad.length) throw new AppError('VALIDATION_FAILED', `設定包內容不一致：${bad[0]}`, { issues: bad.slice(0, 20) });
  }

  /** 比對設定包與目前系統（dryRun 與正式匯入共用） */
  async preview(pkg: SitePackage, plans: Record<string, Uint8Array>): Promise<Omit<ImportPreview, 'applied'>> {
    const { pkg: cur, plans: curPlans } = await this.snapshot();
    const db = this.db;
    const camerasWithAlarms = new Set(
      (await db.selectFrom('alarms').innerJoin('cameras', 'cameras.id', 'alarms.camera_id').select('cameras.code').distinct().execute()).map((r) => r.code),
    );
    const occupied = new Set((await db.selectFrom('chargers').select('code').where('occupied_by', 'is not', null).execute()).map((r) => r.code));
    const byCode = <T extends { code: string }>(a: T[]) => a.map((item) => ({ key: item.code, item }));
    // 平面圖以內容雜湊比對
    const planHash = (p: string | null, files: Record<string, Uint8Array>) => (p && files[p] ? sha(files[p]) : null);
    const floorView = (fs: SitePackage['floors'], files: Record<string, Uint8Array>) =>
      fs.map((f) => ({ key: f.id, item: { ...f, plan: planHash(f.plan, files) } }));

    const sections: Section[] = [
      { entity: 'floors', changes: diff(floorView(pkg.floors, plans), floorView(cur.floors, curPlans), () => ({ action: 'keep', note: '樓層不自動刪除' })) },
      { entity: 'robots', changes: diff(byCode(pkg.robots), byCode(cur.robots), (r) => (r.enabled ? { action: 'disable', note: '有歷史紀錄，改為停用' } : { action: 'keep', note: '已停用' })) },
      { entity: 'chargers', changes: diff(byCode(pkg.chargers), byCode(cur.chargers), (c) => (occupied.has(c.code) ? { action: 'disable', note: '使用中，改為停用' } : { action: 'delete' })) },
      {
        entity: 'cameras',
        // RTSP：已存在的攝影機保留原本的帳密與位址，不比對
        changes: diff(
          byCode(pkg.cameras.map(({ rtspUrl: _r, ...c }) => c)),
          byCode(cur.cameras.map(({ rtspUrl: _r, ...c }) => c)),
          (c) => (camerasWithAlarms.has(c.code) ? (c.enabled ? { action: 'disable', note: '有告警紀錄，改為停用' } : { action: 'keep', note: '已停用' }) : { action: 'delete' }),
        ),
      },
      { entity: 'pois', changes: diff(keyed(pkg.pois, (p) => `${p.floorId}/${p.name}`), keyed(cur.pois, (p) => `${p.floorId}/${p.name}`), () => ({ action: 'delete' })) },
      { entity: 'zones', changes: diff(keyed(pkg.zones, (p) => `${p.floorId}/${p.name}`), keyed(cur.zones, (p) => `${p.floorId}/${p.name}`), () => ({ action: 'delete' })) },
      {
        entity: 'paths',
        changes: diff(
          keyed(pkg.paths, (p) => `${p.floorId}/${p.name}`).map(({ key, item: { lengthM: _l, ...p } }) => ({ key, item: p })),
          keyed(cur.paths, (p) => `${p.floorId}/${p.name}`).map(({ key, item: { lengthM: _l, ...p } }) => ({ key, item: p })),
          () => ({ action: 'delete' }),
        ),
      },
      { entity: 'patrolSchedules', changes: diff(keyed(pkg.patrolSchedules, (s) => s.name), keyed(cur.patrolSchedules, (s) => s.name), () => ({ action: 'delete' })) },
      { entity: 'taskTemplates', changes: diff(keyed(pkg.taskTemplates, (s) => s.name), keyed(cur.taskTemplates, (s) => s.name), () => ({ action: 'delete' })) },
      {
        entity: 'settings',
        changes: diff(
          Object.entries(this.importableSettings(pkg.settings).ok).map(([key, value]) => ({ key, item: { value } })),
          Object.entries(cur.settings).map(([key, value]) => ({ key, item: { value } })),
          () => ({ action: 'keep' }),
        ).filter((c) => c.action !== 'keep'),
      },
      {
        entity: 'alarmRules',
        changes: diff(
          pkg.alarmRules.map((a) => ({ key: a.type, item: a })),
          cur.alarmRules.map((a) => ({ key: a.type, item: a })),
          () => ({ action: 'keep' }),
        )
          .filter((c) => c.action !== 'keep')
          .map((c) => (c.action === 'add' ? { ...c, action: 'keep' as const, note: '這套系統沒有這種告警，略過' } : c)),
      },
      {
        entity: 'roles',
        changes: diff(
          pkg.roles.map((r) => ({ key: r.name, item: { description: r.description, perms: [...validPerms(r.perms)].sort() } })),
          cur.roles.map((r) => ({ key: r.name, item: { description: r.description, perms: [...r.perms].sort() } })),
          () => ({ action: 'keep', note: '角色不自動刪除' }),
        ),
      },
    ];
    const summary: Record<Action, number> = { add: 0, update: 0, delete: 0, disable: 0, keep: 0 };
    for (const s of sections) for (const c of s.changes) summary[c.action]++;
    const warnings: string[] = [];
    const newCams = sections.find((s) => s.entity === 'cameras')!.changes.filter((c) => c.action === 'add').length;
    if (newCams) warnings.push(`新增的 ${newCams} 支攝影機沒有 RTSP 帳密，匯入後請到「地圖管理」重新輸入`);
    const newRobots = sections.find((s) => s.entity === 'robots')!.changes.filter((c) => c.action === 'add').length;
    if (newRobots) warnings.push(`新增的 ${newRobots} 台機器人沒有連線密碼，需要的請到「機器人管理」輸入；座標校正要在現場重做`);
    const skipped = this.importableSettings(pkg.settings).skipped;
    if (skipped.length) warnings.push(`略過不合法或不屬於場域設定的規則：${skipped.join('、')}`);
    const droppedPerms = pkg.roles.flatMap((r) => r.perms.filter((p) => !(ALL_PERMS as readonly string[]).includes(p)));
    if (droppedPerms.length) warnings.push(`這套系統沒有的權限碼會略過：${[...new Set(droppedPerms)].join('、')}`);
    return { version: pkg.version, summary, sections, warnings };
  }

  /** 只匯入認得且合法的規則；秘密、登入政策不匯入 */
  private importableSettings(src: Record<string, unknown>): { ok: Record<string, unknown>; skipped: string[] } {
    const ok: Record<string, unknown> = {};
    const skipped: string[] = [];
    for (const [k, v] of Object.entries(src)) {
      const valid =
        !SECRET_SETTING.test(k) &&
        !LOCAL_SETTINGS.test(k) &&
        (k in RULES ? RULES[k as RuleKey].schema.safeParse(v).success : CHARGE_MODE.test(k) ? ChargeModeValue.safeParse(v).success : (EXTRA_SETTINGS[k]?.(v) ?? false));
      if (valid) ok[k] = v;
      else skipped.push(k);
    }
    return { ok, skipped };
  }

  /** 正式匯入：重新比對後在單一交易中套用 */
  async apply(pkg: SitePackage, plans: Record<string, Uint8Array>, userId: string): Promise<ImportPreview> {
    const preview = await this.preview(pkg, plans);
    const changesOf = (e: Entity) => new Map(preview.sections.find((s) => s.entity === e)!.changes.map((c) => [c.key, c]));

    // 1. 平面圖先上傳（物件儲存不在交易內）；失敗時刪掉新上傳的
    const floorChanges = changesOf('floors');
    const newPlans = new Map<string, string>();
    try {
      for (const f of pkg.floors) {
        const c = floorChanges.get(f.id);
        if (!f.plan || !(c?.action === 'add' || c?.fields?.includes('plan'))) continue;
        const body = Buffer.from(plans[f.plan]);
        const t = sniffPlan(body)!;
        const key = `plans/${f.id}-${Date.now()}.${t.ext}`;
        await this.storage.put(key, body, t.mime);
        newPlans.set(f.id, key);
      }
    } catch (e) {
      for (const k of newPlans.values()) await this.storage.remove(k).catch(() => undefined);
      throw e;
    }
    const oldPlans: string[] = [];
    try {
      await this.db.transaction().execute(async (trx) => {
        await this.applyFloors(trx, pkg, newPlans, oldPlans);
        // 只寫有差異的（沒變的規則不會被記成這次匯入的人改的）
        await this.applyRoles(trx, pkg, changesOf('roles'));
        await this.applySettings(trx, pkg, userId, changesOf('settings'));
        await this.applyAlarmRules(trx, pkg, changesOf('alarmRules'));
        const robotIds = await this.applyRobots(trx, pkg, changesOf('robots'));
        await this.applyChargers(trx, pkg, changesOf('chargers'));
        await this.applyCameras(trx, pkg, changesOf('cameras'));
        // 排程參照路徑：先刪排程、再處理路徑
        const schedChanges = changesOf('patrolSchedules');
        const curSched = keyed(await trx.selectFrom('patrol_schedules').select(['id', 'name']).orderBy('name').orderBy('id').execute(), (s) => s.name);
        for (const s of curSched) if (schedChanges.get(s.key)?.action === 'delete') await trx.deleteFrom('patrol_schedules').where('id', '=', s.item.id).execute();
        const pathIds = await this.applyNamed(trx, 'paths', pkg.paths, (p) => ({ floor_id: p.floorId, name: p.name, points: JSON.stringify(p.points), length_m: String(p.lengthM) }), changesOf('paths'));
        await this.applyNamed(trx, 'pois', pkg.pois, (p) => ({ floor_id: p.floorId, name: p.name, x: p.x, y: p.y, yaw: p.yaw, kind: p.kind }), changesOf('pois'));
        await this.applyNamed(trx, 'zones', pkg.zones, (z) => ({ floor_id: z.floorId, name: z.name, kind: z.kind, polygon: JSON.stringify(z.polygon) }), changesOf('zones'));
        await this.applySchedules(trx, pkg, curSched, pathIds, robotIds, userId);
        await this.applyTemplates(trx, pkg, changesOf('taskTemplates'));
      });
    } catch (e) {
      for (const k of newPlans.values()) await this.storage.remove(k).catch(() => undefined);
      throw e;
    }
    for (const k of oldPlans) await this.storage.remove(k).catch(() => undefined);
    this.settings.invalidate();
    await this.registry.load();
    void this.streams.sync();
    await this.patrol.sync().catch((e) => this.log.warn(`巡邏排程對齊失敗：${e instanceof Error ? e.message : e}`));
    this.log.log(`場域設定匯入：新增 ${preview.summary.add}、修改 ${preview.summary.update}、刪除 ${preview.summary.delete}、停用 ${preview.summary.disable}`);
    return { ...preview, applied: true };
  }

  // ----- 各類套用 -----

  private async applyFloors(trx: Database, pkg: SitePackage, newPlans: Map<string, string>, oldPlans: string[]) {
    const cur = new Map((await trx.selectFrom('floors').select(['id', 'plan_key']).execute()).map((f) => [f.id, f.plan_key]));
    for (const f of pkg.floors) {
      const vals = {
        name: f.name,
        sort: f.sort,
        width_m: f.widthM === null ? null : String(f.widthM),
        height_m: f.heightM === null ? null : String(f.heightM),
        robot_quota: f.robotQuota,
      };
      const plan = newPlans.get(f.id);
      if (cur.has(f.id)) {
        // 設定包沒有平面圖：保留這套系統原本的圖
        await trx.updateTable('floors').set({ ...vals, ...(plan && { plan_key: plan }) }).where('id', '=', f.id).execute();
        const old = cur.get(f.id);
        if (plan && old) oldPlans.push(old);
      } else await trx.insertInto('floors').values({ id: f.id, ...vals, plan_key: plan ?? null }).execute();
    }
  }

  private async applyRoles(trx: Database, pkg: SitePackage, changes: Map<string, Change>) {
    const cur = new Map((await trx.selectFrom('roles').select(['name', 'is_system']).execute()).map((r) => [r.name, r.is_system]));
    for (const r of pkg.roles) {
      if (!changes.has(r.name)) continue;
      const perms = validPerms(r.perms);
      if (!cur.has(r.name)) await trx.insertInto('roles').values({ name: r.name, description: r.description, perms }).execute();
      // 系統角色（系統管理員）一律保有全部權限，不被設定包改掉
      else if (!cur.get(r.name)) await trx.updateTable('roles').set({ description: r.description, perms }).where('name', '=', r.name).execute();
    }
  }

  private async applySettings(trx: Database, pkg: SitePackage, userId: string, changes: Map<string, Change>) {
    for (const [key, value] of Object.entries(this.importableSettings(pkg.settings).ok)) {
      if (!changes.has(key)) continue;
      await trx
        .insertInto('settings')
        .values({ key, value: JSON.stringify(value), updated_by: userId })
        .onConflict((oc) => oc.column('key').doUpdateSet({ value: JSON.stringify(value), updated_by: userId, updated_at: sql`now()` }))
        .execute();
    }
  }

  private async applyAlarmRules(trx: Database, pkg: SitePackage, changes: Map<string, Change>) {
    for (const a of pkg.alarmRules) {
      if (changes.get(a.type)?.action !== 'update') continue;
      await trx
        .updateTable('alarm_rules')
        .set({ category: a.category, name: a.name, level: a.level, popup: a.popup, sound: a.sound, need_handle: a.needHandle, dedup_sec: a.dedupSec })
        .where('type', '=', a.type)
        .execute();
    }
  }

  private async applyRobots(trx: Database, pkg: SitePackage, changes: Map<string, Change>): Promise<Map<string, string>> {
    for (const r of pkg.robots) {
      const vals = {
        brand: r.brand,
        model: r.model,
        serial_no: r.serialNo,
        floor_id: r.floorId,
        adapter: r.adapter,
        conn: JSON.stringify(r.conn),
        caps: r.caps,
        modules: JSON.stringify(r.modules),
        params: JSON.stringify(r.params),
        enabled: r.enabled,
      };
      const c = changes.get(r.code);
      // 連線密碼不在設定包：已存在的保留原本的
      if (c?.action === 'add') await trx.insertInto('robots').values({ code: r.code, ...vals }).execute();
      else if (c?.action === 'update') await trx.updateTable('robots').set(vals).where('code', '=', r.code).execute();
    }
    for (const [code, c] of changes) if (c.action === 'disable') await trx.updateTable('robots').set({ enabled: false }).where('code', '=', code).execute();
    return new Map((await trx.selectFrom('robots').select(['id', 'code']).execute()).map((r) => [r.code, r.id]));
  }

  private async applyChargers(trx: Database, pkg: SitePackage, changes: Map<string, Change>) {
    for (const c of pkg.chargers) {
      const vals = { floor_id: c.floorId, x: c.x, y: c.y, brand: c.brand, robot_dock: JSON.stringify(c.robotDock), enabled: c.enabled };
      const ch = changes.get(c.code);
      if (ch?.action === 'add') await trx.insertInto('chargers').values({ code: c.code, ...vals }).execute();
      else if (ch?.action === 'update') await trx.updateTable('chargers').set(vals).where('code', '=', c.code).execute();
    }
    for (const [code, c] of changes) {
      if (c.action === 'delete') await trx.deleteFrom('chargers').where('code', '=', code).execute();
      if (c.action === 'disable') await trx.updateTable('chargers').set({ enabled: false }).where('code', '=', code).execute();
    }
  }

  private async applyCameras(trx: Database, pkg: SitePackage, changes: Map<string, Change>) {
    for (const c of pkg.cameras) {
      const vals = { name: c.name, floor_id: c.floorId, x: c.x, y: c.y, enabled: c.enabled };
      const ch = changes.get(c.code);
      if (ch?.action === 'add') {
        await trx
          .insertInto('cameras')
          .values({ code: c.code, ...vals, stream_key: streamKey(c.code), rtsp_url: c.rtspUrl ? sql`pgp_sym_encrypt(${c.rtspUrl}, ${dataEncKey()})` : Buffer.alloc(0) })
          .execute();
      } else if (ch?.action === 'update') await trx.updateTable('cameras').set(vals).where('code', '=', c.code).execute();
    }
    for (const [code, c] of changes) {
      if (c.action === 'delete') await trx.deleteFrom('cameras').where('code', '=', code).execute();
      if (c.action === 'disable') await trx.updateTable('cameras').set({ enabled: false }).where('code', '=', code).execute();
    }
  }

  /** 興趣點、區域、路徑：以「樓層/名稱（#n）」對應；回傳 key → id（排程找路徑用） */
  private async applyNamed<T extends { floorId: string; name: string }>(
    trx: Database,
    table: 'paths' | 'pois' | 'zones',
    items: T[],
    vals: (t: T) => Record<string, unknown>,
    changes: Map<string, Change>,
  ): Promise<Map<string, string>> {
    const cur = keyed(
      (await trx.selectFrom(table).select(['id', 'floor_id', 'name']).orderBy('floor_id').orderBy('name').orderBy('id').execute()) as { id: string; floor_id: string; name: string }[],
      (r) => `${r.floor_id}/${r.name}`,
    );
    // 比對時的順序來自 snapshot（排序同上），這裡依同樣順序對應
    const curByKey = new Map(cur.map((c) => [c.key, c.item.id]));
    for (const c of cur) if (changes.get(c.key)?.action === 'delete') await trx.deleteFrom(table).where('id', '=', c.item.id).execute();
    const ids = new Map<string, string>();
    for (const { key, item } of keyed(items, (p) => `${p.floorId}/${p.name}`)) {
      const ch = changes.get(key);
      const id = curByKey.get(key);
      if (ch?.action === 'add' || !id) {
        const r = await trx.insertInto(table).values(vals(item) as never).returning('id').executeTakeFirstOrThrow();
        ids.set(key, r.id);
      } else {
        if (ch?.action === 'update') await trx.updateTable(table).set(vals(item) as never).where('id', '=', id).execute();
        ids.set(key, id);
      }
    }
    return ids;
  }

  private async applySchedules(
    trx: Database,
    pkg: SitePackage,
    cur: { key: string; item: { id: string; name: string } }[],
    pathIds: Map<string, string>,
    robotIds: Map<string, string>,
    userId: string,
  ) {
    const curByKey = new Map(cur.map((c) => [c.key, c.item.id]));
    const pkgPaths = keyed(pkg.paths, (p) => `${p.floorId}/${p.name}`);
    for (const { key, item: s } of keyed(pkg.patrolSchedules, (x) => x.name)) {
      // 同名路徑時對應第一條
      const pathKey = pkgPaths.find((p) => p.item.floorId === s.path.floorId && p.item.name === s.path.name)!.key;
      const vals = {
        name: s.name,
        path_id: pathIds.get(pathKey)!,
        robot_id: s.robotCode ? (robotIds.get(s.robotCode) ?? null) : null,
        start_time: s.startTime,
        repeat: s.repeat,
        once_date: s.onceDate,
        loops: s.loops,
        priority: s.priority,
        enabled: s.enabled,
      };
      const id = curByKey.get(key);
      if (id) await trx.updateTable('patrol_schedules').set(vals).where('id', '=', id).execute();
      else await trx.insertInto('patrol_schedules').values({ ...vals, created_by: userId }).execute();
    }
  }

  private async applyTemplates(trx: Database, pkg: SitePackage, changes: Map<string, Change>) {
    const cur = keyed(await trx.selectFrom('task_templates').select(['id', 'name']).orderBy('name').orderBy('id').execute(), (t) => t.name);
    const curByKey = new Map(cur.map((c) => [c.key, c.item.id]));
    for (const c of cur) if (changes.get(c.key)?.action === 'delete') await trx.deleteFrom('task_templates').where('id', '=', c.item.id).execute();
    for (const { key, item: t } of keyed(pkg.taskTemplates, (x) => x.name)) {
      const vals = { name: t.name, kind: t.kind, priority: t.priority, floor_id: t.floorId, target: t.target === null || t.target === undefined ? null : JSON.stringify(t.target) };
      const id = curByKey.get(key);
      if (id) await trx.updateTable('task_templates').set(vals).where('id', '=', id).execute();
      else await trx.insertInto('task_templates').values(vals).execute();
    }
  }
}

function validPerms(perms: string[]): string[] {
  return perms.filter((p) => (ALL_PERMS as readonly string[]).includes(p));
}
