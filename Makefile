.DEFAULT_GOAL := help
.PHONY: help install dev dev-host test test-integration typecheck lint coverage ci \
        run-docker build-docker stop-docker clean-docker logs-docker \
        pulumi-preview pulumi push-image-dev deploy-dev \
        pulumi-preview-gcp pulumi-gcp push-image-gcp deploy-gcp

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

# --- Local (host) workflow ---

install: ## Install workspace dependencies (pnpm)
	pnpm install

dev: ## Run Postgres + migrate + API + web on the host (scripts/dev.sh)
	./scripts/dev.sh

dev-host: ## Postgres in Docker; API + Discord on the host (for host CLI tools). No web. (scripts/dev-host.sh)
	./scripts/dev-host.sh

test: ## Run the full test suite
	pnpm test

test-integration: ## Run integration tests against real Postgres (boots docker-compose Postgres)
	@echo "→ starting Postgres (pgvector/pgvector:pg16)…"
	docker compose up -d postgres
	@echo "→ waiting for Postgres to report healthy…"
	@until [ "$$(docker inspect -f '{{.State.Health.Status}}' $$(docker compose ps -q postgres) 2>/dev/null)" = "healthy" ]; do \
	  sleep 1; done
	@echo "→ running *.integration.test.ts against localhost:5432/cobble"
	DATABASE_URL=postgres://postgres:postgres@localhost:5432/cobble pnpm test:integration

coverage: ## Run tests with the >=80% coverage gate
	pnpm test:coverage

typecheck: ## Typecheck every package
	pnpm typecheck

lint: ## Prettier format check (code)
	pnpm lint

ci: ## Run the full CI verify job locally (lint + typecheck + coverage gate)
	pnpm lint
	pnpm typecheck
	pnpm test:coverage

# --- Docker workflow ---

run-docker: ## Build + run the full stack (Postgres + migrate + API + web + discord) in Docker
	@test -f .env || { echo "✗ .env not found. Run: cp .env.example .env"; \
	  echo "  (Compose reads .env for GOOGLE_CLIENT_ID, OPENROUTER_API_KEY.)"; exit 1; }
	@if ! grep -Eq '^GOOGLE_CLIENT_ID=.+' .env; then \
	  echo "⚠  GOOGLE_CLIENT_ID is empty in .env — the API will not boot (sign-in scheme)."; fi
	@echo "→ bringing up Postgres + API (migrates + seeds on boot) + web + discord worker"
	@echo "  open http://localhost:3001  ·  API on http://localhost:3000"
	@echo "  Google sign-in needs http://localhost:3001 in the OAuth client's Authorized JavaScript origins."
	docker compose up --build

build-docker: ## Build the Docker images without starting them
	docker compose build

stop-docker: ## Stop and remove the containers (keeps the DB volume)
	docker compose down

clean-docker: ## Stop containers and delete the DB (bind-mounted ./data/postgres)
	docker compose down -v
	@# The DB is a bind mount, not a named volume, so `down -v` does not remove
	@# it. Wipe the host dir explicitly so the next `run-docker` migrates a fresh
	@# DB. Done in a root container to avoid host uid/permission issues on Linux.
	docker run --rm -v "$(PWD)/data:/data" alpine sh -c 'rm -rf /data/postgres'

logs-docker: ## Tail logs from all running containers
	docker compose logs -f

# --- Cloud deploy (Pulumi) — two options, pick one (docs/infra-setup.md) ---
# AWS EC2 micro is canonical (unsuffixed targets below); GCP Cloud Run is the
# alternative (-gcp targets further down). Both build the Dockerfile `server`
# target and use the same S3 state backend + PULUMI_CONFIG_PASSPHRASE.
#
# AWS prereqs: AWS creds (also the S3 state backend), PULUMI_CONFIG_PASSPHRASE
# exported, AWS_REGION set, infra/aws/Pulumi.dev.yaml filled in. See
# infra/aws/README.md and docs/infra-setup.md.

