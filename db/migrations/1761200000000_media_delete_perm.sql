-- Up Migration
-- PR #12 審查第 1 點：刪除抓拍與錄影改為操作權限 op.media，預設只給系統管理員。
-- 其他角色要刪除，由系統管理員在「角色管理」勾選。
UPDATE roles SET perms = array_append(perms, 'op.media')
 WHERE name = '系統管理員' AND NOT ('op.media' = ANY (perms));

-- Down Migration
UPDATE roles SET perms = array_remove(perms, 'op.media');
