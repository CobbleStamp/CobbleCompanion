.DEFAULT_GOAL := help
.PHONY: help install dev test typecheck lint coverage \
        run-docker build-docker stop-docker clean-docker logs-docker \
        pulumi-preview pulumi push-image-dev deploy-dev

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

# --- Cloud deploy (GCP Cloud Run via Pulumi) ---
# Prereqs: gcloud auth + project (cobblecompanion), AWS creds for the S3 state
# backend, PULUMI_CONFIG_PASSPHRASE exported, infra/gcp/Pulumi.dev.yaml filled
# in. See infra/gcp/README.md.

PULUMI_GCP_DIR := infra/gcp
DEV_STACK := dev
GCP_REGION ?= us-central1

pulumi-preview: ## Pulumi preview against the GCP dev stack (no changes applied)
	@command -v pulumi >/dev/null || (echo "pulumi CLI not on PATH"; exit 1)
	@test -n "$$PULUMI_CONFIG_PASSPHRASE" || (echo "PULUMI_CONFIG_PASSPHRASE not set"; exit 1)
	@cd $(PULUMI_GCP_DIR) && pulumi stack select $(DEV_STACK) && pulumi preview

pulumi: ## Pulumi up against the GCP dev stack (re-applies; does NOT rebuild the image)
	@command -v pulumi >/dev/null || (echo "pulumi CLI not on PATH"; exit 1)
	@test -n "$$PULUMI_CONFIG_PASSPHRASE" || (echo "PULUMI_CONFIG_PASSPHRASE not set"; exit 1)
	@cd $(PULUMI_GCP_DIR) && pulumi stack select $(DEV_STACK) && pulumi up

push-image-dev: ## Build + push the api image to Artifact Registry with a git-sha tag
	@command -v docker >/dev/null || (echo "docker CLI not on PATH"; exit 1)
	@test -n "$$GCP_PROJECT" || (echo "GCP_PROJECT env var required"; exit 1)
	@TAG=$$(git rev-parse --short HEAD); \
	  REPO=$(GCP_REGION)-docker.pkg.dev/$$GCP_PROJECT/cobblecompanion; \
	  echo "→ build + push api:$$TAG (linux/amd64)"; \
	  docker buildx build --platform linux/amd64 --provenance=false \
	    --target cloudrun -t $$REPO/api:$$TAG --push . || exit 1; \
	  echo "Pushed tag: $$TAG → roll with: make deploy-dev TAG=$$TAG"

deploy-dev: ## End-to-end dev deploy: build + push image, bump imageTag, pulumi up (TAG=<sha> skips rebuild)
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
	      --target cloudrun -t $$REPO/api:$$DEPLOY_TAG --push . || exit 1; \
	  fi; \
	  echo "→ bumping Pulumi imageTag → $$DEPLOY_TAG"; \
	  cd $(PULUMI_GCP_DIR) && pulumi stack select $(DEV_STACK) >/dev/null && \
	  pulumi config set cobblecompanion-gcp:imageTag "$$DEPLOY_TAG" && \
	  pulumi up
