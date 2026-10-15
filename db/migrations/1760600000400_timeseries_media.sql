-- Up Migration
-- 工程開發手冊「資料庫」§5 時序與媒體；保存天數見 §7
CREATE TABLE telemetry (
  at        timestamptz NOT NULL,
  robot_id  uuid NOT NULL,
  x double precision, y double precision, yaw double precision,
  battery   real,
  charging  boolean,
  state     text,
  task_id   uuid,
  rssi      smallint,
  speed     real
);
SELECT create_hypertable('telemetry', 'at', chunk_time_interval => interval '1 day');
CREATE INDEX ON telemetry (robot_id, at DESC);
ALTER TABLE telemetry SET (timescaledb.compress, timescaledb.compress_segmentby = 'robot_id');
SELECT add_compression_policy('telemetry', interval '7 days');
SELECT add_retention_policy('telemetry', interval '90 days');

CREATE TABLE robot_state_log (                -- 狀態變化（運行日誌、可用率）
  at       timestamptz NOT NULL,
  robot_id uuid NOT NULL,
  state    text NOT NULL,
  reason   text
);
SELECT create_hypertable('robot_state_log', 'at');
SELECT add_retention_policy('robot_state_log', interval '1 year');

CREATE TABLE env_readings (                   -- 第二期
  at timestamptz NOT NULL, robot_id uuid NOT NULL, floor_id text,
  x double precision, y double precision,
  kind text NOT NULL,                         -- temp, humidity, co, smoke ...
  value real NOT NULL, unit text NOT NULL
);
SELECT create_hypertable('env_readings', 'at');
SELECT add_retention_policy('env_readings', interval '1 year');

CREATE TABLE media (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       text NOT NULL CHECK (kind IN ('snapshot','clip','audio','image')),
  robot_id   uuid REFERENCES robots(id),
  camera_id  uuid REFERENCES cameras(id),
  alarm_id   uuid REFERENCES alarms(id),
  task_id    uuid REFERENCES tasks(id),
  object_key text NOT NULL,
  size_bytes bigint,
  duration_s int,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON media (created_at DESC);

-- Down Migration
DROP TABLE media;
DROP TABLE env_readings;
DROP TABLE robot_state_log;
DROP TABLE telemetry;
