#!/usr/bin/env bash
# make ci 用：與 CI 相同的 migration 檢查（up → 全部 down → 再 up），在一個暫存資料庫上跑，
# 不動開發資料庫（全部 down 會清空所有資料）。需要 make up 起好的 db 容器與 .env。
set -euo pipefail
cd "$(dirname "$0")/.."

COMPOSE=(docker compose -f infra/docker-compose.dev.yml --env-file .env)
DB=rms_ci_migrate_$$
URL=$(grep -E '^DATABASE_URL=' .env | cut -d= -f2- | sed -E "s#/[^/?]+(\?|$)#/${DB}\1#")

psql_admin() { "${COMPOSE[@]}" exec -T db sh -c "psql -v ON_ERROR_STOP=1 -qAt -U \"\$POSTGRES_USER\" -d postgres -c \"$1\""; }
cleanup() { psql_admin "DROP DATABASE IF EXISTS ${DB} WITH (FORCE)" >/dev/null || true; }
trap cleanup EXIT

psql_admin "CREATE DATABASE ${DB}"
migrate() { (cd backend && DATABASE_URL="$URL" node node_modules/node-pg-migrate/bin/node-pg-migrate.js -m ../db/migrations --migration-file-language sql "$@" >/dev/null); }
echo "migration up";      migrate up
echo "migration down 0";  migrate down 0
echo "migration up";      migrate up
echo "migration 檢查通過（暫存資料庫 ${DB}）"
