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
> messages live over a **permanent WebSocket** (the Phase 15 standing channel, reworked into the
> stateless WS embodiment model in Phase D). Native mobile/desktop surfaces (Phases 6–8)
> are the next frontier. A TypeScript monorepo (`packages/{shared,core,api,web}` + `db/`) with the
> agent-loop harness, provider-agnostic LLM and embedding gateways, and an ≥80%-coverage test suite.
> Deployment is managed with Pulumi under `infra/` — two options, AWS EC2 micro or
> GCP Cloud Run (see `docs/infra-setup.md`). See `docs/development-plan.md` §2.

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
cp .env.example .env          # set GOOGLE_CLIENT_ID + OPENROUTER_API_KEY
                              # (or set LLM_PROVIDER=fake)

# one-shot: start Postgres, migrate, run API + web
./scripts/dev.sh

# …or run the pieces individually
docker compose up -d postgres
pnpm db:migrate
pnpm dev                      # API on :3000, web on :3001
```

Then open <http://localhost:3001>. The web client signs in with **Google Sign-In**, so set
`GOOGLE_CLIENT_ID` to an OAuth Web client ID with `http://localhost:3001` as an authorized origin
(see `infra/README.md`) — the API will not boot without it.

Auth is per-request, not a server-wide mode: Google Sign-In and service-token auth are always live at
once, so CobbleCompanion can back another service while also serving browser clients. Register a
consumer credential — `pnpm --filter @cobble/db service add <client_id>` prints a secret once. Such
callers send `X-Service-Client-Id: <client_id>`, `Authorization: Bearer <secret>`, and `X-User-Id:
<uuid>` instead of a Google ID token, and are routed to service-token auth by the `X-Service-Client-Id`
header. Rotate with another `service add` and `service revoke <id>` (see `docs/implementation.md` §5).

To provision consumer credentials declaratively on launch instead of running the CLI, set
`SERVICE_REGISTRY_SEEDS` to a JSON array of `{ client_id, secret, secret_type?, label? }` — e.g.
`SERVICE_REGISTRY_SEEDS='[{"client_id":"sprout","secret":"<secret>","label":"seed"}]'`. Seeding is
additive and idempotent (each pair is inserted once; re-seeding is a no-op), and never revokes rows
it didn't seed. Secrets are deployment-managed — never commit them.

## Deployment

The same container (Fastify API + built SPA, one origin) deploys to **either** of two clouds, both via
Pulumi with Postgres on **Supabase**: a single **AWS EC2 `t3.micro`** behind **Caddy** (`infra/aws`,
canonical) or a **GCP Cloud Run** service (`infra/gcp`). The deployment diagrams, resource catalogs,
and cost for both live in [`docs/infra-setup.md`](./docs/infra-setup.md); the apply runbooks are in
[`infra/aws/README.md`](./infra/aws/README.md) and [`infra/gcp/README.md`](./infra/gcp/README.md).

### Verify

```bash
pnpm typecheck                # all packages
pnpm test                     # full suite (in-memory PGlite — no Docker needed)
pnpm test:coverage            # suite + ≥80% coverage gate
pnpm lint                     # prettier check (code)
make test-integration         # *.integration.test.ts vs real Postgres in Docker
```

`pnpm test` and `pnpm test:coverage` run against in-memory PGlite. The
concurrency suites (`*.integration.test.ts`) need a real Postgres, so they are
excluded from the default run; `make test-integration` boots the docker-compose
`postgres` service and runs them against it. All of these are what CI runs
(`.github/workflows/ci.yml`).
