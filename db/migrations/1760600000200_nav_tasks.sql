-- Up Migration
-- 工程開發手冊「資料庫」§3 導航與任務
CREATE TABLE pois (                           -- 興趣點
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  floor_id text NOT NULL REFERENCES floors(id),
  name     text NOT NULL,
  x double precision NOT NULL, y double precision NOT NULL, yaw double precision
);

CREATE TABLE zones (                          -- 特殊區域
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  floor_id text NOT NULL REFERENCES floors(id),
  name     text NOT NULL,
  kind     text NOT NULL CHECK (kind IN ('forbidden','slow','silent')),
  polygon  jsonb NOT NULL                     -- [[x,y],...]
);

CREATE TABLE paths (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  floor_id text NOT NULL REFERENCES floors(id),
  name     text NOT NULL,
  points   jsonb NOT NULL,                    -- [{x,y,yaw?,dwellSec?,action?}]
  length_m numeric(8,1) NOT NULL
);

CREATE TABLE patrol_schedules (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name      text NOT NULL,
  path_id   uuid NOT NULL REFERENCES paths(id),
  robot_id  uuid REFERENCES robots(id),       -- null = 由派工選車
  start_time time NOT NULL,
  repeat    text NOT NULL CHECK (repeat IN ('daily','weekdays','weekends','once')),
  once_date date,
  loops     int NOT NULL DEFAULT 1,
  priority  text NOT NULL DEFAULT 'P3',
  enabled   boolean NOT NULL DEFAULT true
);

CREATE TABLE task_templates (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name     text NOT NULL,
  kind     text NOT NULL,                     -- inspect, env, security, equipment, gas ...
  priority text NOT NULL,
  floor_id text REFERENCES floors(id),
  target   jsonb                              -- {poiId} | {pathId}
);

CREATE TABLE tasks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL UNIQUE,         -- T-20261011-0042
  kind          text NOT NULL,
  priority      text NOT NULL CHECK (priority IN ('P1','P2','P3','P4')),
  source        text NOT NULL CHECK (source IN ('manual','schedule','alarm','api')),
  floor_id      text NOT NULL REFERENCES floors(id),
  target        jsonb NOT NULL,               -- {poiId|pathId|x,y}
  robot_id      uuid REFERENCES robots(id),
  pinned_robot  boolean NOT NULL DEFAULT false,
  status        text NOT NULL CHECK (status IN
                  ('pending_approval','queued','assigned','running','paused',
                   'done','cancelled','failed','rejected')),
  created_by    uuid REFERENCES users(id),
  approved_by   uuid REFERENCES users(id),
  approved_at   timestamptz,
  reject_reason text,
  preempted_by  uuid REFERENCES tasks(id),    -- 被哪個 P1 中斷
  progress      jsonb NOT NULL DEFAULT '{}',  -- {wpIndex, loop}
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  ended_at      timestamptz,
  fail_reason   text
);
CREATE INDEX ON tasks (status, floor_id);
CREATE INDEX ON tasks (robot_id, created_at DESC);
CREATE INDEX ON tasks (created_at DESC);

CREATE TABLE task_events (                    -- 任務歷程
  id      bigserial PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  at      timestamptz NOT NULL DEFAULT now(),
  type    text NOT NULL,                      -- created, approved, assigned, started, wp_reached, paused, resumed, done, failed
  data    jsonb
);
CREATE INDEX ON task_events (task_id, at);

-- Down Migration
DROP TABLE task_events;
DROP TABLE tasks;
DROP TABLE task_templates;
DROP TABLE patrol_schedules;
DROP TABLE paths;
DROP TABLE zones;
DROP TABLE pois;
