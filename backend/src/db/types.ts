import type { ColumnType, Generated } from 'kysely';

// 對應 db/migrations。只列後端已用到的表，模組加入時再補。
type Timestamp = ColumnType<Date, Date | string, Date | string>;

export interface RolesTable {
  id: Generated<string>;
  name: string;
  description: string | null;
  perms: ColumnType<string[], string[] | undefined, string[]>;
  is_system: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: ColumnType<Date, never, never>;
}

export interface UsersTable {
  id: Generated<string>;
  username: string;
  display_name: string;
  password_hash: string;
  role_id: string;
  phone: string | null;
  email: string | null;
  enabled: ColumnType<boolean, boolean | undefined, boolean>;
  failed_logins: ColumnType<number, number | undefined, number>;
  locked_until: Timestamp | null;
  last_login_at: Timestamp | null;
  created_at: ColumnType<Date, never, never>;
}

export interface RefreshTokensTable {
  id: Generated<string>;
  user_id: string;
  token_hash: string;
  expires_at: Timestamp;
  revoked_at: Timestamp | null;
}

export interface OpLogsTable {
  id: Generated<string>;
  at: ColumnType<Date, never, never>;
  user_id: string | null;
  username: string;
  action: string;
  target: string | null;
  detail: unknown;
  ip: string | null;
}

export interface SettingsTable {
  key: string;
  value: unknown;
  updated_by: string | null;
  updated_at: ColumnType<Date, never, Date | string>;
}

export interface FloorsTable {
  id: string;
  name: string;
  sort: number;
  plan_key: string | null;
  width_m: string | null;
  height_m: string | null;
  robot_quota: ColumnType<number, number | undefined, number>;
}

export interface RobotsTable {
  id: Generated<string>;
  code: string;
  brand: string;
  model: string;
  serial_no: string | null;
  floor_id: string;
  adapter: string;
  conn: ColumnType<unknown, string | undefined, string>;
  caps: ColumnType<string[], string[] | undefined, string[]>;
  modules: ColumnType<unknown, string | undefined, string>;
  params: ColumnType<unknown, string | undefined, string>;
  enabled: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: ColumnType<Date, never, never>;
}

export interface TelemetryTable {
  at: Timestamp;
  robot_id: string;
  x: number | null;
  y: number | null;
  yaw: number | null;
  battery: number | null;
  charging: boolean | null;
  state: string | null;
  task_id: string | null;
  rssi: number | null;
  speed: number | null;
}

export interface RobotStateLogTable {
  at: Timestamp;
  robot_id: string;
  state: string;
  reason: string | null;
}

export interface CamerasTable {
  id: Generated<string>;
  code: string;
  name: string;
  floor_id: string;
  x: number;
  y: number;
  rtsp_url: Buffer;
  stream_key: string;
  enabled: ColumnType<boolean, boolean | undefined, boolean>;
}

export interface ChargersTable {
  id: Generated<string>;
  code: string;
  floor_id: string;
  x: number;
  y: number;
  brand: string;
  robot_dock: ColumnType<unknown, string | undefined, string>;
  occupied_by: string | null;
  enabled: ColumnType<boolean, boolean | undefined, boolean>;
}

export interface TasksTable {
  id: Generated<string>;
  code: string;
  kind: string;
  priority: string;
  source: string;
  floor_id: string;
  target: ColumnType<Record<string, unknown>, string, string>;
  robot_id: string | null;
  pinned_robot: ColumnType<boolean, boolean | undefined, boolean>;
  status: string;
  created_by: string | null;
  approved_by: string | null;
  approved_at: Timestamp | null;
  reject_reason: string | null;
  preempted_by: string | null;
  progress: ColumnType<Record<string, unknown>, string | undefined, string>;
  note: string | null;
  created_at: ColumnType<Date, never, never>;
  started_at: Timestamp | null;
  ended_at: Timestamp | null;
  fail_reason: string | null;
}

export interface TaskEventsTable {
  id: Generated<string>;
  task_id: string;
  at: ColumnType<Date, never, never>;
  type: string;
  data: ColumnType<unknown, string | null, string | null>;
}

export interface PoisTable {
  id: Generated<string>;
  floor_id: string;
  name: string;
  x: number;
  y: number;
  yaw: number | null;
  kind: ColumnType<'poi' | 'parking', 'poi' | 'parking' | undefined, 'poi' | 'parking'>;
}

export interface PathsTable {
  id: Generated<string>;
  floor_id: string;
  name: string;
  points: ColumnType<{ x: number; y: number; yaw?: number }[], string, string>;
  length_m: string;
}

export interface AlarmRulesTable {
  type: string;
  category: 'system' | 'business';
  name: string;
  level: number;
  popup: boolean;
  sound: boolean;
  need_handle: boolean;
  sms_user_ids: ColumnType<string[], string[] | undefined, string[]>;
  dedup_sec: ColumnType<number, number | undefined, number>;
}

export interface AlarmsTable {
  id: Generated<string>;
  code: string;
  type: string;
  category: string;
  level: number;
  floor_id: string | null;
  robot_id: string | null;
  camera_id: string | null;
  x: number | null;
  y: number | null;
  message: string;
  /** numeric(5,2)：pg 回傳字串 */
  confidence: ColumnType<string | null, number | null | undefined, number | null>;
  status: string;
  handler_id: string | null;
  snapshot_key: string | null;
  clip_key: string | null;
  ext: ColumnType<unknown, string | null | undefined, string | null>;
  repeat_count: ColumnType<number, number | undefined, number>;
  occurred_at: Timestamp;
  closed_at: Timestamp | null;
  source_key: string | null;
  handled_at: Timestamp | null;
}

export interface AlarmEventsTable {
  id: Generated<string>;
  alarm_id: string;
  at: ColumnType<Date, Date | string | undefined, never>;
  user_id: string | null;
  user_name: string | null;
  from_status: string | null;
  to_status: string | null;
  note: string | null;
}

export interface ChargeSessionsTable {
  id: Generated<string>;
  robot_id: string;
  charger_id: string | null;
  mode: string;
  started_at: ColumnType<Date, Date | string | undefined, Date | string>;
  ended_at: Timestamp | null;
  start_pct: number | null;
  end_pct: number | null;
}

export interface TaskTemplatesTable {
  id: Generated<string>;
  name: string;
  kind: string;
  priority: string;
  floor_id: string | null;
  target: ColumnType<unknown, string | null, string | null>;
}

export interface DB {
  task_templates: TaskTemplatesTable;
  charge_sessions: ChargeSessionsTable;
  cameras: CamerasTable;
  chargers: ChargersTable;
  tasks: TasksTable;
  task_events: TaskEventsTable;
  pois: PoisTable;
  paths: PathsTable;
  alarms: AlarmsTable;
  alarm_rules: AlarmRulesTable;
  alarm_events: AlarmEventsTable;
  floors: FloorsTable;
  robots: RobotsTable;
  telemetry: TelemetryTable;
  robot_state_log: RobotStateLogTable;
  roles: RolesTable;
  users: UsersTable;
  refresh_tokens: RefreshTokensTable;
  op_logs: OpLogsTable;
  settings: SettingsTable;
}
