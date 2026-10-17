import { z } from 'zod';

/**
 * 「派工與充電規則」頁可改的設定（settings 表）。預設值與 migration 相同，「還原預設值」用。
 * charge.mode.{brand} 另外處理：品牌來自 robots 表的資料值。
 */
const pct = (min: number, max: number) => z.number().int().min(min).max(max);

export const RULES = {
  'charge.returnAt': { schema: pct(5, 60), default: 25 },
  'charge.minAccept': { schema: pct(10, 90), default: 40 },
  'charge.resumeAt': { schema: pct(50, 100), default: 90 },
  'dispatch.p1Preempt': { schema: z.boolean(), default: true },
  'dispatch.approval': { schema: z.boolean(), default: true },
  'dispatch.approvalUntil': { schema: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(), default: '2027-01-31' as string | null },
  'alarm.aiConfidence': { schema: pct(30, 95), default: 70 },
  'robot.offlineSec': { schema: z.number().int().min(3).max(120), default: 10 },
  'cmd.timeoutSec': { schema: z.number().int().min(5).max(120), default: 15 },
  /** 遙控鎖閒置多久（只收到零速度）自動回收，秒（PR #13 審查第 1 點） */
  'teleop.idleSec': { schema: z.number().int().min(60).max(1800), default: 300 },
  /** 閒置多少分鐘自動登出（安全收尾 d）；0＝不登出（例：控制室大螢幕）。登入政策，不隨場域設定包匯出入 */
  'auth.idleMinutes': {
    schema: z
      .number()
      .int()
      .refine((n) => n === 0 || (n >= 5 && n <= 480), '0（不自動登出）或 5～480 分鐘'),
    default: 30,
  },
} as const;

export type RuleKey = keyof typeof RULES;
export const RULE_KEYS = Object.keys(RULES) as RuleKey[];
export const CHARGE_MODE = /^charge\.mode\.([a-z0-9_-]{1,32})$/;
export const ChargeModeValue = z.enum(['auto', 'manual']);

/** 跨欄位檢查：回充門檻 < 接單最低電量 < 充電完成 */
export function checkOrder(v: { returnAt: number; minAccept: number; resumeAt: number }): string | null {
  if (!(v.returnAt < v.minAccept)) return '回充門檻必須低於接單最低電量';
  if (!(v.minAccept < v.resumeAt)) return '接單最低電量必須低於充電完成';
  return null;
}
