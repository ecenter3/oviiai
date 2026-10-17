import { z } from 'zod';
import { BRANDS, CAPS } from '../site/robot-admin.controller';

/**
 * 場域設定包 site.json（介面規格「場域快速設定」；T-44）。
 * 物件一律以代碼或「樓層＋名稱」對應，不含 UUID，才能匯入另一套系統。
 * 不含任何秘密：攝影機 RTSP 只留不含帳密的位址、機器人連線密碼不匯出、轉接器金鑰在 .env、使用者帳號不匯出。
 * 座標校正（robot_map_calib）也不匯出：換場域後機器人地圖不同，必須在現場重做。
 */
export const SITE_VERSION = 1;

const Code = z.string().regex(/^[A-Z0-9][A-Z0-9-]{1,31}$/);
const FloorId = z.string().regex(/^[a-z0-9]{1,8}$/);
const Coord = z.number().finite().min(-10_000).max(10_000);
/** 名稱長度以資料庫為準（管理頁限 32 字，但不拒絕既有資料），設定包只擋明顯異常 */
const Name = z.string().trim().min(1).max(100);
/** 巡邏點（同導航管理的 Waypoint：x、y、yaw、停留秒數、到點動作） */
const Waypoint = z
  .object({ x: Coord, y: Coord, yaw: z.number().finite().optional(), dwellSec: z.number().int().min(0).max(3600).optional(), action: z.string().max(32).optional() })
  .strict();
const Json = z.record(z.unknown());

export const SitePackage = z
  .object({
    version: z.literal(SITE_VERSION),
    exportedAt: z.string(),
    floors: z.array(
      z
        .object({
          id: FloorId,
          name: Name,
          sort: z.number().int(),
          widthM: z.number().positive().nullable(),
          heightM: z.number().positive().nullable(),
          robotQuota: z.number().int().min(0),
          /** zip 裡平面圖的路徑（plans/<樓層>.<副檔名>） */
          plan: z.string().regex(/^plans\/[a-z0-9]{1,8}\.(png|jpg|webp)$/).nullable(),
        })
        .strict(),
    ),
    robots: z.array(
      z
        .object({
          code: Code,
          brand: z.enum(BRANDS),
          model: z.string().min(1).max(64),
          serialNo: z.string().max(64).nullable(),
          floorId: FloorId,
          adapter: z.string().regex(/^[a-z0-9_-]{1,32}$/),
          /** 非敏感連線設定（主機、埠號、帳號）；密碼不匯出 */
          conn: Json,
          caps: z.array(z.enum(CAPS)),
          modules: Json,
          params: Json,
          enabled: z.boolean(),
        })
        .strict(),
    ),
    chargers: z.array(
      z
        .object({ code: Code, floorId: FloorId, x: Coord, y: Coord, brand: z.enum(BRANDS), robotDock: Json, enabled: z.boolean() })
        .strict(),
    ),
    cameras: z.array(
      z
        .object({
          code: Code,
          name: Name,
          floorId: FloorId,
          x: Coord,
          y: Coord,
          /** 不含帳密的 RTSP 位址；帳密匯入後在地圖管理重新輸入 */
          rtspUrl: z.string().max(500).regex(/^rtsps?:\/\/[^@/]*(\/|$)/, 'RTSP 位址不可含帳密').nullable(),
          enabled: z.boolean(),
        })
        .strict(),
    ),
    pois: z.array(
      z.object({ floorId: FloorId, name: Name, x: Coord, y: Coord, yaw: z.number().finite().nullable(), kind: z.enum(['poi', 'parking']) }).strict(),
    ),
    zones: z.array(
      z
        .object({ floorId: FloorId, name: Name, kind: z.enum(['forbidden', 'slow', 'silent']), polygon: z.array(z.tuple([Coord, Coord])).min(3).max(200) })
        .strict(),
    ),
    paths: z.array(
      z
        .object({
          floorId: FloorId,
          name: Name,
          points: z.array(Waypoint).min(2).max(500),
          lengthM: z.number().min(0),
        })
        .strict(),
    ),
    patrolSchedules: z.array(
      z
        .object({
          name: Name,
          path: z.object({ floorId: FloorId, name: Name }).strict(),
          robotCode: Code.nullable(),
          startTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
          repeat: z.enum(['daily', 'weekdays', 'weekends', 'once']),
          onceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
          loops: z.number().int().min(1).max(100),
          priority: z.string().regex(/^P[1-4]$/),
          enabled: z.boolean(),
        })
        .strict(),
    ),
    taskTemplates: z.array(
      z.object({ name: Name, kind: z.string().min(1).max(64), priority: z.string().regex(/^P[1-4]$/), floorId: FloorId.nullable(), target: z.unknown() }).strict(),
    ),
    /** 派工、充電、告警、媒體等規則（settings 表，不含秘密） */
    settings: z.record(z.unknown()),
    alarmRules: z.array(
      z
        .object({
          type: z.string().min(1).max(64),
          category: z.enum(['system', 'business']),
          name: z.string().min(1).max(64),
          level: z.number().int().min(1).max(3),
          popup: z.boolean(),
          sound: z.boolean(),
          needHandle: z.boolean(),
          dedupSec: z.number().int().min(0),
        })
        .strict(),
    ),
    roles: z.array(z.object({ name: Name, description: z.string().max(500).nullable(), perms: z.array(z.string().max(64)).max(200) }).strict()),
  })
  .strict();
export type SitePackage = z.infer<typeof SitePackage>;

/** 設定值的鍵含這些字的一律不匯出、不匯入（之後若加上簽章金鑰、外部系統密碼等） */
export const SECRET_SETTING = /(secret|password|token|apikey|api_key|credential|\.key$)/i;

/** rtsp://帳號:密碼@主機/路徑 → rtsp://主機/路徑 */
export function stripCredentials(url: string): string {
  return url.replace(/^(rtsps?:\/\/)[^@/]*@/i, '$1');
}

/**
 * 版本轉換：舊版設定包先轉成目前版本；比目前新的拒絕（介面規格：無法轉換則拒絕並說明原因）。
 * 目前只有第 1 版；之後改格式時在 CONVERTERS 加 n → n+1 的轉換。
 */
const CONVERTERS: Record<number, (pkg: Record<string, unknown>) => Record<string, unknown>> = {};

export function upgrade(raw: unknown): { pkg?: unknown; error?: string } {
  if (!raw || typeof raw !== 'object') return { error: 'site.json 不是 JSON 物件' };
  let pkg = raw as Record<string, unknown>;
  const v = pkg.version;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) return { error: 'site.json 缺少版本（version）' };
  if (v > SITE_VERSION) return { error: `設定包是第 ${v} 版，比這套系統支援的第 ${SITE_VERSION} 版新，請先更新系統` };
  for (let n = v; n < SITE_VERSION; n++) {
    const conv = CONVERTERS[n];
    if (!conv) return { error: `無法把第 ${n} 版設定包轉成第 ${n + 1} 版` };
    pkg = conv(pkg);
  }
  return { pkg };
}
