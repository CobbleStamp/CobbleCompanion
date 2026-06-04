# CobbleCompanion

A personal AI companion you name, raise, and bond with — one continuous, cloud-resident being
that learns you and your world, acts on your behalf, and is **proactive** rather than passive.
For the full product vision see [`docs/product-overview.md`](./docs/product-overview.md).

> **Status: Phase 2 (memory & continuity) — done.** On top of the Phase 0 walking skeleton
> (Google sign-in, companion creation, persisted streamed chat) and the Phase 1 knowledge
> organism (sources → semantic memory → grounded, cited answers), the companion now forms
> **episodic memory**: a background pass consolidates the conversation into time-anchored
> episodes it recalls by topic + time, and its **personality evolves** from them. A TypeScript
> monorepo (`packages/{shared,core,api,web}` + `db/`) with the agent-loop harness,
> provider-agnostic LLM and embedding gateways, and an ≥80%-coverage test suite. Cloud Run
> deployment lives in `infra/` (Pulumi). See `docs/development-plan.md` §3.

## Documentation

Start here, then follow the links:

| Document | Covers |
|---|---|
| [`docs/product-overview.md`](./docs/product-overview.md) | What the product is and why |
| [`docs/development-plan.md`](./docs/development-plan.md) | Scope, phases, acceptance criteria, roadmap |
| [`docs/architecture.md`](./docs/architecture.md) | Components, the agent loop, flows, decisions |
| [`docs/implementation.md`](./docs/implementation.md) | Data models, harness internals, config, security |
| [`AGENTS.md`](./AGENTS.md) · [`CLAUDE.md`](./CLAUDE.md) | Working rules · AI-agent entry point |

## Stack (Phases 0–1)

TypeScript end-to-end — Node/Fastify API + React/Vite web client, Postgres + `pgvector`,
Drizzle ORM, and provider-agnostic LLM + embedding gateways (default OpenRouter). Phase 1
adds semantic memory: ingested sources are chunked, embedded into `pgvector`, and recalled
via hybrid (vector + full-text) search. Full rationale:
[`docs/architecture.md`](./docs/architecture.md) §5.

## Quick start

Prerequisites: Node ≥22, pnpm 10, Docker (for local Postgres).

```bash
pnpm install
pnpm db:generate              # generate SQL migrations from the schema
cp .env.example .env          # AUTH_MODE=dev_bypass by default; fill in OPENROUTER_API_KEY
                              # (or set LLM_PROVIDER=fake)

# one-shot: start Postgres, migrate, run API + web
./scripts/dev.sh

# …or run the pieces individually
docker compose up -d postgres
pnpm db:migrate
pnpm dev                      # API on :3000, web on :3001
```

Then open <http://localhost:3001>. With `AUTH_MODE=dev_bypass` (the default in `.env.example`)
sign-in is skipped — you go straight to creating your companion. To exercise the real Google
Sign-In flow locally, set `AUTH_MODE=google` and `GOOGLE_CLIENT_ID` to an OAuth Web client ID
with `http://localhost:3001` as an authorized origin (see `infra/README.md`).

## Deployment

A single GCP Cloud Run service is managed with Pulumi under `infra/gcp` (Cloud Run, Artifact
Registry, Secret Manager); auth is Google Sign-In, so there is no auth service to provision —
just a Console-created OAuth client ID (`infra/README.md`). The Fastify API serves the built SPA
from one origin. See `infra/gcp/README.md` and the repo-root `Makefile` (`make deploy-dev`).

### Verify

```bash
pnpm typecheck                # all packages
pnpm test                     # full suite
pnpm test:coverage            # suite + ≥80% coverage gate
pnpm lint                     # prettier check (code)
```

These are exactly what CI runs (`.github/workflows/ci.yml`).
