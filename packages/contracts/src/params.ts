/**
 * 機器人參數四個子系統（系統規格書 §8「機器人參數」、T-27；欄位與預設值對照原型 PARAM_SCHEMA）。
 * 前端依這份清單畫表單，後端依這份清單驗證，兩邊不會各寫一份。
 * 值一律存代碼（如 'safe'），顯示文字在前端 i18n `params.opt.<代碼>`。
 *
 * 轉接器收到 set_params {params: 四個子系統的完整值}，各品牌只套用 SDK 支援的項目；
 * 共通層用 walk.speed 限制遙控速度（機器人接入 §2：速度上限依參數「導航速度」）。
 */
import { z } from 'zod';

export type ParamField =
  | { k: string; t: 'slider'; min: number; max: number; step: number; unit?: string; def: number }
  | { k: string; t: 'num'; min: number; max: number; unit: string; def: number }
  | { k: string; t: 'switch'; def: boolean }
  | { k: string; t: 'radio'; opts: readonly string[]; def: string }
  | { k: string; t: 'checks'; opts: readonly string[]; def: readonly string[] }
  | { k: string; t: 'time2'; def: readonly [string, string] }
  | { k: string; t: 'text'; max: number; def: string }
  /** 識別反應：[反應方式, 交互服務開關] */
  | { k: string; t: 'react'; def: readonly [string, boolean] };

/** 表單分段標題（只用來顯示） */
export type ParamItem = ParamField | { sec: string };

export const REACT_ACTIONS = ['none', 'greet', 'prompt', 'alarm', 'notify'] as const;

export const PARAM_SUBSYSTEMS = ['walk', 'video', 'talk', 'ext'] as const;
export type ParamSubsystem = (typeof PARAM_SUBSYSTEMS)[number];

export const PARAM_SCHEMA: Record<ParamSubsystem, readonly ParamItem[]> = {
  walk: [
    { k: 'speed', t: 'slider', min: 0.2, max: 1.5, step: 0.1, unit: 'm/s', def: 0.8 },
    { k: 'hardStop', t: 'switch', def: true },
    { k: 'strobe', t: 'switch', def: true },
    { k: 'strobeTimer', t: 'switch', def: false },
    { k: 'strobeTime', t: 'time2', def: ['18:00', '06:00'] },
    { k: 'lightTimer', t: 'switch', def: false },
    { k: 'lightTime', t: 'time2', def: ['18:00', '06:00'] },
    { k: 'collide', t: 'radio', opts: ['normal', 'safe', 'off'], def: 'normal' },
    { k: 'avoid', t: 'radio', opts: ['stopFront', 'detour', 'stopThree'], def: 'detour' },
  ],
  video: [
    { k: 'stream', t: 'radio', opts: ['normal', 'saving', 'patrol'], def: 'normal' },
    { k: 'adapt', t: 'switch', def: true },
    { k: 'face', t: 'checks', opts: ['front', 'rear'], def: ['front'] },
    { k: 'faceTime', t: 'time2', def: ['00:00', '23:59'] },
    { k: 'ptzX', t: 'slider', min: -1, max: 1, step: 0.1, def: 0.1 },
    { k: 'ptzY', t: 'slider', min: -1, max: 1, step: 0.1, def: 0.1 },
  ],
  talk: [
    { k: 'padVol', t: 'slider', min: 0, max: 100, step: 5, unit: '%', def: 100 },
    { k: 'callVol', t: 'slider', min: 0, max: 100, step: 5, unit: '%', def: 100 },
    { k: 'hwAlarm', t: 'switch', def: false },
    { k: 'robotCall', t: 'switch', def: true },
    { k: 'sos', t: 'switch', def: true },
    { k: 'sosMode', t: 'radio', opts: ['call', 'intercom'], def: 'intercom' },
    { k: 'home', t: 'radio', opts: ['face', 'warning'], def: 'face' },
    { k: 'sosDur', t: 'num', min: 5, max: 300, unit: 's', def: 30 },
    { k: 'wait', t: 'num', min: 5, max: 300, unit: 's', def: 30 },
    { k: 'greetGap', t: 'num', min: 0, max: 3600, unit: 's', def: 0 },
    { k: 'alarmDur', t: 'num', min: 1, max: 300, unit: 's', def: 15 },
    { k: 'welcome', t: 'text', max: 120, def: '您好，歡迎來到 OViiAI 廠區，請問有什麼可以協助您？' },
    { k: 'whiteWelcome', t: 'text', max: 120, def: '早安，祝您工作順利。' },
    { k: 'blackWarn', t: 'text', max: 120, def: '您已進入管制區域，請立即離開，保全人員即將到場。' },
    { k: 'intrude', t: 'text', max: 120, def: '此區域禁止進入，請返回通道。' },
  ],
  ext: [
    { sec: 'react' },
    { k: 'reWhite', t: 'react', def: ['greet', false] },
    { k: 'reBlack', t: 'react', def: ['alarm', true] },
    { k: 'reIntrude', t: 'react', def: ['notify', true] },
    { sec: 'effect' },
    { k: 'effType', t: 'radio', opts: ['default', 'time', 'state'], def: 'default' },
    { k: 'effTime', t: 'time2', def: ['00:00', '23:59'] },
    { k: 'effStates', t: 'checks', opts: ['idle', 'patrolling', 'navigating', 'charging', 'teleop', 'estop', 'sos', 'alarm'], def: ['patrolling', 'navigating', 'alarm'] },
  ],
};

