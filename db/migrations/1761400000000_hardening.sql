-- Up Migration
-- 安全收尾（累積審查意見）：
-- (a) 管理員重設密碼或建立帳號後，使用者下次登入必須先改密碼
ALTER TABLE users ADD COLUMN must_change_password boolean NOT NULL DEFAULT false;
-- (d) 閒置多少分鐘自動登出（0＝不登出，例：控制室大螢幕）；「派工與充電規則」頁可調
INSERT INTO settings (key, value) VALUES ('auth.idleMinutes', '30') ON CONFLICT (key) DO NOTHING;

-- Down Migration
DELETE FROM settings WHERE key = 'auth.idleMinutes';
ALTER TABLE users DROP COLUMN must_change_password;
