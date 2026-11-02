# RFC 0003 — Keep the harness upgradable: pinned models, conformance, replay evals and staged rollout

- **Author:** Higor Alves
- **Status:** Accepted (2026-11-02)
- **Created:** 2026-11-02
- **Discussion:** (open a PR with this file)
- **Related:** [RFC 0002](./0002-native-agent-runtimes.md) (the runtimes this keeps healthy)

## Summary

Models, SDKs and providers change under the harness every few weeks. Today nothing in Luna notices: a pack says `"opus"`, so an SDK bump can change the model behind every stage without anyone deciding to, and there is no way to tell whether a new model plans or reviews better or worse than the old one. This RFC adds the scaffolding that makes an upgrade a routine, reviewed change: a model catalog with pinned IDs behind engine aliases, a conformance table every runtime must pass, replay evals built from real runs, staged rollout of an engine on a pack, fallback across engines, one event stream, a fingerprint on every run, policy as data, versioned contracts, kill switches and budgets. It ends with the playbook for a new model.

Most of it is useful with Claude alone and can land before [RFC 0002](./0002-native-agent-runtimes.md)'s other runtimes.

## Goals

- A new model version is a one-line change in one file, gated by evidence.
- A model change never happens as a side effect of a dependency bump.
- Any runtime, new or upgraded, proves the same behaviour against the same scenarios before it runs a stage.
- "Did triage get worse?" has an answer from data, per pack and per engine.
- A bad engine is rolled back with one revert, and a rate-limited one does not stall the pipeline.

## Non-goals

- Running evals in CI. They need a model credential, so they run locally, like `golden:live`.
- A hosted eval or observability service. Everything stays in this repo and the machine's Postgres.
- Choosing which packs move to which engine. This RFC provides the evidence; the choice is per pack.

## Background / Context

- `contracts/src/packs.ts` stores `model: "opus" | "sonnet" | "haiku"`, aliases the Claude Agent SDK resolves itself. The pinned SDK version (`factory/package.json`) is today the only thing deciding which Claude model runs.
- Every run already leaves its input (`/in/stage.json`) and its answer (`/out/result.json`, `events.jsonl`) under the machine's state dir. That is an eval corpus nobody reads back.
- `StageOutput` carries `schema: 3`; `StageInput` has no version.
- A rate-limited stage parks the task in `paused_rate_limit` until the reset time, even when another engine could answer.
- `PIPELINE.md` already holds a monthly budget per repo.

## Proposed design

### 1. Model catalog behind engine aliases

```ts
// contracts/src/models.ts: the only file that names a model ID
export const MODELS = {
  "anthropic/opus-5.5": {
    runtime: "claude", id: "claude-opus-5-5", status: "ga",
    caps: { tools: true, structured: true, effort: ["low", "medium", "high"] },
  },
  "openai/gpt-6-sol": { runtime: "eve", id: "gpt-6-sol", status: "ga", caps: { ... } },
  "typesafe/jev":     { runtime: "jev", id: "jev-latest", status: "preview" },
  // status: "preview" | "ga" | "deprecated"; deprecated entries carry retireAfter: "YYYY-MM-DD"
} as const satisfies Record<string, ModelEntry>;
```

Packs name engines (`claude:opus`), engines name catalog keys, catalog keys name exact model IDs. A contract test fails when a pack's engine does not exist, when its model cannot serve the pack (Jev cannot run an agent pack; a model without structured output cannot run any), when the effort asked for is unsupported, or when anything references a model past its `retireAfter`.

### 2. One runtime interface, conformance-tested

