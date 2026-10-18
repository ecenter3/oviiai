-- Up Migration
-- 第二期 T-41：環境監測、定點檢測

-- 環境數值項目與閾值：只有列在這裡的 sensors 鍵才寫入 env_readings（odom_total_m 等不是環境數值）。
-- 超出 min／max 發 alarm_type 的業務告警；alarm_type 為空只標示超標、不發告警
CREATE TABLE env_thresholds (
  kind       text PRIMARY KEY,
  name       text NOT NULL,
  unit       text NOT NULL,
  min        real,
  max        real,
  alarm_type text REFERENCES alarm_rules(type) ON DELETE SET NULL,
  sort       int NOT NULL DEFAULT 0,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (min IS NULL OR max IS NULL OR min < max)
);
-- 預設值：溫濕度沿用原型（35 °C、75 %）；氣體依常見的職業暴露與爆炸下限警戒值
INSERT INTO env_thresholds (kind, name, unit, min, max, alarm_type, sort) VALUES
 ('temp',     '溫度',       '°C',     NULL, 35,   'temp_humidity', 1),
 ('humidity', '濕度',       '%',      NULL, 75,   'temp_humidity', 2),
 ('co',       '一氧化碳',   'ppm',    NULL, 35,   'gas',           3),
 ('co2',      '二氧化碳',   'ppm',    NULL, 1500, 'gas',           4),
 ('ch4',      '可燃氣體',   '%LEL',   NULL, 10,   'gas',           5),
 ('h2s',      '硫化氫',     'ppm',    NULL, 10,   'gas',           6),
 ('o2',       '氧氣',       '%',      19.5, 23.5, 'gas',           7),
 ('smoke',    '煙霧濃度',   '%obs/m', NULL, 3,    'smoke',         8),
 ('pm25',     'PM2.5',      'µg/m³',  NULL, 75,   NULL,            9),
 ('noise',    '噪音',       'dB',     NULL, 85,   NULL,            10);

-- 定點檢測點：從興趣點挑選；機器人進入半徑內時記一筆（每次經過，或距上次超過 1／4 小時）
CREATE TABLE inspection_points (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  poi_id     uuid NOT NULL UNIQUE REFERENCES pois(id) ON DELETE CASCADE,
  freq       text NOT NULL DEFAULT 'pass' CHECK (freq IN ('pass','1h','4h')),
  radius_m   real NOT NULL DEFAULT 2 CHECK (radius_m > 0 AND radius_m <= 10),
  enabled    boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 定點檢測的量測也寫在 env_readings，標上檢測點（檢測點刪除後紀錄保留到保存期限）
ALTER TABLE env_readings ADD COLUMN point_id uuid;
CREATE INDEX env_readings_floor_kind_at ON env_readings (floor_id, kind, at DESC);
CREATE INDEX env_readings_robot_at ON env_readings (robot_id, at DESC);
CREATE INDEX env_readings_point_at ON env_readings (point_id, at DESC) WHERE point_id IS NOT NULL;

-- Down Migration
DROP INDEX env_readings_point_at;
DROP INDEX env_readings_robot_at;
DROP INDEX env_readings_floor_kind_at;
ALTER TABLE env_readings DROP COLUMN point_id;
DROP TABLE inspection_points;
DROP TABLE env_thresholds;
