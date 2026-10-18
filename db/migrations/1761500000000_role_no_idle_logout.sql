-- Up Migration
-- PR #16 審查第 1 點：「不自動登出」改在角色上設定（例：監看大屏角色），全站設定 auth.idleMinutes 只管預設分鐘數
ALTER TABLE roles ADD COLUMN no_idle_logout boolean NOT NULL DEFAULT false;
-- 全站已設成 0（不自動登出）的改回預設 30 分鐘；需要常駐的電腦改用角色設定
UPDATE settings SET value = '30'::jsonb WHERE key = 'auth.idleMinutes' AND value = '0'::jsonb;

-- Down Migration
ALTER TABLE roles DROP COLUMN no_idle_logout;
