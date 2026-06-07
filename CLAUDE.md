# CLAUDE.md — AI Agent Quick Reference

This file is the entry point for AI agents. It contains structured facts about this repository — no narrative, just what you need to orient quickly and find authoritative information.

## Before Starting Any Task

Read `AGENTS.md` — it defines Iron Laws, process, and repo-specific constraints that govern all work.

---

## What This Repo Is

read docs/product-overview.md

## Canonical Documentation Sources

> **Rule:** Each fact lives in exactly one place. Follow the links; do not infer from secondary sources.

| Topic                          | Canonical Source                    |
|-------------------------------|-------------------------------------|
| Working rules for this repo   | `AGENTS.md`                         |
| Documentation rules           | `docs/documentation-rules.md`       |
| Product overview              | `docs/product-overview.md`          |
| Priorities, requirements, roadmap | `docs/development-plan.md`       |
| Technical architecture (incl. agent loop) | `docs/architecture.md`  |
| Internal implementation       | `docs/implementation.md`            |
| Memory: browsing & evaluation | `docs/companion-memory.md`           |
| Threat model & deployment trust model | `docs/architecture.md` §1, §8 |
| Ontology contract & governance | `docs/ontology.md`                 |
| Proactivity & motivation mechanism | `docs/companion-motivation.md`  |
| Feeding economy (food pantry & vitality) | `docs/companion-economy.md`        |
| Tool acquisition & use (MCP/CLI) | `docs/companion-tools.md`          |
| Prompt management & iteration | `docs/guide-prompts.md`             |
| Running evals (offline harness) | `docs/howto-run-evals.md`         |
| Online tracing / observability | `docs/runbook-tracing.md`          |
| Local dev setup               | `README.md`                         |


## Development Environment

> CobbleCompanion is a **mobile + web** personal-companion product (see `docs/product-overview.md`).
> The implementation stack below is **not yet decided** — entries marked _TBD_ are to be defined in
> `docs/architecture.md` and `docs/development-plan.md`. Do not infer a stack from older docs or code.

- **Surfaces (target platforms):** **mobile** (iOS + Android), **web**, and **desktop** (macOS/Windows/Linux). These are "living rooms" the one companion embodies in — **one at a time**, summoned by the user (see `docs/product-overview.md` §2). Web = portable/sandboxed; mobile = GPS/camera/health/notifications; desktop = files/local storage.
- **The companion (intelligence):** model + harness + knowledge base. Knowledge base = three long-term memories — **semantic, episodic, procedural** (`docs/product-overview.md` §2.1).
- **Data posture:** the companion's **canonical self lives in the cloud** (identity + long-term memory persist and sync there for continuity across rooms). **Raw on-device OS data can stay local** in the surface it came from and be reached via OS tools; *derived* knowledge syncs. Core data concerns: knowledge base, long-term memory, and the propose→approve **approval queue** (`docs/product-overview.md` §7).
- **OS as tools:** **mobile and desktop** surfaces wrap their OS access as functions/tools for the companion (permission-gated); the companion can also act as its own cross-room/cloud sync courier.
- **LLM:** agentic, **tool / skill / MCP**-using model loop (web-crawling and OS access are tools among many); provider-agnostic gateway, default **OpenRouter** (`docs/architecture.md` §5). Embeddings also via OpenRouter (`/embeddings`, default `perplexity/pplx-embed-v1-0.6b`) behind a provider-agnostic gateway — **all models come from OpenRouter**.
- **Stack (Phases 0–1):** **TypeScript end-to-end** — Node/**Fastify** API + **React/Vite** web client; **Postgres + `pgvector`** store (semantic memory: verbatim sections + vector/FTS hybrid retrieval + typed fact overlay per `docs/ontology.md`; ingestion flow `docs/architecture.md` §4.8). Canonical: `docs/architecture.md` §5. _Later phases evolve this doc incrementally._
- **App shell:** mobile + web + desktop clients over a cloud "home" backend; one active embodiment at a time. Phases 0–1 build the **web** surface only (`docs/development-plan.md` §3); core↔surface boundary is fixed (`docs/architecture.md` §2).

## When to Update Docs

- New component added → update the Component Map in `docs/architecture.md` §3 and the folder tree in §4.1
- API changed → update `docs/architecture.md`
- New feature → update `docs/product-overview.md` (and `docs/development-plan.md` if it changes scope/priorities) and relevant component docs
- Internal mechanism, data model, or config changed → update `docs/implementation.md`
- Dev setup changed → update `README.md`
- File structure changed → update `docs/architecture.md`
- Tests added → update test files and this section

