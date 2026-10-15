-- Up Migration
-- 工程開發手冊「資料庫」§2 場域與設備
CREATE TABLE floors (
  id          text PRIMARY KEY,               -- '1f' | '2f' | 'b1'
  name        text NOT NULL,                  -- '1F 辦公室'
  sort        int NOT NULL,
  plan_key    text,                           -- 物件儲存中的平面圖
  width_m     numeric(8,2),                   -- 平面圖實際寬度
  height_m    numeric(8,2),
  robot_quota int NOT NULL DEFAULT 0          -- 該樓層配置台數
);

CREATE TABLE robots (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code         text NOT NULL UNIQUE,          -- ANBOT-001
  brand        text NOT NULL CHECK (brand IN ('anbot','unitree','deep')),
  model        text NOT NULL,                 -- ANBOT-Y, B2, X30 ...
  serial_no    text,
  floor_id     text NOT NULL REFERENCES floors(id),
  adapter      text NOT NULL,                 -- 對應哪個轉接器實例
  conn         jsonb NOT NULL DEFAULT '{}',   -- IP、埠號等，敏感欄位加密
  caps         text[] NOT NULL DEFAULT '{}',  -- ptz, light, talk, follow, lift, env
  modules      jsonb NOT NULL DEFAULT '{}',
  params       jsonb NOT NULL DEFAULT '{}',   -- 四個子系統參數
  enabled      boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE robot_map_calib (
  robot_id     uuid PRIMARY KEY REFERENCES robots(id) ON DELETE CASCADE,
  robot_map_id text NOT NULL,                 -- 機器人端地圖名稱
  matrix       double precision[6] NOT NULL,  -- 仿射 [a,b,tx,c,d,ty]，機器人→平台
  points       jsonb NOT NULL,                -- 校正用的對應點
  rmse_m       numeric(6,3) NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE chargers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,           -- CHG-1F-1
  floor_id    text NOT NULL REFERENCES floors(id),
  x           double precision NOT NULL,
  y           double precision NOT NULL,
  brand       text NOT NULL,                  -- 只供該品牌使用
  robot_dock  jsonb NOT NULL DEFAULT '{}',    -- 機器人端的充電樁 ID
  occupied_by uuid REFERENCES robots(id),
  enabled     boolean NOT NULL DEFAULT true
);

CREATE TABLE cameras (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code       text NOT NULL UNIQUE,            -- CAM-1F-07
  name       text NOT NULL,
  floor_id   text NOT NULL REFERENCES floors(id),
  x          double precision NOT NULL,
  y          double precision NOT NULL,
  rtsp_url   bytea NOT NULL,                  -- pgp_sym_encrypt
  stream_key text NOT NULL UNIQUE,            -- MediaMTX 路徑名
  enabled    boolean NOT NULL DEFAULT true
);

-- Down Migration
DROP TABLE cameras;
DROP TABLE chargers;
DROP TABLE robot_map_calib;
DROP TABLE robots;
DROP TABLE floors;
