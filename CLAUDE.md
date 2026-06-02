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
| Threat model & deployment trust model | `docs/architecture.md` §1, §10 |
| Ontology contract & governance | `docs/ontology.md`                 |
| Local dev setup               | `README.md`                         |


## Development Environment

> CobbleCompanion is a **mobile + web** personal-companion product (see `docs/product-overview.md`).
> The implementation stack below is **not yet decided** — entries marked _TBD_ are to be defined in
> `docs/architecture.md` and `docs/development-plan.md`. Do not infer a stack from older docs or code.

- **Surfaces (target platforms):** **mobile** (iOS + Android), **web**, and **desktop** (macOS/Windows/Linux). These are "living rooms" the one companion embodies in — **one at a time**, summoned by the user (see `docs/product-overview.md` §2). Web = portable/sandboxed; mobile = GPS/camera/health/notifications; desktop = files/local storage.
- **The companion (intelligence):** model + harness + knowledge base. Knowledge base = three long-term memories — **semantic, episodic, procedural** (`docs/product-overview.md` §2.1).
- **Data posture:** the companion's **canonical self lives in the cloud** (identity + long-term memory persist and sync there for continuity across rooms). **Raw on-device OS data can stay local** in the surface it came from and be reached via OS tools; *derived* knowledge syncs. Core data concerns: knowledge base, long-term memory, and the propose→approve **approval queue** (`docs/product-overview.md` §7).
- **OS as tools:** **mobile and desktop** surfaces wrap their OS access as functions/tools for the companion (permission-gated); the companion can also act as its own cross-room/cloud sync courier.
- **LLM:** agentic, **tool / skill / MCP**-using model loop (web-crawling and OS access are tools among many); provider/gateway _TBD_ → `docs/architecture.md`.
- **Stack / frameworks / store engine:** _TBD_ → `docs/architecture.md`, `docs/development-plan.md`.
- **App shell:** mobile + web + desktop clients over a cloud "home" backend; one active embodiment at a time. Concrete client/server architecture _TBD_ → `docs/architecture.md`.

## When to Update Docs

- New component added → update the Component Map in `docs/architecture.md` §3 and the folder tree in §4.1
- API changed → update `docs/architecture.md`
- New feature → update `docs/product-overview.md` (and `docs/development-plan.md` if it changes scope/priorities) and relevant component docs
- Internal mechanism, data model, or config changed → update `docs/implementation.md`
- Dev setup changed → update `README.md`
- File structure changed → update `docs/architecture.md`
- Tests added → update test files and this section

