COMPOSE = docker compose -f infra/docker-compose.dev.yml --env-file .env

.PHONY: up up-media down logs ps migrate test test-adapters test-backend mock

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

test: test-adapters test-backend

test-adapters:
	cd adapters && python3 -m pytest -q

test-backend:
	cd backend && npm test

mock:
	cd adapters && python3 -m mock.run --config mock/robots.yaml
