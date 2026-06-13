# Documentation Knowledge Organization Rules

This document defines general rules for how documentation is organized — by type (granularity). For project-specific file ownership, paths, and update triggers, see `AGENTS.md` §Documentation System.

---

## Doc Types

| Type             | Suffix                          | Question it answers                                              | Litmus test                                                    | When to create                                  |
|------------------|---------------------------------|------------------------------------------------------------------|----------------------------------------------------------------|-------------------------------------------------|
| Product Overview | `product-overview.md`           | What is the product and what value does it provide?              | Can a stakeholder understand the product's value without code? | Always                                          |
| Development Plan | `development-plan.md`           | What are we building, in what priority, and to what acceptance criteria? | Can a contributor tell what to build next and how to know it's done? | When prioritized requirements / acceptance criteria exist |
| Architecture     | `-architecture.md`              | What is it? Components, responsibilities, interactions, flows    | Can a new engineer draw it on a whiteboard?                    | When 2+ layers/modules or design decisions exist |
| Implementation   | `-implementation.md`            | How does it work internally? Data models, algorithms, config     | Can a developer modify the system using only this doc?         | When models/algorithms exceed code comments     |
| API              | `-api.md` or `-reference.md`    | How do I integrate with it? Endpoints, contracts, schemas        | Can another team build an integration from this alone?         | When consumed by other services / external clients |
| README           | `README.md`                     | How do I orient and get started?                                 | Can someone install, run, and verify in under 5 minutes?       | Always                                          |

> Create a doc only when there is meaningful content for its type — do not create empty shells.

> **Not exhaustive.** Domain-contract docs (e.g. this repo's `ontology.md`) sit
> outside this generic taxonomy and are owned per-repo — see `AGENTS.md`
> §Documentation System for what each project actually keeps.

---

### Product Overview

**Contains:**
- Product vision and purpose (1 paragraph)
- Feature catalog with descriptions
- Major user journeys with value propositions — how the user finds value in each flow
- Target platform and audience
- Glossary of product and domain terms
- Documentation index linking to all other docs

**Does NOT contain:** priorities, detailed requirements, acceptance criteria, roadmap (those live in the Development Plan); technical architecture, database schemas, implementation details, API schemas, code snippets.

### Development Plan

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

Documentation here is **visual-first**. When a structure, flow, or set of relationships would read faster as a picture, the picture is mandatory, not optional: **every Architecture and Implementation doc MUST carry at least one diagram**, and the diagram leads while prose annotates — never the reverse.

**Format — Mermaid by default.** Author diagrams as **Mermaid** fenced blocks (` ```mermaid `) embedded in the Markdown, so they are diffable, PR-reviewable, GitHub-rendered, and versioned beside the prose. Don't commit PNG/JPEG for anything Mermaid can express; reserve image files (in an `assets/` folder beside the doc) for screenshots or visuals Mermaid genuinely can't produce.

**Diagram types:**
- **C4 (architecture, by zoom):** *Context* (the system among its users and external systems) → *Container* (deployable/runtime units and how they communicate) → *Component* (a container's internal modules). Include the levels that carry meaning; the *Code* level is generated on demand from the IDE, not hand-kept.
- **Behavioral:** sequence (request/response, the agent loop), state (lifecycles, e.g. approval-queue states), flowchart (decision logic).
- **Relational:** ERD (data models and their relationships), plus class/type and component-dependency diagrams where they clarify design.

**Match altitude to the message.** A diagram exists to teach one thing — decide what the reader should learn, pick the zoom level that teaches it, and resist showing more. Detail is not clarity; internals that don't serve the diagram's point are noise.

- **High-level views show modules, not their guts.** At the Context/Container altitude the question is "what are the big modules, and how do they depend on each other?" Draw each module as one opaque box and let the *edges* carry the story — direction of dependency, coupling, cohesion. Do not crack the boxes open here.
- **Zoom in only when the question changes.** To explain how *one* module works, draw a separate Component diagram for that single container, expand its internals, and keep every sibling and neighbor as an opaque box. One diagram = one altitude — never show one fully-exploded module beside untouched peers.

**Show containment, don't flatten it.** When a module contains sub-components, the picture must make "A is inside B" visually unambiguous. Never draw a container and its own components as sibling nodes at the same level — that is the most common way these diagrams mislead.

- In **C4 diagrams**, use the boundary constructs — `System_Boundary` / `Container_Boundary` / `Component_Boundary` — to wrap children so containment is explicit.
- In **flowcharts**, wrap a container's internals in a `subgraph` named for the container; the enclosing box *is* the "belongs to" relationship. Edges between modules connect at the boundary — they do not reach into a sibling's internals.
- Label the boundary with the container's name and each child with its role, so a reader can read the whole and its parts in one glance.

Which diagrams belong in which doc is listed in each type's **Contains** above. Keep each diagram to one idea, let prose annotate rather than restate it, and update it in the same change as the thing it depicts.

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

## Cross-Referencing Rules

1. **Link, never copy.** If a fact is owned by another doc, use a relative-path link.
2. **Every doc states its scope in the opening paragraph** with "For X, see [other-doc]" pointers.
3. **Sibling docs cross-reference each other** in their opening paragraph.
4. **README is the entry point.** It links to deeper docs for detail.
5. **Agent context file updated** whenever a doc is created, renamed, split, or deleted.

---

## Table Formatting

1. **Wrap long cell text.** If a table cell's content makes the row hard to read or forces excessive horizontal scrolling, split it across multiple lines within the same cell. Every cell in a Markdown table should remain scannable without side-scrolling.
