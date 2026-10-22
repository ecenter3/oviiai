PY := $(if $(wildcard adapters/.venv/bin/python),.venv/bin/python,python3)
COMPOSE = docker compose -f infra/docker-compose.dev.yml --env-file .env

.PHONY: up up-media down logs ps migrate seed seed-mock test lint test-adapters test-backend test-contracts test-frontend contracts mock ci ci-migrate build

up:
	$(COMPOSE) up -d

up-media:
	$(COMPOSE) --profile media up -d

down:
	$(COMPOSE) --profile media down

logs:
	$(COMPOSE) logs -f --tail=100

ps:
	$(COMPOSE) ps

migrate:
	cd backend && npm run migrate

seed:
	cd backend && npm run seed

# 開發用：登記 make mock 的模擬場域（6 台機器人、樓層尺寸、充電樁、攝影機）
seed-mock:
	$(COMPOSE) exec -T db sh -c 'psql -v ON_ERROR_STOP=1 -U "$$POSTGRES_USER" -d "$$POSTGRES_DB"' < db/seeds/mock-site.sql

# 先做與 CI 相同的靜態檢查（vitest 不做型別檢查，測試檔的型別錯誤只有 tsc 抓得到）
test: lint test-contracts test-adapters test-backend test-frontend

# ruff（轉接器）＋ tsc --noEmit（contracts、後端、前端；含測試檔）
lint: contracts
	cd adapters && $(PY) -m ruff check .
	cd packages/contracts && npm run lint
	cd backend && npm run lint
	cd frontend && npm run lint

# 推送前完整模擬 CI（.github/workflows/ci.yml）：靜態檢查、測試、migration 來回、建置。
# migration 在暫存資料庫檢查（全部 down 會清空資料，不能在開發資料庫上跑）
ci: test ci-migrate build

ci-migrate:
	scripts/ci-migrate.sh

build: contracts
	cd backend && npm run build
	cd frontend && npm run build

# 後端引用 packages/contracts 的編譯結果，改了 contracts 要先 build
contracts:
	cd packages/contracts && npm run build

test-contracts:
	cd packages/contracts && npm test

test-adapters:
	cd adapters && $(PY) -m pytest -q

test-backend: contracts
	cd backend && npm test

test-frontend:
	cd frontend && npm test

mock:
	cd adapters && $(PY) -m mock.run --config mock/robots.yaml
