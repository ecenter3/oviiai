-- Up Migration
-- 抓拍與錄影（T-28）、影像串流（T-29）

-- 觸發方式：manual 手動、patrol 巡邏、alarm 告警（原型：手動拍照／巡邏抓拍／告警抓拍）
ALTER TABLE media ADD COLUMN source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','patrol','alarm'));
-- 來自哪一路影像（MediaMTX 路徑：cam/{代碼}、robot/{代碼}/front）
ALTER TABLE media ADD COLUMN stream_key text;
ALTER TABLE media ADD COLUMN floor_id text REFERENCES floors(id) ON DELETE SET NULL;
-- 錄影開始＝created_at、結束＝ended_at
ALTER TABLE media ADD COLUMN ended_at timestamptz;
ALTER TABLE media ADD COLUMN content_type text;

-- 刪除機器人、攝影機、帳號、告警、任務時保留媒體紀錄（只斷開關聯；媒體依保存期限清除）
ALTER TABLE media DROP CONSTRAINT media_robot_id_fkey,
  ADD CONSTRAINT media_robot_id_fkey FOREIGN KEY (robot_id) REFERENCES robots(id) ON DELETE SET NULL;
ALTER TABLE media DROP CONSTRAINT media_camera_id_fkey,
  ADD CONSTRAINT media_camera_id_fkey FOREIGN KEY (camera_id) REFERENCES cameras(id) ON DELETE SET NULL;
ALTER TABLE media DROP CONSTRAINT media_created_by_fkey,
  ADD CONSTRAINT media_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE media DROP CONSTRAINT media_alarm_id_fkey,
  ADD CONSTRAINT media_alarm_id_fkey FOREIGN KEY (alarm_id) REFERENCES alarms(id) ON DELETE SET NULL;
ALTER TABLE media DROP CONSTRAINT media_task_id_fkey,
  ADD CONSTRAINT media_task_id_fkey FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL;

CREATE INDEX ON media (kind, created_at DESC);
CREATE INDEX ON media (robot_id, created_at DESC);

INSERT INTO settings (key, value) VALUES
 -- 同一個瀏覽器同時播放的影像上限（影像與整合 §1）
 ('media.maxStreams', '16'),
 -- 手動錄影最長秒數，到了自動停止
 ('media.maxRecordSec', '600')
ON CONFLICT (key) DO NOTHING;

-- Down Migration
DELETE FROM settings WHERE key IN ('media.maxStreams','media.maxRecordSec');
DROP INDEX media_robot_id_created_at_idx;
DROP INDEX media_kind_created_at_idx;
ALTER TABLE media DROP CONSTRAINT media_task_id_fkey,
  ADD CONSTRAINT media_task_id_fkey FOREIGN KEY (task_id) REFERENCES tasks(id);
ALTER TABLE media DROP CONSTRAINT media_alarm_id_fkey,
  ADD CONSTRAINT media_alarm_id_fkey FOREIGN KEY (alarm_id) REFERENCES alarms(id);
ALTER TABLE media DROP CONSTRAINT media_created_by_fkey,
  ADD CONSTRAINT media_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id);
ALTER TABLE media DROP CONSTRAINT media_camera_id_fkey,
  ADD CONSTRAINT media_camera_id_fkey FOREIGN KEY (camera_id) REFERENCES cameras(id);
ALTER TABLE media DROP CONSTRAINT media_robot_id_fkey,
  ADD CONSTRAINT media_robot_id_fkey FOREIGN KEY (robot_id) REFERENCES robots(id);
ALTER TABLE media DROP COLUMN content_type;
ALTER TABLE media DROP COLUMN ended_at;
ALTER TABLE media DROP COLUMN floor_id;
ALTER TABLE media DROP COLUMN stream_key;
ALTER TABLE media DROP COLUMN source;
