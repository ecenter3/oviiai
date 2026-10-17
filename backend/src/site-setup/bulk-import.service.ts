import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import type { z } from 'zod';
import { AppError } from '../common/errors';
import { dataEncKey } from '../config';
import { KYSELY, type Database } from '../db/database.module';
import { RobotRegistry } from '../fleet/robot-registry';
import { CameraBody, streamKey } from '../maps/map-admin.controller';
import { StreamsService } from '../media/streams.service';
import { BRANDS, CAPS, CreateRobot } from '../site/robot-admin.controller';
import { type Column, parseTable, type TableRow, writeTemplate } from './table-file';

export type ImportKind = 'cameras' | 'robots';

export const COLUMNS: Record<ImportKind, Column[]> = {
  cameras: [
    { key: 'code', label: '代碼', aliases: ['攝影機代碼'], required: true, hint: '大寫英數與連字號，例：CAM-1F-07。已存在的代碼會更新那一支', example: 'CAM-1F-07' },
    { key: 'name', label: '名稱', required: true, hint: '最多 32 字', example: '1F 大門' },
    { key: 'floorId', label: '樓層', aliases: ['樓層代碼', 'floor'], required: true, hint: '樓層代碼（地圖管理裡的樓層 ID），例：1f、2f、b1', example: '1f' },
    { key: 'x', label: 'X（公尺）', aliases: ['x', 'X'], required: true, hint: '平面圖上的位置，從左上角起算，公尺', example: '12.5' },
    { key: 'y', label: 'Y（公尺）', aliases: ['y', 'Y'], required: true, hint: '同上', example: '3' },
    { key: 'rtspUrl', label: 'RTSP 位址', aliases: ['rtsp', 'rtsp_url'], hint: '含帳密，例：rtsp://帳號:密碼@10.0.0.20/stream1；加密存放。新增必填；更新時留空表示不變', example: 'rtsp://admin:password@10.0.0.20/stream1' },
    { key: 'enabled', label: '啟用', hint: '是／否，留空為是', example: '是' },
  ],
  robots: [
    { key: 'code', label: '代碼', aliases: ['機器人代碼'], required: true, hint: '大寫英數與連字號，例：B2-003。已存在的代碼會更新那一台', example: 'B2-003' },
    { key: 'brand', label: '品牌', required: true, hint: `${BRANDS.join('、')}（anbot＝萬為、unitree＝宇樹、deep＝雲深處）。已存在的機器人不能改品牌`, example: 'unitree' },
    { key: 'model', label: '型號', required: true, hint: '例：B2、X30、ANBOT-Y', example: 'B2' },
    { key: 'serialNo', label: '序號', hint: '可留空', example: 'B2-SN-0003' },
    { key: 'floorId', label: '樓層', aliases: ['樓層代碼', 'floor'], required: true, hint: '樓層代碼，例：1f', example: '1f' },
    { key: 'adapter', label: '轉接器', required: true, hint: '轉接器名稱（小寫英數），例：unitree_b2、deep_x30、anbot、mock', example: 'unitree_b2' },
    { key: 'host', label: '主機', aliases: ['ip', 'IP'], hint: '機器人 IP 或主機名稱', example: '192.168.123.161' },
    { key: 'port', label: '埠號', aliases: ['port'], hint: '1–65535，可留空', example: '' },
    { key: 'username', label: '帳號', hint: '連線帳號，可留空', example: '' },
    { key: 'secret', label: '密碼', aliases: ['連線密碼'], hint: '連線密碼，加密存放；更新時留空表示不變', example: '' },
    { key: 'caps', label: '能力', hint: `逗號分隔：${CAPS.join('、')}（雲台、燈光、語音播放、即時對講、跟隨、升降桿、環境感測）`, example: 'ptz,light' },
    { key: 'enabled', label: '啟用', hint: '是／否，留空為是（停用的機器人轉接器不會連線）', example: '是' },
  ],
};

export interface RowError {
  field: string;
  message: string;
}
export interface RowResult {
  rowNo: number;
  code: string;
  action: 'create' | 'update' | null;
  errors: RowError[];
}
export interface ImportResult {
  kind: ImportKind;
  total: number;
  valid: number;
  invalid: number;
  imported: number;
  rows: RowResult[];
}

const YES = new Set(['是', 'y', 'yes', 'true', '1', 'v', '啟用']);
const NO = new Set(['否', 'n', 'no', 'false', '0', '停用']);
function bool(s: string | undefined): boolean | string {
  if (s === undefined || s === '') return true;
  const v = s.trim().toLowerCase();
  if (YES.has(v)) return true;
  if (NO.has(v)) return false;
  return s; // 讓 schema 報錯
}
const num = (s: string | undefined) => (s === undefined || s === '' ? undefined : Number.isFinite(Number(s)) ? Number(s) : s);

type CameraRow = z.infer<typeof CameraBody>;
type RobotRow = z.infer<typeof CreateRobot> & { enabled: boolean };
interface Floors {
  get(id: string): { w: number | null; h: number | null } | undefined;
}

