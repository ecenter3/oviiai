PY := $(if $(wildcard adapters/.venv/bin/python),.venv/bin/python,python3)
COMPOSE = docker compose -f infra/docker-compose.dev.yml --env-file .env

.PHONY: up up-media down logs ps migrate seed test test-adapters test-backend mock

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

test: test-adapters test-backend

test-adapters:
	cd adapters && $(PY) -m pytest -q

test-backend:
	cd backend && npm test

mock:
	cd adapters && $(PY) -m mock.run --config mock/robots.yaml
