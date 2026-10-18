-- Up Migration
-- T-40 數據統計：每台每天的里程與各狀態時長（台北日期）。過去的日子算一次存起來（每日排程＋查詢時補算），
-- 不必每次從原始遙測（每台每秒一筆）重算。今天的即時計算、不存。
CREATE INDEX IF NOT EXISTS robot_state_log_robot_at ON robot_state_log (robot_id, at DESC);
CREATE TABLE robot_daily_stats (
  day          date NOT NULL,
  robot_id     uuid NOT NULL REFERENCES robots(id) ON DELETE CASCADE,
  distance_m   real NOT NULL DEFAULT 0,
  busy_s       integer NOT NULL DEFAULT 0,   -- navigating、patrolling、returning、teleop
  charging_s   integer NOT NULL DEFAULT 0,
  idle_s       integer NOT NULL DEFAULT 0,   -- idle、paused
  fault_s      integer NOT NULL DEFAULT 0,   -- fault、estop
  offline_s    integer NOT NULL DEFAULT 0,
  computed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day, robot_id)
);

-- T-42 音視頻管理：喊話音檔、警示圖、詞條（文字轉語音）。推送到機器人播放或顯示。
CREATE TABLE broadcast_assets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL CHECK (kind IN ('audio', 'image', 'text')),
  name        text NOT NULL,
  note        text,
  object_key  text,                           -- audio、image：物件儲存位置
  mime        text,
  size_bytes  integer,
  duration_ms integer,
  text        text,                           -- text：喊話內容
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'text') = (text IS NOT NULL)),
  CHECK ((kind = 'text') = (object_key IS NULL))
);

-- T-42 日誌管理：向機器人要日誌，轉接器上傳到物件儲存（預簽名 PUT）後列出供下載
CREATE TABLE robot_logs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  robot_id     uuid NOT NULL REFERENCES robots(id) ON DELETE CASCADE,
  subsystem    text NOT NULL CHECK (subsystem IN ('motion', 'video', 'interaction', 'system')),
  object_key   text NOT NULL,
  status       text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'uploaded', 'failed')),
  size_bytes   bigint,
  error        text,
  cmd_id       text,
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  uploaded_at  timestamptz
);
CREATE INDEX ON robot_logs (robot_id, created_at DESC);

-- Down Migration
DROP TABLE robot_logs;
DROP TABLE broadcast_assets;
DROP TABLE robot_daily_stats;
DROP INDEX IF EXISTS robot_state_log_robot_at;
