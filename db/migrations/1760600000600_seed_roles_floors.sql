-- Up Migration
-- 種子資料：預設 4 角色（系統規格書 §3 權限表）、3 樓層。
-- 系統管理員帳號含密碼，不放 migration，由 `npm run seed` 依 .env 建立。
-- 「幫助中心」(help) 規格表未列，預設全部角色可看。
INSERT INTO roles (name, description, perms, is_system) VALUES
 ('系統管理員', '全部頁面與操作', ARRAY[
   'monitor','robots','remote','nav','energy','reports','history','stats','runlog',
   'dispatch','face','env','points','media','sysalarm','bizalarm','alarmset',
   'captures','records','settings','params','robotmgr','maps','users','roles',
   'oplog','logs','versions','help',
   'op.remote','op.estop','op.dispatch','op.approve','op.alarm','op.config'], true),
 ('警衛', '控制室值班：監控、遙控、告警處理', ARRAY[
   'monitor','robots','remote','history','captures','records','face',
   'sysalarm','bizalarm','help',
   'op.remote','op.estop','op.alarm'], false),
 ('維修人員', '機器人維護：能耗、參數、日誌', ARRAY[
   'monitor','robots','energy','runlog','params','logs','versions','help',
   'op.estop','op.config'], false),
 ('主管', '派工審核與報表', ARRAY[
   'monitor','robots','reports','stats','sysalarm','bizalarm','dispatch','help',
   'op.dispatch','op.approve'], false)
ON CONFLICT (name) DO NOTHING;

INSERT INTO floors (id, name, sort, robot_quota) VALUES
 ('1f', '1F 辦公室',   1, 10),
 ('2f', '2F 工廠',     2, 10),
 ('b1', 'B1 停車場',   3, 8)
ON CONFLICT (id) DO NOTHING;

-- Down Migration
DELETE FROM floors WHERE id IN ('1f','2f','b1');
DELETE FROM roles WHERE name IN ('系統管理員','警衛','維修人員','主管');
