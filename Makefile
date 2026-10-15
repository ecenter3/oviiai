PY := $(if $(wildcard adapters/.venv/bin/python),.venv/bin/python,python3)
COMPOSE = docker compose -f infra/docker-compose.dev.yml --env-file .env

.PHONY: up up-media down logs ps migrate seed seed-mock test test-adapters test-backend test-contracts test-frontend contracts mock

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

# 開發用：在資料庫登記 make mock 的 6 台模擬機器人
seed-mock:
	$(COMPOSE) exec -T db sh -c 'psql -v ON_ERROR_STOP=1 -U "$$POSTGRES_USER" -d "$$POSTGRES_DB"' < db/seeds/mock-robots.sql

test: test-contracts test-adapters test-backend test-frontend

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
