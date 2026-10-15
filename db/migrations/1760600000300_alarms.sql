-- Up Migration
-- 工程開發手冊「資料庫」§4 告警
CREATE TABLE alarm_rules (                    -- 告警設置
  type          text PRIMARY KEY,             -- battery_low, offline, intrusion, blacklist ...
  category      text NOT NULL CHECK (category IN ('system','business')),
  name          text NOT NULL,
  level         int NOT NULL CHECK (level IN (1,2,3)),
  popup         boolean NOT NULL,
  sound         boolean NOT NULL,
  need_handle   boolean NOT NULL,
  sms_user_ids  uuid[] NOT NULL DEFAULT '{}',
  dedup_sec     int NOT NULL DEFAULT 60       -- 同來源同類型合併窗口
);

CREATE TABLE alarms (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code         text NOT NULL UNIQUE,          -- A-20261011-0007
  type         text NOT NULL REFERENCES alarm_rules(type),
  category     text NOT NULL,
  level        int NOT NULL,
  floor_id     text REFERENCES floors(id),
  robot_id     uuid REFERENCES robots(id),
  camera_id    uuid REFERENCES cameras(id),
  x double precision, y double precision,
  message      text NOT NULL,
  confidence   numeric(5,2),                  -- AI 信心度 0–100
  status       text NOT NULL CHECK (status IN
                 ('review','open','handling','reported','closed','false_alarm','info')),
  handler_id   uuid REFERENCES users(id),
  snapshot_key text,
  clip_key     text,
  ext          jsonb,                         -- 人臉事件原始資料等
  repeat_count int NOT NULL DEFAULT 1,
  occurred_at  timestamptz NOT NULL,
  closed_at    timestamptz
);
CREATE INDEX ON alarms (status, level);
CREATE INDEX ON alarms (occurred_at DESC);
CREATE INDEX ON alarms (robot_id, occurred_at DESC);

CREATE TABLE alarm_events (                   -- 處理歷程
  id       bigserial PRIMARY KEY,
  alarm_id uuid NOT NULL REFERENCES alarms(id) ON DELETE CASCADE,
  at       timestamptz NOT NULL DEFAULT now(),
  user_id  uuid REFERENCES users(id),
  from_status text, to_status text,
  note     text
);

-- Down Migration
DROP TABLE alarm_events;
DROP TABLE alarms;
DROP TABLE alarm_rules;
