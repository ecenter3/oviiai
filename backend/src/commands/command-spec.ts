import type { CommandType, PermCode } from '@oviiai/contracts';
import { z } from 'zod';

const unit = z.number().min(-1).max(1);
const camera = z.enum(['front', 'rear']).optional();
const none = z.object({}).strict();

/**
 * 介面規格 §3：使用者可下達的指令、參數與所需權限。
 * patrol、set_params 由派工與參數模組內部送出，不開放給這個 API。
 */
export const USER_COMMANDS = {
  navigate: {
    perm: 'op.dispatch',
    args: z.object({ x: z.number().finite(), y: z.number().finite(), yaw: z.number().finite().optional() }).strict(),
  },
  stop: { perm: 'op.remote', args: none },
  estop: { perm: 'op.estop', args: none },
  estop_release: { perm: 'op.estop', args: none },
  charge: { perm: 'op.remote', args: z.object({ chargerId: z.string().uuid().optional() }).strict() },
  pause: { perm: 'op.remote', args: none },
  resume: { perm: 'op.remote', args: none },
  ptz: { perm: 'op.remote', args: z.object({ pan: unit, tilt: unit, zoom: unit }).strict(), cap: 'ptz' },
  light: { perm: 'op.remote', args: z.object({ on: z.boolean(), mode: z.string().max(32).optional() }).strict(), cap: 'light' },
  snapshot: { perm: 'op.remote', args: z.object({ camera }).strict() },
  record_start: { perm: 'op.remote', args: z.object({ camera }).strict() },
  record_stop: { perm: 'op.remote', args: z.object({ camera }).strict() },
  speak: {
    perm: 'op.remote',
    args: z
      .object({ text: z.string().min(1).max(500).optional(), mediaId: z.string().uuid().optional() })
      .strict()
      .refine((a) => !!a.text !== !!a.mediaId, '需提供 text 或 mediaId 其中之一'),
    cap: 'talk',
  },
  follow: { perm: 'op.remote', args: z.object({ personId: z.string().min(1).max(64) }).strict(), cap: 'follow' },
  follow_stop: { perm: 'op.remote', args: none, cap: 'follow' },
  lift: { perm: 'op.remote', args: z.object({ height: z.number().finite() }).strict(), cap: 'lift' },
} satisfies Partial<Record<CommandType, { perm: PermCode; args: z.ZodTypeAny; cap?: string }>>;

export type UserCommandType = keyof typeof USER_COMMANDS;
export const USER_COMMAND_TYPES = Object.keys(USER_COMMANDS) as [UserCommandType, ...UserCommandType[]];

/** 「停止」類：不受遙控鎖、離線、急停狀態限制（技術設計：任何檢查失敗都不能擋住停止類指令） */
export const ALWAYS_ALLOWED: ReadonlySet<string> = new Set(['estop', 'stop']);

/** 會讓機器人移動、改變任務或機身姿態的指令：別人持有遙控鎖時擋下；急停中擋下（lift：PR #4 審查第 3 點） */
export const MOTION: ReadonlySet<string> = new Set(['navigate', 'charge', 'pause', 'resume', 'follow', 'lift']);

export const COMMAND_PERMS = [...new Set(Object.values(USER_COMMANDS).map((c) => c.perm))] as [PermCode, ...PermCode[]];