PULUMI_AWS_DIR := infra/aws
PULUMI_GCP_DIR := infra/gcp
DEV_STACK := dev
GCP_REGION ?= us-central1

pulumi-preview: ## Pulumi preview against the AWS dev stack (no changes applied)
	@command -v pulumi >/dev/null || (echo "pulumi CLI not on PATH"; exit 1)
	@test -n "$$PULUMI_CONFIG_PASSPHRASE" || (echo "PULUMI_CONFIG_PASSPHRASE not set"; exit 1)
	@cd $(PULUMI_AWS_DIR) && pulumi stack select $(DEV_STACK) && pulumi preview

pulumi: ## Pulumi up against the AWS dev stack (re-applies; does NOT rebuild the image)
	@command -v pulumi >/dev/null || (echo "pulumi CLI not on PATH"; exit 1)
	@test -n "$$PULUMI_CONFIG_PASSPHRASE" || (echo "PULUMI_CONFIG_PASSPHRASE not set"; exit 1)
	@cd $(PULUMI_AWS_DIR) && pulumi stack select $(DEV_STACK) && pulumi up

push-image-dev: ## Build + push the server image to ECR with a git-sha tag
	@command -v docker >/dev/null || (echo "docker CLI not on PATH"; exit 1)
	@test -n "$$AWS_REGION" || (echo "AWS_REGION env var required"; exit 1)
	@REPO=$$(cd $(PULUMI_AWS_DIR) && pulumi stack select $(DEV_STACK) >/dev/null && pulumi stack output ecrRepoUrl) || \
	  (echo "no ecrRepoUrl output — run 'make pulumi' first"; exit 1); \
	  REGISTRY=$${REPO%%/*}; TAG=$$(git rev-parse --short HEAD); \
	  echo "→ login + build + push $$REPO:$$TAG (linux/amd64)"; \
	  aws ecr get-login-password --region $$AWS_REGION \
	    | docker login --username AWS --password-stdin $$REGISTRY || exit 1; \
	  docker buildx build --platform linux/amd64 --provenance=false \
	    --target server -t $$REPO:$$TAG --push . || exit 1; \
	  echo "Pushed tag: $$TAG → roll with: make deploy-dev TAG=$$TAG"

deploy-dev: ## End-to-end dev deploy: build + push image, bump imageTag, pulumi up (TAG=<sha> skips rebuild)
	@command -v docker >/dev/null || (echo "docker CLI not on PATH"; exit 1)
	@command -v pulumi >/dev/null || (echo "pulumi CLI not on PATH"; exit 1)
	@test -n "$$AWS_REGION" || (echo "AWS_REGION env var required"; exit 1)
	@test -n "$$PULUMI_CONFIG_PASSPHRASE" || (echo "PULUMI_CONFIG_PASSPHRASE not set"; exit 1)
	@cd $(PULUMI_AWS_DIR) && pulumi stack select $(DEV_STACK) >/dev/null || exit 1
	@if [ -n "$$TAG" ]; then \
	    DEPLOY_TAG="$$TAG"; \
	    echo "→ using existing tag: $$DEPLOY_TAG (skipping build + push)"; \
	  else \
	    REPO=$$(cd $(PULUMI_AWS_DIR) && pulumi stack output ecrRepoUrl) || exit 1; \
	    REGISTRY=$${REPO%%/*}; DEPLOY_TAG=$$(git rev-parse --short HEAD); \
	    echo "→ shipping tag: $$DEPLOY_TAG"; \
	    aws ecr get-login-password --region $$AWS_REGION \
	      | docker login --username AWS --password-stdin $$REGISTRY || exit 1; \
	    docker buildx build --platform linux/amd64 --provenance=false \
	      --target server -t $$REPO:$$DEPLOY_TAG --push . || exit 1; \
	  fi; \
	  echo "→ bumping Pulumi imageTag → $$DEPLOY_TAG (replaces the instance)"; \
	  cd $(PULUMI_AWS_DIR) && \
	  pulumi config set cobblecompanion-aws:imageTag "$$DEPLOY_TAG" && \
	  pulumi up

# --- Cloud deploy: GCP Cloud Run (alternative) ---
# Prereqs: gcloud auth + project, AWS creds for the S3 state backend,
# PULUMI_CONFIG_PASSPHRASE + GCP_PROJECT + GCP_REGION set, infra/gcp/Pulumi.dev.yaml
# filled in. See infra/gcp/README.md.

pulumi-preview-gcp: ## Pulumi preview against the GCP dev stack (no changes applied)
	@command -v pulumi >/dev/null || (echo "pulumi CLI not on PATH"; exit 1)
	@test -n "$$PULUMI_CONFIG_PASSPHRASE" || (echo "PULUMI_CONFIG_PASSPHRASE not set"; exit 1)
	@cd $(PULUMI_GCP_DIR) && pulumi stack select $(DEV_STACK) && pulumi preview

pulumi-gcp: ## Pulumi up against the GCP dev stack (re-applies; does NOT rebuild the image)
	@command -v pulumi >/dev/null || (echo "pulumi CLI not on PATH"; exit 1)
	@test -n "$$PULUMI_CONFIG_PASSPHRASE" || (echo "PULUMI_CONFIG_PASSPHRASE not set"; exit 1)
	@cd $(PULUMI_GCP_DIR) && pulumi stack select $(DEV_STACK) && pulumi up

push-image-gcp: ## Build + push the server image to Artifact Registry with a git-sha tag
	@command -v docker >/dev/null || (echo "docker CLI not on PATH"; exit 1)
	@test -n "$$GCP_PROJECT" || (echo "GCP_PROJECT env var required"; exit 1)
	@TAG=$$(git rev-parse --short HEAD); \
	  REPO=$(GCP_REGION)-docker.pkg.dev/$$GCP_PROJECT/cobblecompanion; \
	  echo "→ build + push api:$$TAG (linux/amd64)"; \
	  docker buildx build --platform linux/amd64 --provenance=false \
	    --target server -t $$REPO/api:$$TAG --push . || exit 1; \
	  echo "Pushed tag: $$TAG → roll with: make deploy-gcp TAG=$$TAG"

deploy-gcp: ## End-to-end GCP deploy: build + push image, bump imageTag, pulumi up (TAG=<sha> skips rebuild)
	@command -v docker >/dev/null || (echo "docker CLI not on PATH"; exit 1)
	@command -v pulumi >/dev/null || (echo "pulumi CLI not on PATH"; exit 1)
	@test -n "$$GCP_PROJECT" || (echo "GCP_PROJECT env var required"; exit 1)
	@test -n "$$PULUMI_CONFIG_PASSPHRASE" || (echo "PULUMI_CONFIG_PASSPHRASE not set"; exit 1)
	@if [ -n "$$TAG" ]; then \
	    DEPLOY_TAG="$$TAG"; \
	    echo "→ using existing tag: $$DEPLOY_TAG (skipping build + push)"; \
	  else \
	    DEPLOY_TAG=$$(git rev-parse --short HEAD); \
	    REPO=$(GCP_REGION)-docker.pkg.dev/$$GCP_PROJECT/cobblecompanion; \
	    echo "→ shipping tag: $$DEPLOY_TAG"; \
	    docker buildx build --platform linux/amd64 --provenance=false \
	      --target server -t $$REPO/api:$$DEPLOY_TAG --push . || exit 1; \
	  fi; \
	  echo "→ bumping Pulumi imageTag → $$DEPLOY_TAG"; \
	  cd $(PULUMI_GCP_DIR) && pulumi stack select $(DEV_STACK) >/dev/null && \
	  pulumi config set cobblecompanion-gcp:imageTag "$$DEPLOY_TAG" && \
	  pulumi up
