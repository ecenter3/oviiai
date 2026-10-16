-- Up Migration
-- 告警管線（後端邏輯 §5、T-21）

-- 去重鍵：同 type＋同來源（機器人、攝影機、任務…）在 dedup_sec 內合併；處理時間供告警頁「處理時間」欄
ALTER TABLE alarms ADD COLUMN source_key text;
ALTER TABLE alarms ADD COLUMN handled_at timestamptz;
CREATE INDEX ON alarms (type, source_key, occurred_at DESC);
CREATE INDEX ON alarms (category, occurred_at DESC);

-- 刪除機器人、帳號、樓層時保留告警與處理歷程（只斷開關聯），告警需保存 1 年
ALTER TABLE alarms DROP CONSTRAINT alarms_robot_id_fkey,
  ADD CONSTRAINT alarms_robot_id_fkey FOREIGN KEY (robot_id) REFERENCES robots(id) ON DELETE SET NULL;
ALTER TABLE alarms DROP CONSTRAINT alarms_handler_id_fkey,
  ADD CONSTRAINT alarms_handler_id_fkey FOREIGN KEY (handler_id) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE alarms DROP CONSTRAINT alarms_floor_id_fkey,
  ADD CONSTRAINT alarms_floor_id_fkey FOREIGN KEY (floor_id) REFERENCES floors(id) ON DELETE SET NULL;
ALTER TABLE alarm_events DROP CONSTRAINT alarm_events_user_id_fkey,
  ADD CONSTRAINT alarm_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
-- 處理歷程記操作者名稱：帳號刪除後仍看得出是誰處理的；系統自動的事件記「系統」
ALTER TABLE alarm_events ADD COLUMN user_name text;

-- 告警項目與預設通知（系統規格書 §6：一級 彈窗＋響鈴＋需處理；二級 提示音＋需處理；三級 只列表）
INSERT INTO alarm_rules (type, category, name, level, popup, sound, need_handle, dedup_sec) VALUES
 -- 系統告警（後端邏輯 §5 系統告警規則）
 ('battery_low',   'system',   '低電量',               2, false, true,  true,  60),
 ('offline',       'system',   '機器人離線',           2, false, true,  true,  60),
 ('estop',         'system',   '急停',                 2, false, true,  true,  60),
 ('fault',         'system',   '機器人故障',           2, false, true,  true,  60),
 ('weak_signal',   'system',   '訊號偏弱',             3, false, false, false, 60),
 ('stream_down',   'system',   '影像中斷',             2, false, true,  true,  60),
 ('cmd_failed',    'system',   '指令失敗',             3, false, false, false, 60),
 ('p1_preempt',    'system',   'P1 插隊',              3, false, false, false, 60),
 ('p1_no_robot',   'system',   'P1 無可用機器人',      1, true,  true,  true,  60),
 ('charge_queue',  'system',   '低電量排隊過久',       2, false, true,  true,  60),
 ('manual_charge', 'system',   '需人工充電或換電池',   2, false, true,  true,  60),
 ('charge_failed', 'system',   '回充失敗',             2, false, true,  true,  60),
 -- 業務告警（系統規格書 §6；來源為人臉系統 T-34、環境檢測 T-36 等）
 ('intrusion',     'business', '人員入侵',             1, true,  true,  true,  60),
 ('blacklist',     'business', '黑名單人員',           1, true,  true,  true,  60),
 ('unregistered',  'business', '未註冊人員',           3, false, false, false, 60),
 ('fire',          'business', '火焰',                 1, true,  true,  true,  60),
 ('smoke',         'business', '煙霧',                 1, true,  true,  true,  60),
 ('heat',          'business', '熱源異常',             2, false, true,  true,  60),
 ('gas',           'business', '氣體濃度異常',         2, false, true,  true,  60),
 ('temp_humidity', 'business', '溫度或濕度異常',       2, false, true,  true,  60)
ON CONFLICT (type) DO NOTHING;

-- 待命點（PR #8 審查第 2 點）：充電讓位時開往同樓層最近的 parking；T-23 導航管理頁可設定
ALTER TABLE pois ADD COLUMN kind text NOT NULL DEFAULT 'poi' CHECK (kind IN ('poi','parking'));

-- Down Migration
ALTER TABLE pois DROP COLUMN kind;
DELETE FROM alarm_events;
DELETE FROM alarms;
DELETE FROM alarm_rules;
ALTER TABLE alarm_events DROP COLUMN user_name;
ALTER TABLE alarm_events DROP CONSTRAINT alarm_events_user_id_fkey,
  ADD CONSTRAINT alarm_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);
ALTER TABLE alarms DROP CONSTRAINT alarms_floor_id_fkey,
  ADD CONSTRAINT alarms_floor_id_fkey FOREIGN KEY (floor_id) REFERENCES floors(id);
ALTER TABLE alarms DROP CONSTRAINT alarms_handler_id_fkey,
  ADD CONSTRAINT alarms_handler_id_fkey FOREIGN KEY (handler_id) REFERENCES users(id);
ALTER TABLE alarms DROP CONSTRAINT alarms_robot_id_fkey,
  ADD CONSTRAINT alarms_robot_id_fkey FOREIGN KEY (robot_id) REFERENCES robots(id);
ALTER TABLE alarms DROP COLUMN handled_at;
ALTER TABLE alarms DROP COLUMN source_key;
