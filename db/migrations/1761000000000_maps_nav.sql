-- Up Migration
-- 地圖管理、機器人管理（T-25）、導航後端（T-23）、PR #9 審查修正

-- 機器人連線的敏感欄位（密碼、金鑰）以 pgp_sym_encrypt 加密存放；conn 只放 host、port 等非敏感值
ALTER TABLE robots ADD COLUMN conn_secret bytea;

-- 巡邏排程：建立者、最近一次觸發（畫面顯示、補跑判斷）
ALTER TABLE patrol_schedules ADD COLUMN created_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE patrol_schedules ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE patrol_schedules ADD COLUMN last_run_at timestamptz;
ALTER TABLE patrol_schedules ADD COLUMN last_task_id uuid REFERENCES tasks(id) ON DELETE SET NULL;
ALTER TABLE patrol_schedules ADD CONSTRAINT patrol_schedules_priority_check CHECK (priority IN ('P1','P2','P3','P4'));
ALTER TABLE patrol_schedules ADD CONSTRAINT patrol_schedules_loops_check CHECK (loops BETWEEN 1 AND 100);
ALTER TABLE patrol_schedules ADD CONSTRAINT patrol_schedules_once_check CHECK (repeat <> 'once' OR once_date IS NOT NULL);
CREATE INDEX ON patrol_schedules (path_id);
CREATE INDEX ON pois (floor_id);
CREATE INDEX ON zones (floor_id);
CREATE INDEX ON paths (floor_id);

INSERT INTO alarm_rules (type, category, name, level, popup, sound, need_handle, dedup_sec) VALUES
 -- PR #9 審查第 3 點：轉接器斷線合併成一筆，不逐台發離線
 ('adapter_down',   'system', '轉接器斷線', 2, false, true,  true,  60),
 -- 後端邏輯 §4：指定的機器人急停、離線或電量不足，排程任務延後（最多 30 分鐘）
 ('patrol_delayed', 'system', '巡邏延後',   3, false, false, false, 1800)
ON CONFLICT (type) DO NOTHING;

-- Down Migration
DELETE FROM alarms WHERE type IN ('adapter_down','patrol_delayed');
DELETE FROM alarm_rules WHERE type IN ('adapter_down','patrol_delayed');
DROP INDEX paths_floor_id_idx;
DROP INDEX zones_floor_id_idx;
DROP INDEX pois_floor_id_idx;
DROP INDEX patrol_schedules_path_id_idx;
ALTER TABLE patrol_schedules DROP CONSTRAINT patrol_schedules_once_check;
ALTER TABLE patrol_schedules DROP CONSTRAINT patrol_schedules_loops_check;
ALTER TABLE patrol_schedules DROP CONSTRAINT patrol_schedules_priority_check;
ALTER TABLE patrol_schedules DROP COLUMN last_task_id;
ALTER TABLE patrol_schedules DROP COLUMN last_run_at;
ALTER TABLE patrol_schedules DROP COLUMN created_at;
ALTER TABLE patrol_schedules DROP COLUMN created_by;
ALTER TABLE robots DROP COLUMN conn_secret;
