import type { RobotState } from '@oviiai/contracts';

/** 一台機器人的即時狀態：存在 Redis `robot:{code}`，也是 WebSocket `robot.state` 的內容 */
export interface LiveState {
  robotId: string;
  code: string;
  floor: string;
  online: boolean;
  /** 最後收到遙測的伺服器時間（ms） */
  lastSeen: number;
  /** 機器人回報的量測時間（ms） */
  ts: number;
  x: number;
  y: number;
  yaw: number;
  battery: number;
  charging: boolean;
  state: RobotState;
  speed: number | null;
  taskId: string | null;
  rssi: number | null;
  faults: { code: string; level: 1 | 2 | 3; msg: string }[];
}

export interface RobotInfo {
  id: string;
  code: string;
  floor: string;
  adapter: string;
  /** 能力清單（ptz、light、talk、follow、lift、env），後端與前端依此判斷，不做品牌判斷 */
  caps: string[];
}

export type OfflineReason = 'telemetry_timeout' | 'adapter_reported' | 'adapter_down';

/** fleet 對外事件；告警管線（T-21）訂閱 offline 發系統告警，派工（T-16）據此暫停任務 */
export type FleetEvent =
  | { type: 'offline'; robot: RobotInfo; reason: OfflineReason; at: number }
  | { type: 'online'; robot: RobotInfo; at: number }
  | { type: 'state'; robot: RobotInfo; from: RobotState | null; to: RobotState; at: number };
