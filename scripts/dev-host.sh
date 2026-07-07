#!/usr/bin/env bash
# Host dev for the CLI-tools workflow: Postgres in Docker; API + Discord on the
# HOST (this Mac). Running the API on the host is what lets the companion's CLI
# tools resolve — CLI_TOOLS_PATH and each TOOL.json `binary` (e.g.
# ~/.local/bin/ibkr-cli) are host paths that do not exist inside the api
# container. Web is intentionally not started.
#
# Ctrl-C stops both host processes; the Postgres container keeps running (stop it
# with `docker compose stop postgres`).
set -euo pipefail

cd "$(dirname "$0")/.."

test -f .env || { echo "✗ .env not found. Run: cp .env.example .env"; exit 1; }

echo "→ starting Postgres only (docker compose)"
docker compose up -d postgres

echo "→ loading .env into the environment"
set -a
# shellcheck disable=SC1091
source .env
set +a

# .env already points DATABASE_URL / DISCORD_WS_BASE_URL / DISCORD_MINT_URL at
# localhost (Docker overrides those to compose hostnames at runtime). The one
# value baked for the compose network is the reconcile URL — the API POSTs it
# after a token save so the Discord service reconnects at once. On the host the
# service listens on localhost, so repoint it there.
export DISCORD_RECONCILE_URL="http://localhost:${DISCORD_SERVICE_PORT:-8080}/internal/reconcile"

echo "→ applying migrations"
pnpm db:migrate

echo "→ starting API (:${PORT:-3000}) + Discord service (:${DISCORD_SERVICE_PORT:-8080}) on the host"
echo "  (Ctrl-C stops both; Postgres keeps running)"
pnpm --parallel --filter @cobble/api --filter @cobble/discord run dev
