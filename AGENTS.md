# Agent Constitution 

## Iron Laws

Violation of any Iron Law requires immediate correction before proceeding.

1. **First principles first.** Before making any decision, proposing a solution, or asking the user a question, reason from first principles. Identify the fundamental constraints and goals, discard assumptions inherited from convention, and derive the answer from the ground up. Do not default to "how it's usually done" — justify every choice from root causes.
2. **Evidence before claims.** No completion claims without running verification and reading the full output. "Should work" is not evidence.
3. **No merge without tests.** Key functionality and critical code paths must have tests. Define acceptance criteria before implementing.
4. **Nothing hardcoded.** Secrets, credentials, absolute paths, infrastructure URLs: configuration, never source. Secrets in committed code = immediate revert. 
5. **Dont mock what you don't own** Mocking code you don't own brings several problems, such as harder to mantain tests, implementation details being leaked, can obscure test intent.
6. **No dead code.** Remove unused functions, classes, constants, variables, and modules. Code that is not used for any purpose must be deleted, not commented out or left "for later." This includes unused variables — do not leave assigned-but-never-read variables in the code.
7. **No tautological tests.** Every test must exercise real logic, a real function, or a real integration point. Tests that only assert the contents of a static data structure (e.g., verifying a dict literal has the keys you just typed) are not testing behavior — remove them. A test is valid only if a realistic bug could cause it to fail.
8. **Explicit types always.** All variables, function arguments, and return types must have explicit type annotations. No untyped declarations. This applies to function signatures, class attributes, and local variables where the type is not obvious from a literal assignment.
9. **Docstrings declare responsibility.** Every source file must begin with a docstring explaining what the file does, and every exported function, method, and class must have a docstring stating its single responsibility — what it is accountable for, not a restatement of its signature. The purpose is to force articulation of responsibility before writing the code; a unit whose responsibility cannot be stated in one sentence is doing too much and must be split. Private/internal helpers are exempt unless their behavior is non-obvious.

---

## Process

**For significant changes** (new approach, interface changes, cross-component impact):
```
plan → plan-review → implement → code-review → verify against DoD
```

**For obvious, scoped fixes** (single-file bug, typo, clear requirement):
```
implement → verify against DoD
```

What makes a change "significant": introduces new abstractions, changes contracts between components, spans more than 2-3 files in non-trivial ways, or could break existing behavior.

Additional process rules:
- Read existing code and conventions before writing new code
- YAGNI: do not build for requirements that do not exist yet
- One class or module, one responsibility
- If behavior changed, update the nearest relevant doc
- Commit messages describe intent, not mechanics
- When clarification is needed, ask **one question at a time**. Discuss and resolve it before raising the next. Do not present a list of questions for the user to answer in bulk.

---

## Agent Dispatch

Dispatch as subagents for isolated review. Each agent reads its prompt file and returns findings.

| Agent                  | When to invoke                                                 |
|------------------------|----------------------------------------------------------------|
| **Plan review**        | Before implementing any significant change (see Process above) |
| **Code review**        | After completing a feature or fix, before merge               |
| **Architecture audit** | After structural changes spanning multiple modules            |

When in doubt, run code-review. It is cheap and catches regressions.

## Completion Gate

Before claiming any work is done, verify:
- Ran verification. Output confirms pass — pasted, not paraphrased.
- Behavior matches stated goal and acceptance criteria.
- Tests added or updated. Bug fixes have regression tests.
- No secrets, no hardcoded values, no accidental file additions.
- Changes scoped to the task. No unrelated diffs.
- Docs affected by the change are updated.

---

## Repo-Specific Rules

### Documentation System

**Single-source rule**: each fact lives in exactly one document. Other documents link, never repeat. Violations create maintenance drift and confuse agents.

**Documentation taxonomy**: See `docs/documentation-rules.md` for the general rules on doc types (PRD, architecture, implementation, API, README), naming conventions, and cross-referencing.

**Project doc locations**: Core documentation lives in `docs/` (PRD, architecture, file structure, documentation rules). Inline docs live alongside the code they describe.

**File structure and ownership:**

