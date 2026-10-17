/**
 * 轉接器 <-> 後端 MQTT 訊息格式。
 * 必須與 adapters/common/contracts.py 保持一致。座標一律是平台座標（公尺、弧度）。
 * 兩邊都以 fixtures/messages.json 測試（T-07），改格式時先改 fixtures。
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

export const EventType = z.enum([
  'fault', 'fault_cleared', 'waypoint_reached', 'goal_reached', 'goal_failed',
  'charge_started', 'charge_finished', 'estop_pressed', 'sos', 'obstacle_blocked',
]);
export type EventType = z.infer<typeof EventType>;

export const RobotEvent = z.object({
  ts: z.number().int(),
  type: EventType,
  data: z.record(z.unknown()).optional(),
});
export type RobotEvent = z.infer<typeof RobotEvent>;

export const CommandType = z.enum([
  'navigate', 'patrol', 'stop', 'pause', 'resume', 'estop', 'estop_release', 'charge',
  'ptz', 'light', 'snapshot', 'record_start', 'record_stop', 'speak', 'follow',
  'follow_stop', 'set_params', 'lift',
  // 雙向對講方案 A（T-31）：轉接器從 MediaMTX 拉 talk/{robotCode} 的音訊送到機器人喇叭
  'talk_start', 'talk_stop',
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

export const AckStatus = z.enum(['accepted', 'rejected', 'done', 'failed']);
export type AckStatus = z.infer<typeof AckStatus>;

export const Ack = z.object({
  cmdId: z.string(),
  ts: z.number().int(),
  status: AckStatus,
  error: z.object({ code: z.string(), msg: z.string() }).optional(),
  result: z.record(z.unknown()).optional(),
});
export type Ack = z.infer<typeof Ack>;

export const Teleop = z.object({
  lockId: z.string(), vx: z.number(), vy: z.number(), wz: z.number(), ts: z.number().int(),
});
export type Teleop = z.infer<typeof Teleop>;

/** `rms/robot/{code}/online`（retain）。轉接器偵測到單台斷線或重連時發送 */
export const RobotOnline = z.object({
  online: z.boolean(),
  ts: z.number().int(),
});
export type RobotOnline = z.infer<typeof RobotOnline>;

/**
 * `rms/adapter/{name}/status`（retain），每 5 秒心跳。
 * 轉接器的 Last Will 也發在這裡：`{name, alive: false}`，沒有 ts（遺囑在連線時就固定）。
 * alive=false 時後端把該轉接器的機器人全部視為離線。
 */
export const AdapterStatus = z.object({
  ts: z.number().int().optional(),
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
export * from './perms';
export * from './params';
