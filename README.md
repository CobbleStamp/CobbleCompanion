# CobbleCompanion

A personal AI companion you name, raise, and bond with — one continuous, cloud-resident being
that learns you and your world, acts on your behalf, and is **proactive** rather than passive.
For the full product vision see [`docs/product-overview.md`](./docs/product-overview.md).

> **Status: the web PoC and its follow-on workstreams are complete (Phases 0–15 ✅).** The
> companion talks end-to-end (Phase 0); ingests sources into **semantic memory** with grounded,
> cited recall (Phase 1); forms **episodic memory** and an **evolving personality** (Phase 2);
> **acts** through a tool framework behind a propose→approve gate (Phase 3); **initiates** on its
> own via a motivation engine with stamina/energy vitality (Phase 4); shows **growth** and a feeding
> economy (Phase 5); acquires **MCP and CLI tools at runtime** with no redeploy (Phases 9–10); builds
> a structured **user model** (Phases 11–13); **greets** on arrival (Phase 14); and pushes new
> messages over a **standing event channel** (Phase 15). Native mobile/desktop surfaces (Phases 6–8)
> are the next frontier. A TypeScript monorepo (`packages/{shared,core,api,web}` + `db/`) with the
> agent-loop harness, provider-agnostic LLM and embedding gateways, and an ≥80%-coverage test suite.
> Cloud Run deployment lives in `infra/` (Pulumi). See `docs/development-plan.md` §2.

## Documentation

Start here, then follow the links:

| Document | Covers |
|---|---|
| [`docs/product-overview.md`](./docs/product-overview.md) | What the product is and why |
| [`docs/development-plan.md`](./docs/development-plan.md) | Scope, phases, acceptance criteria, roadmap |
| [`docs/architecture.md`](./docs/architecture.md) | Components, the agent loop, flows, decisions |
| [`docs/implementation.md`](./docs/implementation.md) | Data models, harness internals, config, security |
| [`AGENTS.md`](./AGENTS.md) · [`CLAUDE.md`](./CLAUDE.md) | Working rules · AI-agent entry point |

## Stack

TypeScript end-to-end — Node/Fastify API + React/Vite web client, Postgres + `pgvector`,
Drizzle ORM, and provider-agnostic LLM + embedding gateways (default OpenRouter). Semantic
memory chunks ingested sources, embeds them into `pgvector`, and recalls them via hybrid
(vector + full-text) search. Full rationale:
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

Deployed as a single GCP Cloud Run service via Pulumi (the Fastify API serves the built SPA from
one origin). Full setup — components, the OAuth client, and `make deploy-dev` — lives in
[`infra/README.md`](./infra/README.md) and [`infra/gcp/README.md`](./infra/gcp/README.md).

### Verify

```bash
pnpm typecheck                # all packages
pnpm test                     # full suite
pnpm test:coverage            # suite + ≥80% coverage gate
pnpm lint                     # prettier check (code)
```

These are exactly what CI runs (`.github/workflows/ci.yml`).
