#!/usr/bin/env bash
# Local dev bootstrap: start Postgres, apply migrations, then run API + web.
# Prereqs: docker, pnpm install already run, and a .env file (copy .env.example).
set -euo pipefail

cd "$(dirname "$0")/.."

echo "→ starting Postgres (docker compose)"
docker compose up -d postgres

echo "→ applying migrations"
pnpm db:migrate

echo "→ starting API + web (parallel)"
pnpm dev