export const isParamField = (it: ParamItem): it is ParamField => 'k' in it;

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, '時間格式 HH:MM');

function fieldSchema(f: ParamField): z.ZodTypeAny {
  switch (f.t) {
    case 'slider':
    case 'num':
      return z.number().finite().min(f.min).max(f.max);
    case 'switch':
      return z.boolean();
    case 'radio':
      return z.enum(f.opts as [string, ...string[]]);
    case 'checks':
      return z.array(z.enum(f.opts as [string, ...string[]])).max(f.opts.length).refine((a) => new Set(a).size === a.length, '選項重複');
    case 'time2':
      return z.tuple([HHMM, HHMM]);
    case 'text':
      return z.string().max(f.max);
    case 'react':
      return z.tuple([z.enum(REACT_ACTIONS), z.boolean()]);
  }
}

/** 一個子系統的驗證（全部欄位必填、不接受未知欄位） */
export function subsystemSchema(sub: ParamSubsystem) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const it of PARAM_SCHEMA[sub]) if (isParamField(it)) shape[it.k] = fieldSchema(it);
  return z.object(shape).strict();
}

export type SubsystemValues = Record<string, unknown>;
export type RobotParams = Record<ParamSubsystem, SubsystemValues>;

export function paramDefaults(sub: ParamSubsystem): SubsystemValues {
  const out: SubsystemValues = {};
  for (const it of PARAM_SCHEMA[sub]) if (isParamField(it)) out[it.k] = Array.isArray(it.def) ? [...it.def] : it.def;
  return out;
}

/**
 * 資料庫存的值補上預設值：沒存過的欄位用預設、存了但已不合法的欄位（例如之後改了選項）也回到預設，
 * 未知欄位丟掉。保證回傳的每個子系統都通過 subsystemSchema。
 */
export function withDefaults(stored: unknown): RobotParams {
  const src = (stored && typeof stored === 'object' ? stored : {}) as Record<string, unknown>;
  const out = {} as RobotParams;
  for (const sub of PARAM_SUBSYSTEMS) {
    const vals = (src[sub] && typeof src[sub] === 'object' ? src[sub] : {}) as Record<string, unknown>;
    const merged: SubsystemValues = {};
    for (const it of PARAM_SCHEMA[sub]) {
      if (!isParamField(it)) continue;
      const ok = it.k in vals && fieldSchema(it).safeParse(vals[it.k]).success;
      merged[it.k] = ok ? vals[it.k] : Array.isArray(it.def) ? [...it.def] : it.def;
    }
    out[sub] = merged;
  }
  return out;
}