/**
 * 攝影機與機器人批次匯入（介面規格 POST /cameras/import、/robots/import、GET /import/templates/:kind；T-45）。
 * 每列沿用單筆新增的驗證（CameraBody、CreateRobot），再檢查樓層、座標範圍、檔內代碼重複；
 * 代碼已存在就更新那一筆。正式匯入只寫入正確的列，在同一個交易中完成。
 */
@Injectable()
export class BulkImportService {
  private readonly log = new Logger('BulkImport');

  constructor(
    @Inject(KYSELY) private readonly db: Database,
    private readonly registry: RobotRegistry,
    private readonly streams: StreamsService,
  ) {}

  template(kind: ImportKind, format: 'xlsx' | 'csv') {
    return writeTemplate(COLUMNS[kind], format, kind === 'cameras' ? '攝影機' : '機器人');
  }

  async run(kind: ImportKind, buf: Buffer, filename: string, dryRun: boolean): Promise<ImportResult> {
    const rows = await parseTable(buf, filename, COLUMNS[kind]);
    const floors = await this.floors();
    const checked = kind === 'cameras' ? await this.checkCameras(rows, floors) : await this.checkRobots(rows, floors);
    const good = checked.filter((c) => !c.result.errors.length);
    let imported = 0;
    if (!dryRun && good.length) {
      await this.db.transaction().execute(async (trx) => {
        for (const c of good) {
          if (kind === 'cameras') await this.writeCamera(trx, c.data as CameraRow, c.result.action === 'update');
          else await this.writeRobot(trx, c.data as RobotRow, c.result.action === 'update');
          imported++;
        }
      });
      if (kind === 'robots') await this.registry.load();
      void this.streams.sync();
      this.log.log(`${kind} 批次匯入 ${imported} 筆（略過 ${checked.length - good.length} 筆錯誤列）`);
    }
    return {
      kind,
      total: checked.length,
      valid: good.length,
      invalid: checked.length - good.length,
      imported,
      rows: checked.map((c) => c.result),
    };
  }

  // ===== 檢查 =====

  private async checkCameras(rows: TableRow[], floors: Floors) {
    const existing = new Set((await this.db.selectFrom('cameras').select('code').execute()).map((r) => r.code));
    const seen = new Map<string, number>();
    return rows.map((r) => {
      const v = r.values;
      const code = (v.code ?? '').toUpperCase();
      const update = existing.has(code);
      const input = {
        code,
        name: v.name ?? '',
        floorId: (v.floorId ?? '').toLowerCase(),
        x: num(v.x),
        y: num(v.y),
        ...(v.rtspUrl ? { rtspUrl: v.rtspUrl } : {}),
        enabled: bool(v.enabled),
      };
      // 更新時 RTSP 可留空（不變）
      const schema = update ? CameraBody.partial({ rtspUrl: true }) : CameraBody;
      const parsed = schema.safeParse(input);
      const errors = issues(parsed, 'cameras');
      if (!update && !v.rtspUrl) errors.splice(0, errors.length, ...errors.filter((e) => e.field !== 'rtspUrl'), { field: 'rtspUrl', message: '新增的攝影機必須填 RTSP 位址' });
      this.dup(seen, code, r.rowNo, errors);
      if (parsed.success) this.point(floors, parsed.data.floorId, parsed.data.x, parsed.data.y, errors);
      return { data: parsed.success ? parsed.data : null, result: { rowNo: r.rowNo, code, action: errors.length ? null : update ? 'update' : 'create', errors } as RowResult };
    });
  }

  private async checkRobots(rows: TableRow[], floors: Floors) {
    const existing = new Map((await this.db.selectFrom('robots').select(['code', 'brand']).execute()).map((r) => [r.code, r.brand]));
    const seen = new Map<string, number>();
    return rows.map((r) => {
      const v = r.values;
      const code = (v.code ?? '').toUpperCase();
      const brand = (v.brand ?? '').toLowerCase();
      const port = num(v.port);
      const input = {
        code,
        brand,
        model: v.model ?? '',
        serialNo: v.serialNo || null,
        floorId: (v.floorId ?? '').toLowerCase(),
        adapter: (v.adapter ?? '').toLowerCase(),
        conn: { ...(v.host ? { host: v.host } : {}), ...(port !== undefined ? { port } : {}), ...(v.username ? { username: v.username } : {}) },
        ...(v.secret ? { secret: v.secret } : {}),
        caps: (v.caps ?? '').split(/[,，、\s]+/).map((c) => c.trim().toLowerCase()).filter(Boolean),
      };
      const parsed = CreateRobot.safeParse(input);
      const errors = issues(parsed, 'robots');
      const enabled = bool(v.enabled);
      if (typeof enabled !== 'boolean') errors.push({ field: 'enabled', message: '請填「是」或「否」' });
      const prevBrand = existing.get(code);
      if (prevBrand && brand && prevBrand !== brand) errors.push({ field: 'brand', message: `已存在的 ${code} 是 ${prevBrand}，不能改品牌` });
      this.dup(seen, code, r.rowNo, errors);
      if (parsed.success && !floors.get(parsed.data.floorId)) errors.push({ field: 'floorId', message: `樓層 ${parsed.data.floorId} 不存在` });
      const data = parsed.success ? { ...parsed.data, enabled: enabled === true } : null;
      return { data, result: { rowNo: r.rowNo, code, action: errors.length ? null : prevBrand ? 'update' : 'create', errors } as RowResult };
    });
  }

