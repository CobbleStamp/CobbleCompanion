.DEFAULT_GOAL := help
.PHONY: help install dev test typecheck lint coverage \
        run-docker build-docker stop-docker clean-docker logs-docker

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

# --- Local (host) workflow ---

install: ## Install workspace dependencies (pnpm)
	pnpm install

dev: ## Run Postgres + migrate + API + web on the host (scripts/dev.sh)
	./scripts/dev.sh

test: ## Run the full test suite
	pnpm test

coverage: ## Run tests with the >=80% coverage gate
	pnpm test:coverage

typecheck: ## Typecheck every package
	pnpm typecheck

lint: ## Prettier format check (code)
	pnpm lint

# --- Docker workflow ---

run-docker: ## Build images and run the full stack (Postgres + API + web) in Docker
	docker compose up --build

build-docker: ## Build the Docker images without starting them
	docker compose build

stop-docker: ## Stop and remove the containers (keeps the DB volume)
	docker compose down

clean-docker: ## Stop containers and delete the DB volume
	docker compose down -v

logs-docker: ## Tail logs from all running containers
	docker compose logs -f
