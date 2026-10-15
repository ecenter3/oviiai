/**
 * 轉接器 <-> 後端 MQTT 訊息格式。
 * 必須與 adapters/common/contracts.py 保持一致。座標一律是平台座標（公尺、弧度）。
 */
import { z } from 'zod';

export const RobotState = z.enum([
  'idle', 'navigating', 'patrolling', 'teleop', 'returning',
  'charging', 'paused', 'estop', 'fault', 'offline',
]);
export type RobotState = z.infer<typeof RobotState>;

export const Telemetry = z.object({
  ts: z.number().int(),
  pose: z.object({ x: z.number(), y: z.number(), yaw: z.number(), floor: z.string() }),
  battery: z.object({ pct: z.number().min(0).max(100), charging: z.boolean(), voltage: z.number().optional() }),
  state: RobotState,
  speed: z.number().optional(),
  taskRef: z.string().nullable().optional(),
  faults: z.array(z.object({ code: z.string(), level: z.union([z.literal(1), z.literal(2), z.literal(3)]), msg: z.string() })).default([]),
  net: z.object({ rssi: z.number().optional(), latencyMs: z.number().optional() }).optional(),
  sensors: z.record(z.object({ value: z.number(), unit: z.string() })).optional(),
});
export type Telemetry = z.infer<typeof Telemetry>;

export const RobotEvent = z.object({
  ts: z.number().int(),
  type: z.enum([
    'fault', 'fault_cleared', 'waypoint_reached', 'goal_reached', 'goal_failed',
    'charge_started', 'charge_finished', 'estop_pressed', 'sos', 'obstacle_blocked',
  ]),
  data: z.record(z.unknown()).optional(),
});
export type RobotEvent = z.infer<typeof RobotEvent>;

export const CommandType = z.enum([
  'navigate', 'patrol', 'stop', 'pause', 'resume', 'estop', 'estop_release', 'charge',
  'ptz', 'light', 'snapshot', 'record_start', 'record_stop', 'speak', 'follow',
  'follow_stop', 'set_params', 'lift',
]);
export type CommandType = z.infer<typeof CommandType>;

export const Command = z.object({
  cmdId: z.string(),
  ts: z.number().int(),
  type: CommandType,
  args: z.record(z.unknown()).default({}),
  timeoutSec: z.number().optional(),
});
export type Command = z.infer<typeof Command>;

export const Ack = z.object({
  cmdId: z.string(),
  ts: z.number().int(),
  status: z.enum(['accepted', 'rejected', 'done', 'failed']),
  error: z.object({ code: z.string(), msg: z.string() }).optional(),
  result: z.record(z.unknown()).optional(),
});
export type Ack = z.infer<typeof Ack>;

export const Teleop = z.object({
  lockId: z.string(), vx: z.number(), vy: z.number(), wz: z.number(), ts: z.number().int(),
});
export type Teleop = z.infer<typeof Teleop>;

export const AdapterStatus = z.object({
  ts: z.number().int(),
  name: z.string(),
  alive: z.boolean(),
  version: z.string().optional(),
  robots: z.array(z.string()).optional(),
  connected: z.array(z.string()).optional(),
});
export type AdapterStatus = z.infer<typeof AdapterStatus>;

export const topics = {
  telemetry: (code: string) => `rms/robot/${code}/telemetry`,
  event: (code: string) => `rms/robot/${code}/event`,
  cmd: (code: string) => `rms/robot/${code}/cmd`,
  ack: (code: string) => `rms/robot/${code}/ack`,
  teleop: (code: string) => `rms/robot/${code}/teleop`,
  online: (code: string) => `rms/robot/${code}/online`,
  adapterStatus: (name: string) => `rms/adapter/${name}/status`,
} as const;
