-- Up Migration
-- op_logs.username 冗餘保存是為了「帳號刪除後仍可查」，但原本的外鍵會擋住刪除帳號；改成刪除時設為 NULL。
ALTER TABLE op_logs DROP CONSTRAINT op_logs_user_id_fkey;
ALTER TABLE op_logs ADD CONSTRAINT op_logs_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;

-- GET /oplogs 依人（username）與動作篩選
CREATE INDEX op_logs_username_at_idx ON op_logs (username, at DESC);
CREATE INDEX op_logs_action_at_idx ON op_logs (action text_pattern_ops, at DESC);

-- Down Migration
DROP INDEX op_logs_action_at_idx;
DROP INDEX op_logs_username_at_idx;
ALTER TABLE op_logs DROP CONSTRAINT op_logs_user_id_fkey;
ALTER TABLE op_logs ADD CONSTRAINT op_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);