  private dup(seen: Map<string, number>, code: string, rowNo: number, errors: RowError[]) {
    if (!code) return;
    const first = seen.get(code);
    if (first !== undefined) errors.push({ field: 'code', message: `代碼與第 ${first} 列重複` });
    else seen.set(code, rowNo);
  }

  private point(floors: Floors, floorId: string, x: number, y: number, errors: RowError[]) {
    const f = floors.get(floorId);
    if (!f) return void errors.push({ field: 'floorId', message: `樓層 ${floorId} 不存在` });
    if (f.w !== null && x > f.w) errors.push({ field: 'x', message: `超出樓層寬度 ${f.w} 公尺` });
    if (f.h !== null && y > f.h) errors.push({ field: 'y', message: `超出樓層高度 ${f.h} 公尺` });
  }

  private async floors(): Promise<Floors> {
    const rows = await this.db.selectFrom('floors').select(['id', 'width_m', 'height_m']).execute();
    const m = new Map(rows.map((f) => [f.id, { w: f.width_m === null ? null : Number(f.width_m), h: f.height_m === null ? null : Number(f.height_m) }]));
    return { get: (id) => m.get(id) };
  }

  // ===== 寫入 =====

  private async writeCamera(trx: Database, b: Partial<CameraRow> & Omit<CameraRow, 'rtspUrl'>, update: boolean) {
    const rtsp = b.rtspUrl ? sql`pgp_sym_encrypt(${b.rtspUrl}, ${dataEncKey()})` : undefined;
    if (update) {
      await trx
        .updateTable('cameras')
        .set({ name: b.name, floor_id: b.floorId, x: b.x, y: b.y, enabled: b.enabled, ...(rtsp && { rtsp_url: rtsp }) })
        .where('code', '=', b.code)
        .execute();
    } else {
      await trx
        .insertInto('cameras')
        .values({ code: b.code, name: b.name, floor_id: b.floorId, x: b.x, y: b.y, rtsp_url: rtsp!, stream_key: streamKey(b.code), enabled: b.enabled })
        .execute();
    }
  }

  private async writeRobot(trx: Database, b: RobotRow, update: boolean) {
    const secret = b.secret ? sql`pgp_sym_encrypt(${b.secret}, ${dataEncKey()})` : undefined;
    const common = {
      model: b.model,
      serial_no: b.serialNo ?? null,
      floor_id: b.floorId,
      adapter: b.adapter,
      conn: JSON.stringify(b.conn),
      caps: b.caps,
      enabled: b.enabled,
    };
    if (update) {
      await trx.updateTable('robots').set({ ...common, ...(secret && { conn_secret: secret }) }).where('code', '=', b.code).execute();
    } else {
      await trx.insertInto('robots').values({ ...common, code: b.code, brand: b.brand, conn_secret: secret ?? null, modules: '{}' }).execute();
    }
  }
}

/** zod 錯誤 → 欄位＋中文訊息（欄位名稱用範本標題） */
function issues(parsed: { success: boolean; error?: z.ZodError }, kind: ImportKind): RowError[] {
  if (parsed.success || !parsed.error) return [];
  const out: RowError[] = [];
  for (const i of parsed.error.issues) {
    let field = String(i.path[0] ?? '');
    if (field === 'conn') field = String(i.path[1] ?? 'host');
    if (out.some((e) => e.field === field)) continue;
    out.push({ field, message: message(i, kind, field) });
  }
  return out;
}

function message(i: z.ZodIssue, kind: ImportKind, field: string): string {
  const label = COLUMNS[kind].find((c) => c.key === field)?.label ?? field;
  if (i.code === 'invalid_type') return i.received === 'undefined' || i.received === 'null' ? `${label}必填` : `${label}格式錯誤`;
  if (i.code === 'invalid_enum_value') return `${label}只能是 ${i.options.join('、')}`;
  if (i.code === 'too_small') return i.type === 'string' ? `${label}必填` : `${label}不能小於 ${i.minimum}`;
  if (i.code === 'too_big') return i.type === 'string' ? `${label}太長（最多 ${i.maximum} 字）` : `${label}不能大於 ${i.maximum}`;
  return `${label}：${i.message}`;
}

export const IMPORT_KINDS = ['cameras', 'robots'] as const;
export function assertKind(k: string): ImportKind {
  if (!(IMPORT_KINDS as readonly string[]).includes(k)) throw new AppError('NOT_FOUND', '只有 cameras、robots 兩種範本');
  return k as ImportKind;
}
