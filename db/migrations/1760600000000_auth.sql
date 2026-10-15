-- Up Migration
-- 工程開發手冊「資料庫」§1 帳號與權限
CREATE TABLE roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  description text,
  perms       text[] NOT NULL DEFAULT '{}',   -- 權限碼，見後端邏輯 §6
  is_system   boolean NOT NULL DEFAULT false, -- 系統管理員不可刪
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username       text NOT NULL UNIQUE,
  display_name   text NOT NULL,
  password_hash  text NOT NULL,              -- argon2id
  role_id        uuid NOT NULL REFERENCES roles(id),
  phone          text,
  email          text,
  enabled        boolean NOT NULL DEFAULT true,
  failed_logins  int NOT NULL DEFAULT 0,
  locked_until   timestamptz,
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz
);
-- 手冊未列；refresh 以 token_hash 查詢、改密碼時依 user_id 撤銷
CREATE UNIQUE INDEX ON refresh_tokens (token_hash);
CREATE INDEX ON refresh_tokens (user_id);

CREATE TABLE op_logs (
  id         bigserial PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  user_id    uuid REFERENCES users(id),
  username   text NOT NULL,                  -- 冗餘保存，帳號刪除後仍可查
  action     text NOT NULL,                  -- e.g. robot.estop, task.approve, settings.update
  target     text,                           -- e.g. ANBOT-003, task:uuid
  detail     jsonb,
  ip         inet
);
CREATE INDEX ON op_logs (at DESC);
CREATE INDEX ON op_logs (user_id, at DESC);

-- Down Migration
DROP TABLE op_logs;
DROP TABLE refresh_tokens;
DROP TABLE users;
DROP TABLE roles;
