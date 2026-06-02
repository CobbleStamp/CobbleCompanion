# CobbleCompanion

A personal AI companion you name, raise, and bond with — one continuous, cloud-resident being
that learns you and your world, acts on your behalf, and is **proactive** rather than passive.
For the full product vision see [`docs/product-overview.md`](./docs/product-overview.md).

> **Status: pre-Phase 0.** The product is in design. Documentation is complete for **Phase 0**
> (the web proof-of-concept); application code is not yet scaffolded, so there are no run/install
> steps yet. They will be added here when Phase 0 lands.

## Documentation

Start here, then follow the links:

| Document | Covers |
|---|---|
| [`docs/product-overview.md`](./docs/product-overview.md) | What the product is and why |
| [`docs/development-plan.md`](./docs/development-plan.md) | Scope, phases, acceptance criteria, roadmap |
| [`docs/architecture.md`](./docs/architecture.md) | Components, the agent loop, flows, decisions |
| [`docs/implementation.md`](./docs/implementation.md) | Data models, harness internals, config, security |
| [`AGENTS.md`](./AGENTS.md) · [`CLAUDE.md`](./CLAUDE.md) | Working rules · AI-agent entry point |

## Planned stack (Phase 0)

TypeScript end-to-end — Node/Fastify API + React/Vite web client, Postgres + `pgvector`. Full
rationale: [`docs/architecture.md`](./docs/architecture.md) §5.

## Quick start

_Not available yet_ — added with the Phase 0 scaffold. See
[`docs/development-plan.md`](./docs/development-plan.md) §3 for what Phase 0 delivers.
