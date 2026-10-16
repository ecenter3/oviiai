-- Up Migration
-- 充電排程（後端邏輯 §3、T-19）：每次充電紀錄開始、結束電量，供第二期能耗頁使用
CREATE TABLE charge_sessions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  robot_id   uuid NOT NULL REFERENCES robots(id) ON DELETE CASCADE,
  charger_id uuid REFERENCES chargers(id) ON DELETE SET NULL,
  mode       text NOT NULL CHECK (mode IN ('auto','manual')),
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at   timestamptz,
  start_pct  real,
  end_pct    real
);
CREATE INDEX ON charge_sessions (robot_id, started_at DESC);

-- 人工充電模式（後端邏輯 §3）：charge.mode.{brand} = auto | manual。
-- 依目前 SDK 實況（docs/spec/README.md）：宇樹 B2 沒有充電介面、雲深處 X30 充電指令待原廠提供 → manual；
-- 萬為 ANBOT-Y 輪式機器人自動對接 → auto。確認後在「派工與充電規則」頁改。
INSERT INTO settings (key, value) VALUES
 ('charge.mode.unitree', '"manual"'),
 ('charge.mode.deep',    '"manual"'),
 ('charge.mode.anbot',   '"auto"')
ON CONFLICT (key) DO NOTHING;

-- Down Migration
DELETE FROM settings WHERE key IN ('charge.mode.unitree','charge.mode.deep','charge.mode.anbot');
DROP TABLE charge_sessions;