`factory/src/runtimes/conformance/` holds one scenario table. Each runtime ships a fake transport (a scripted `query()` for Claude, eve's `mockModel` for eve, canned answers for Jev) and must pass every row:

| Scenario | Expected |
|---|---|
| Structured answer | `structured` set, `ok: true` |
| Answer as JSON text | accepted when it parses against the pack's schema |
| Answer off-schema | `ok: false`, the zod issue in `error` |
| Rate limit | `rateLimited: true`, `resetsAt` when the SDK gives one |
| Guard denial | the call is refused and the run continues |
| Timeout | `ok: false`, no partial `result.json` |
| Ledger tool call | `/out/ledger.json` updated |
| Delegate | the child's answer returned, its usage counted |

A new runtime, or a major SDK bump, is done when the table passes.

### 3. Replay evals from real runs

```
evals/                          # @hardness/evals
  <pack>/cases/<id>/stage.json  # a recorded StageInput, scrubbed, plus its worktree ref
  <pack>/cases/<id>/expect.json # what a good answer must contain
  <pack>/graders.ts             # schema first, deterministic checks second, a Claude judge last
  baselines/<engine>/<pack>.json
  run.ts
```

```sh
pnpm eval --pack triage --engine codex:sol --against claude:opus
```

The scorecard reports pass rate, turns, duration and cost per pack and engine, and the diff against the baseline. Cases start from `triage`, `slack_triage` and `reviewing`, picked from tasks whose outcome is known (approved plan, merged PR, a review the author accepted).

### 4. Rollout states

An engine on a pack moves `candidate → shadow → canary → default → retired`, declared next to the pack's engines:

```ts
engines: {
  default: "claude:opus",
  allowed: ["claude:opus", "codex:sol"],
  rollout: { "codex:sol": { state: "shadow" } },   // or { state: "canary", share: 0.2 }
}
```

Shadow runs the same input on the candidate and stores its answer without acting on it. Canary picks tasks by a stable hash of the task id, so a task never changes engine mid-pipeline. `engine-choice.ts` stays a pure function. Rollback is reverting that line.

### 5. Fallback across engines

```ts
engines: { default: "claude:opus", allowed: [...], fallback: ["codex:sol"] }
```

On a rate limit the machine retries the stage on the next fallback engine and records which one answered. `paused_rate_limit` happens only when the list is exhausted.

### 6. One event stream

Each runtime translates its SDK's stream into one `RunEvent` union in `contracts/src/events.ts` (`text`, `tool_call`, `tool_result`, `step`, `usage`, `rate_limit`). The transcript the board's watch pane follows, `events.jsonl` and usage accounting read only that. An SDK changing its message shape breaks one translator.

### 7. A fingerprint on every run

The run record stores engine, exact model ID, runtime and SDK version, and a hash over template + role + addendum + skills + access (`factory/src/core/fingerprint.ts`). A change in quality becomes a diff between two fingerprints; `/metrics?groupBy=engine` and `groupBy=fingerprint` compare them.

### 8. Policy as data, enforced twice

`access` is declared per pack and checked by `core/guards.ts` in every runtime, on top of the container's read-only mounts. Every allowed and denied call lands in `events.jsonl` as an audit trail.

### 9. Versioned contracts and import boundaries

`StageInput` gets a `schema` number like `StageOutput`. Runtimes import only `@hardness/contracts` and `factory/src/core/`. A lint rule keeps each SDK inside its runtime folder and model IDs inside `models.ts`.

### 10. Kill switches and budgets

`LUNA_DISABLE_RUNTIME=eve` (or `jev`) sends every pack to its Claude default. A monthly cap per engine sits beside the per-repo budget in `PIPELINE.md`; Jev, the only metered engine, is tracked in dollars.

### Dependency hygiene

- Exact versions for `@anthropic-ai/claude-agent-sdk` (already exact), `eve`, `@typesafe-ai/sdk`, and the Codex CLI in `machine/runner/Dockerfile`. No carets on a runtime SDK.
- Dependency updates grouped per runtime, so an eve bump never rides along with a Claude SDK bump.
- An SDK or model upgrade PR carries its conformance result and an eval scorecard in the body. The runner image key already covers the lockfile, so the image rebuilds with it.

### Model upgrade playbook

The same steps for a new Claude, OpenAI or Jev model. It becomes `docs/runbooks/upgrade-a-model.md` once the pieces above exist.

1. **Catalog.** Add the model to `models.ts` as `preview` with a candidate engine (`claude:opus-next`). The contract test rejects it on packs it cannot serve.
2. **Conformance.** If the SDK moved too, bump it alone first and run the table.
3. **Replay.** `pnpm eval --engine claude:opus-next --against claude:opus` over every pack using that alias.
4. **Shadow** on those packs for a few days of real tasks.
5. **Canary** on a share of tasks or one repo.
6. **Promote.** Point `claude:opus` at the new catalog entry. Packs are untouched.
7. **Retire.** Mark the old entry `deprecated` with a `retireAfter`; the contract test fails if anything still uses it after that date.

Two more runbooks follow the same shape: `add-a-runtime.md` (implement `Runtime`, pass conformance, add its credential loader, add it to `runtimes/index.ts`) and `retire-an-engine.md`.

### Migration / rollout

1. **Pin and catalog** (fits with RFC 0002 phase 2): `models.ts`, full Claude model IDs instead of aliases, the catalog contract test. No behaviour change beyond the model no longer drifting.
2. **Events and fingerprint:** `RunEvent`, the transcript translator, fingerprint and model ID in the run record.
3. **Conformance** with the Claude fake.
4. **Evals:** the package, cases for three packs, baselines on today's engines. Exit: `pnpm eval --pack triage --engine claude:opus` reproduces a stored baseline.
5. **Rollout, fallback, metrics by engine, kill switch, budgets** once a second engine exists.
6. **Runbooks** written as each piece lands.

## Alternatives considered

### Keep model aliases

Less to maintain. Rejected: a dependency bump silently changes every stage's model, and two runs of the same pack cannot be compared when the model behind them is unknown.

### A hosted eval and tracing service

Richer dashboards. Rejected for now: it sends ticket and code text to a third party, and the machine already stores every run.

### Feature flags instead of rollout states

A flag per pack and engine. Rejected: flags say on or off; shadow and canary are what produce the evidence for turning something on.

## Open questions

- Shadow cost: shadowing every task doubles model use on that pack; is a sampled shadow enough?

### Settled (2026-11-02)

- Eval cases live in this repo under `evals/`, scrubbed of names, tokens and any message text a grader does not need.
- A fixed Claude engine judges (`claude:opus`, pinned in the catalog like any other), after the schema and deterministic checks.

## Risks & unknowns

- Curated cases drift from real work; refresh them from recent runs on a schedule.
- A judge model has its own bias; deterministic checks and schema validity carry most of the weight.
- Pinning means upgrades only happen when someone runs the playbook; the `retireAfter` test is what forces it.

## Success criteria

- Bumping `@anthropic-ai/claude-agent-sdk` changes no stage's model.
- A new model reaches `default` on a pack with a scorecard and a shadow period on record.
- Every run record names its exact model, SDK version and fingerprint.
- A rate limit on one engine moves the stage to its fallback instead of pausing the task.
