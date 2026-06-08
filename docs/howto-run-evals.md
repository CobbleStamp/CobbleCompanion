# How to run evals

> **Canonical source** for running the offline eval harness. What memory eval
> measures and why lives in `companion-memory.md` §5; the scorer/dataset/runner
> data model and the prompt A/B mechanism are summarized here.

The eval harness (`packages/eval`) is **offline** — never on the serving path —
and runs against **real OpenRouter**. It has two tiers, deliberately split by
cost and determinism.

## Deterministic tier — gates every PR

Pure scorers + the runner exercised with `FakeLlmGateway` (no network, no live
model). These run under the normal test suite and count toward the ≥80% coverage
gate, so they protect the framework and the prompt registry on every PR:

```bash
pnpm --filter @cobble/eval test      # framework.test.ts + score.test.ts
pnpm --filter @cobble/core test src/prompts   # prompt render/registry/version
```

CI runs these via `pnpm run test:coverage` (`.github/workflows/ci.yml`). The main
CI job **never** calls a live model.

## Live tier — nightly / on demand

Hits real OpenRouter; costs tokens and varies run to run. Requires
`OPENROUTER_API_KEY`.

```bash
pnpm eval                        # memory-recall (the stateful multi-config eval)
pnpm eval --dataset=affect-sense # stateless: does it read the mood SIGN right?
pnpm eval --dataset=injection    # security: can a user dictate their own valence?
pnpm eval --dataset=user-extract # stateless: does it capture the right user-facts?
pnpm eval --dataset=all          # everything
```

Env knobs: `LLM_MODEL`, `INGESTION_MODEL`, `EMBEDDING_MODEL`, `EVAL_WINDOWS`,
`EVAL_SEMANTIC`, `EVAL_EPISODIC` (memory-recall axes); `EVAL_REPORT_DIR` writes
each stateless dataset's machine-readable `DatasetReport` JSON for baselining.

CI runs this nightly (and via **Run workflow**) in `.github/workflows/eval-nightly.yml`,
gated on the `OPENROUTER_API_KEY` secret, and uploads the reports as an artifact.

## Datasets

| Dataset         | Kind                                         | Call site            | Scorer                            |
| --------------- | -------------------------------------------- | -------------------- | --------------------------------- |
| `memory-recall` | stateful (seed → ingest → consolidate → ask) | full `Harness`       | facts (deterministic) + LLM judge |
| `affect-sense`  | stateless                                    | `senseAffect`        | valence-sign match                |
| `injection`     | stateless (red-team)                         | `senseAffect`        | dictated-valence resisted         |
| `user-extract`  | stateless                                    | the user-fact extractor | facts (explicit attributes, deterministic) + LLM judge (preferences) |

`user-extract` is the quality gate for **User-Model** extraction (`companion-memory.md` §4,
`ontology.md` §5): each case is an exchange with the user-facts a correct read should capture —
explicit identity attributes scored deterministically (the `facts` scorer), fuzzier
preferences/interests scored by LLM judge. It is what lets the extraction prompt be iterated without
silently losing facts or inventing preferences.

The stateless framework (`framework/`: `dataset`, `scorer`, `runner`, `baseline`,
plus `scorers/{facts,refusal}`) makes adding a per-call-site dataset small:
declare cases, a `run` that calls into core against `runtime.gateway`, and a
scorer. **Follow-ups** (same pattern): `segmenter`, `consolidation`, `persona-evolve`.

## Baselines & regression

LLM outputs are nondeterministic, so a regression is a drop beyond a **tolerance
band**, not an inequality. `framework/baseline.ts` (`compareToBaseline`) is a
**manual/offline utility** for this: given two `DatasetReport`s it flags the
pass-rate and mean-metric drops that exceed the tolerance.

> **Not yet automated.** The nightly tier (`eval-nightly.yml`) only *writes* the
> machine-readable `DatasetReport` JSON (when `EVAL_REPORT_DIR` is set) and
> uploads it as an artifact. It does **not** load a committed baseline, call
> `compareToBaseline`, or fail on a score regression — so the nightly catches
> hard errors (a thrown eval fails the job) but **not** gradual quality/safety
> drift. To compare runs today, download two artifacts and diff them yourself
> (or call `compareToBaseline` from a script). Wiring this into the nightly as a
> gate is tracked follow-up work.

The existing human-readable `docs/eval/*.txt` memory-recall baselines remain.

## A/B-ing a prompt version

Prompts are code-as-truth (`guide-prompts.md`), so the cleanest A/B is **git**:
run a dataset on two branches/worktrees (old vs new wording) and diff the reports.
Every LLM call is stamped with its `promptRef` (id + semver + content hash), so a
report is unambiguously attributable to the prompt version that produced it.
