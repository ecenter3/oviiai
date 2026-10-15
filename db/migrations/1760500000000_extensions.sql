-- Up Migration
-- 基礎擴充。資料表依工程開發手冊「資料庫」章節，於後續 migration 逐一建立。
CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- Down Migration
DROP EXTENSION IF EXISTS citext;
DROP EXTENSION IF EXISTS pgcrypto;
DROP EXTENSION IF EXISTS timescaledb;