| Location                       | Owns                                                                       | Must not contain                                         |
|--------------------------------|----------------------------------------------------------------------------|----------------------------------------------------------|
| `CLAUDE.md`                    | AI agent entry point — component map, canonical doc sources, key paths     | Narrative, duplicated content                            |
| `docs/product-overview.md`     | Product vision, features, user journeys — the what and why                 | Priorities, requirements, tech implementation details    |
| `docs/development-plan.md`     | Priorities, requirements, acceptance criteria, roadmap, open questions     | Product vision narrative, design rationale, schemas      |
| `docs/architecture.md`         | System architecture, data flows, arch decisions, folder structure          | Implementation details                                   |
| `docs/implementation.md`       | Data models, algorithms, internal code structure, configuration, security  | Product requirements, high-level architecture            |
| `docs/companion-memory.md`      | Guide to the memory mechanism; how to browse & evaluate memory             | Canonical data model/schema (lives in `implementation.md`) |
| `docs/companion-economy.md`    | Guide to the feeding economy; how a user spends their food pantry to feed (refill) a companion's vitality wallets | Canonical schema (`implementation.md` §1), tunable constants (`config.ts`, `contracts.ts`) |
| `docs/companion-tools.md`      | Guide to tool acquisition; acquiring whitelisted CLIs/MCP servers at runtime & the whitelist trust model | Canonical schema/DDL (`implementation.md` §1), scope/acceptance (`development-plan.md`), product vision (`product-overview.md`) |
| `docs/companion-motivation.md` | Guide to the proactivity/motivation mechanism (drives, presence arbitration, affect & change-as-reward reinforcement) | Canonical schema (`implementation.md` §1), scope/acceptance (`development-plan.md`), product vision (`product-overview.md`) |
| `docs/ontology.md`             | Ontology contract & governance (fixed types + rules for the dynamic part)  | Leaf-type catalog (that's data, lives in the database)   |
| `docs/guide-prompts.md`        | How-to for authoring, versioning & changing prompts (the code-as-truth registry) | Prompt data model (`implementation.md` §2.2), component placement (`architecture.md` §3) |
| `docs/howto-run-evals.md`      | How to run the offline eval harness (tiers, datasets, the prompt A/B knob) | What memory eval measures & why (`companion-memory.md` §5) |
| `docs/runbook-tracing.md`      | Operating & enabling online tracing (Langfuse) + privacy posture           | Tracing seam/data model (`architecture.md` §3, `implementation.md` §3), env vars (`.env.example`) |
| `docs/documentation-rules.md`  | Doc taxonomy rules (types, scopes, naming)                                 | Actual doc content                                       |
| `README.md`                    | Orientation, quick start, setup steps                                      | Architecture, cross-component concepts                   |

**Doc naming convention** (under `docs/`):
- `guide-<topic>.md` — how something works
- `howto-<task>.md` — how to do a specific task
- `runbook-<area>.md` — operate / incident response
- `adr-YYYYMMDD-<title>.md` — architectural decisions
- `api-<surface>.md` — API usage/contracts

**When to update docs:**
- New component added → update `CLAUDE.md` component map and `docs/architecture.md`
- API changed → update `docs/architecture.md`
- New feature → update `docs/product-overview.md` (and `docs/development-plan.md` if it changes scope/priorities) and relevant component docs
- Internal mechanism, data model, or config changed → update `docs/implementation.md`
- Dev setup changed → update `README.md`
- File structure changed → update `docs/architecture.md`
- Documentation taxonomy rules changed → update `docs/documentation-rules.md`

**Tables and diagrams** must be formatted with consistent column padding for readability.

---

### Testing

- Tests verify behavior through the public interface, not mock wiring.
- Bug fixes require a regression test that reproduces the original failure.

---

### Unit Testing Philosophy

**"Don't mock what you don't own"** — use fakes/in-memory implementations instead of mocking third-party SDKs.

---

### Code Quality

- Remove unused imports before committing.
- DRY: if logic appears twice, extract it. Near-duplicates differing only in a parameter must be parameterized.
- Separate orchestration (sequencing, coordination) from computation (pure functions, data transforms).
- Iron Laws 4-6 (no dead code, no tautological tests, explicit types) also apply here — see §Iron Laws above.
- Docstrings on files and exported units are mandatory — see Iron Law 9.

---

## References

| Resource                        | Path                            |
|---------------------------------|---------------------------------|
| AI agent context                | `CLAUDE.md`                     |
| Working rules for this repo     | `AGENTS.md`                     |
| Product overview                | `docs/product-overview.md`      |
| Priorities, requirements, roadmap | `docs/development-plan.md`     |
| Technical architecture (incl. agent loop) | `docs/architecture.md`|
| Internal implementation         | `docs/implementation.md`        |
| Memory: browsing & evaluation   | `docs/companion-memory.md`       |
| Feeding economy (food pantry & vitality) | `docs/companion-economy.md`    |
| Tool acquisition & use (MCP/CLI) | `docs/companion-tools.md`      |
| Proactivity & motivation        | `docs/companion-motivation.md`  |
| Ontology contract & governance  | `docs/ontology.md`              |
| Prompt management & iteration   | `docs/guide-prompts.md`         |
| Running evals (offline harness) | `docs/howto-run-evals.md`       |
| Online tracing / observability  | `docs/runbook-tracing.md`       |
| Documentation rules             | `docs/documentation-rules.md`   |
| Local dev setup                 | `README.md`                     |
