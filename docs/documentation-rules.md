# Documentation Knowledge Organization Rules

This document defines general rules for how documentation is organized — by type (granularity). For project-specific file ownership, paths, and update triggers, see `AGENTS.md` §Documentation System.

---

## Doc Types

| Type             | Suffix                          | Question it answers                                              | Litmus test                                                    |
|------------------|---------------------------------|------------------------------------------------------------------|----------------------------------------------------------------|
| Product Overview | `product-overview.md`           | What is the product and what value does it provide?              | Can a stakeholder understand the product's value without code? |
| Development Plan | `development-plan.md`           | What are we building, in what priority, and to what acceptance criteria? | Can a contributor tell what to build next and how to know it's done? |
| Architecture     | `-architecture.md`              | What is it? Components, responsibilities, interactions, flows    | Can a new engineer draw it on a whiteboard?                    |
| Implementation   | `-implementation.md`            | How does it work internally? Data models, algorithms, config     | Can a developer modify the system using only this doc?         |
| API              | `-api.md` or `-reference.md`    | How do I integrate with it? Endpoints, contracts, schemas        | Can another team build an integration from this alone?         |
| README           | `README.md`                     | How do I orient and get started?                                 | Can someone install, run, and verify in under 5 minutes?       |

> **Not exhaustive.** Domain-contract docs (e.g. this repo's `ontology.md`) sit
> outside this generic taxonomy and are owned per-repo — see `AGENTS.md`
> §Documentation System for what each project actually keeps.

---

### Product Overview

The **what and why**. Companion to the Development Plan, which carries the
scope, priorities, and acceptance criteria.

**Contains:**
- Product vision and purpose (1 paragraph)
- Feature catalog with descriptions
- Major user journeys with value propositions — how the user finds value in each flow
- Target platform and audience
- Glossary of product and domain terms
- Documentation index linking to all other docs

**Does NOT contain:** priorities, detailed requirements, acceptance criteria, roadmap (those live in the Development Plan); technical architecture, database schemas, implementation details, API schemas, code snippets.

### Development Plan

The **scope and priority**. Companion to the Product Overview, which carries
the what and why.

**Contains:**
- Prioritized requirements and scope (what's in, what's out, in what order)
- Acceptance criteria for each requirement
- Roadmap, gaps, and future directions
- Open questions and unresolved decisions (pointing to the architecture once resolved)

**Does NOT contain:** product vision and value narrative (Product Overview); design rationale and technology choices (Architecture); schemas and contracts (Implementation).

### Architecture

**Contains:**
- System/app/service purpose and responsibilities (1 paragraph)
- Component/module map (layers, what each owns) — as C4 Container & Component diagrams (see Diagrams as First-Class Citizens)
- Folder structure overview
- Data flow diagrams (sequence diagrams, state transitions)
- Interactions with external services (protocol, direction) — as a C4 Context diagram
- State management approach
- Design principles and decisions
- Non-goals and scope boundaries

**Does NOT contain:** database schemas, field-level models, algorithm pseudocode, code snippets beyond a signature, product requirements.

### Implementation

**Contains:**
- Data models / database schemas (tables, fields, types, indexes) — with an entity-relationship diagram (see Diagrams as First-Class Citizens)
- Algorithms and internal mechanisms — with sequence/state diagrams where flow or lifecycle matters
- Internal code structure (key files, module responsibilities)
- Configuration details (env vars, feature flags, tuning parameters)
- Error handling patterns
- Migration patterns and versioning
- Security implementation details

**Does NOT contain:** why the system exists, high-level component diagrams, product requirements, dev setup instructions.

### API

**Contains:**
- Service/endpoint catalog (method, path/RPC, description)
- Request/response schemas with field-level docs
- Auth requirements
- Error codes and response format
- Rate limits and quotas
- Example request/response pairs

**Does NOT contain:** how endpoints are implemented internally, database schemas, architecture rationale.

**Note:** Create API docs only when an API surface needs documentation for other developers or services.

### README

**Contains:**
- Purpose (1 paragraph — what this is and why it exists)
- Quick start (install, run, verify — under 5 minutes)
- Command reference table
- Links to deeper documentation

**Does NOT contain:** detailed data models, full architecture descriptions, environment variable tables, project structure trees, deployment guides. These belong in the appropriate doc type; README should link to them.

**Size guideline:** A README that exceeds ~100 lines is a sign that content should be extracted to dedicated docs.

---

## Diagrams as First-Class Citizens

Documentation here is **visual-first, not text-only**. A wall of prose that *describes* a structure, a flow, or a set of relationships is a defect when a diagram would convey it faster and more precisely. **Default to including a diagram for any non-trivial structure or behavior — do not wait to be asked.**

**The rule:** every Architecture and Implementation doc MUST carry at least one diagram. Whenever you describe components and how they interact, a sequence of steps, a state machine, or a data model, **lead with the diagram and let prose annotate it** — not the reverse.

### Format: Mermaid by default

- Author diagrams as **Mermaid** fenced code blocks (` ```mermaid `) embedded directly in the Markdown. They are diffable, reviewable in PRs, and render natively on GitHub — they live and version alongside the prose they explain.
- Do **not** commit binary image exports (PNG/JPEG) for anything Mermaid can express. They can't be diffed, they rot, and they silently drift from the code.
- Reserve raster/vector image files for screenshots, hand-drawn concepts, or visuals Mermaid genuinely cannot produce; store them under an `assets/` or `images/` folder beside the doc and link them in.

### System architecture — the C4 model

Describe systems at increasing zoom. Include the levels that carry meaning for the reader, not all four by rote:

- **Context** — the system as one box among its users and the external systems it talks to. (Product Overview, Architecture)
- **Container** — the major deployable/runtime units (web client, API, database, workers) and how they communicate. (Architecture)
- **Component** — the internal module breakdown of a single container. (Architecture / Implementation)
- **Code** — class/function-level structure. Generate on demand from the IDE rather than hand-maintaining it; usually omitted from docs.

### Behavioral & flow diagrams — how things move and change

- **Sequence diagrams** — request/response across components, the agent loop, message ordering.
- **State diagrams** — lifecycle and state transitions (e.g. the approval-queue states).
- **Flowcharts / activity diagrams** — decision logic and process flows.

### Static & relational diagrams — how things are structured

- **Entity-relationship diagrams (ERD)** — data models, tables, and their relationships.
- **Class / type diagrams** — type contracts and relationships where they clarify design.
- **Component-relationship diagrams** — module dependencies and ownership boundaries.

### Expected diagrams by doc type

| Doc type         | Expected diagrams                                                          |
|------------------|----------------------------------------------------------------------------|
| Product Overview | C4 Context; major user-journey flows                                       |
| Development Plan | Roadmap/phase timeline or dependency graph where sequencing is non-obvious |
| Architecture     | C4 Container & Component; sequence diagrams for key flows; state diagrams   |
| Implementation   | ERD for data models; sequence/state diagrams for algorithms and mechanisms |
| API              | Sequence diagrams for request/response and auth handshakes                 |
| README           | Optional high-level Context diagram if it speeds orientation               |

### Keep diagrams honest

1. **A diagram is documentation.** It falls under the same single-source-of-truth and update rules as prose — when the thing it depicts changes, update the diagram in the *same* change.
2. **One idea per diagram.** Prefer several small, focused diagrams over one that tries to show everything.
3. **Prose annotates, never duplicates.** Don't restate in a paragraph what the diagram already shows — point to it and add only what it can't express.

---

## Naming Convention

| Pattern                    | Use for                              | Examples                                   |
|----------------------------|--------------------------------------|--------------------------------------------|
| `<topic>.md`               | Core docs (product overview, architecture, etc.) | `product-overview.md`, `architecture.md`   |
| `<dir>/README.md`          | Inline docs within a directory       | `database/README.md`                       |
| `guide-<topic>.md`         | How something works                  | `guide-auth-flow.md`                       |
| `howto-<task>.md`          | How to do a specific task            | `howto-add-migration.md`                   |
| `runbook-<area>.md`        | Operate / incident response          | `runbook-deploy.md`                        |
| `adr-YYYYMMDD-<title>.md` | Architectural decisions              | `adr-20260101-drift-migration.md`          |
| `api-<surface>.md`         | API usage/contracts                  | `api-sync-service.md`                      |

Use `-reference.md` instead of `-api.md` when the name already contains "api" (avoids `foo-api-api.md`).

---

## When to Create vs Skip a Doc Type

Create only when there is meaningful content for that type. Do not create empty shells.

**Thresholds:**
- **Product Overview:** always exists — source of truth for features and user journeys
- **Development Plan:** exists once there are prioritized requirements or acceptance criteria to track
- **Architecture:** create when 2+ distinct layers/modules or meaningful design decisions exist
- **Implementation:** create when data models, algorithms, or mechanisms go beyond code comments
- **API:** create when an API surface is consumed by other services or external clients
- **README:** always exists — every project has one

---

## Cross-Referencing Rules

1. **Link, never copy.** If a fact is owned by another doc, use a relative-path link.
2. **Every doc states its scope in the opening paragraph** with "For X, see [other-doc]" pointers.
3. **Sibling docs cross-reference each other** in their opening paragraph.
4. **README is the entry point.** It links to deeper docs for detail.
5. **Agent context file updated** whenever a doc is created, renamed, split, or deleted.

---

## Table Formatting

1. **Wrap long cell text.** If a table cell's content makes the row hard to read or forces excessive horizontal scrolling, split it across multiple lines within the same cell. Every cell in a Markdown table should remain scannable without side-scrolling.
