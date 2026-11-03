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

## Implementation notes (2026-11-03)

Built: §1 (catalog), §2 (conformance), §3 (evals), §5 (fallback across engines), §6 (`RunEvent`), §7 (fingerprint), §8, §10 (kill switch and per-engine budgets), metrics by engine and by fingerprint, and parts of §9. Not started: §4 rollout states, and two of the three runbooks. Where the build differs:

- **§1 Catalog.** `contracts/src/models.ts` and `contracts/src/engines.test.ts` as proposed, plus a check that no source file under `contracts/src`, `factory/src` or `machine/src` other than `models.ts` names a model ID. Effort is not on the engine: it stays on the pack, checked against the model's `caps.effort`. `codex:sol` points at `openai/gpt-5.6-terra` (`gpt-6-sol` is API-only on a ChatGPT login); Jev's catalog ID is `jev-latest`, TypeSafe's own alias, so it is the one model that is not pinned.
- **§2 Conformance.** `factory/src/runtimes/conformance/` runs one table against each runtime's fake (Jev the rows a runtime without tools or text answers can play); it runs in `pnpm --filter @hardness/factory test`. Beyond the rows above it checks a model error, shell syntax refused and a path outside the run's roots refused. There is no delegate row, since there is no `delegate` ([RFC 0002](./0002-native-agent-runtimes.md) phase 7).
- **§3 Evals.** `evals/` and `pnpm eval` as proposed (`--pack`, `--engine`, `--against`, `--case`, `--no-judge`, `--save-baseline`), each case run in the stage image through the machine's `runPackOnce`. The graders are shared (`evals/src/`), not one `graders.ts` per pack; a case is `stage.json` plus `expect.json` (outcome, deterministic checks, a rubric). The judge is the `eval_judge` pack, fixed on `claude:opus`; it runs only from the evals runner, never through `POST /runs`. The cases are not recorded runs: three synthetic Slack batches, three triage tickets over the golden fixtures, and three synthetic issues for `issue_classify` instead of `reviewing`. Baselines exist for `slack_triage` only (`claude-haiku`, `codex-luna`).
- **§4 Rollout states.** Not started. Instead: an engine is tried by adding it to a pack's `allowed` and picking it per repo (`luna.yaml` `engines:`) or per task (`stages`); a pick whose credential is missing, whose runtime is turned off or which is at its monthly cap runs the pack's default with a note on the task.
- **§5 Fallback.** As proposed: `engines.fallback` is an ordered list, each one of `allowed` (contract test). A usage limit latches the credential whose window it hit (`claude`, `codex`, `openai`, `typesafe`; `GET /health`'s `slots.latched`), as before, and the stage runs again at once, as a new attempt, on the first fallback that has not run it this time, whose credential is present (and neither disabled nor at its cap) and whose window is not latched; a `stage.engine` event on that run says `fallback after <engine> rate limit`, and the task pauses only when the list is exhausted. One list serves both directions, the engine that just hit its limit being skipped: `triage` falls back between `claude:opus` and `codex:sol`, `slack_triage` and `chat_triage` between `claude:haiku` and `codex:luna`; the Claude-only packs have none. `POST /runs` does the same within a call before its 429. The Slack inbox's own loop still runs `slack_triage` on its default only, so its behaviour on a limit is unchanged. A restart relatches every window a paused chain hit.
- **§6 `RunEvent`.** As proposed, plus `session` (the run's start line), `note`, the luna ledger's events and `child`, typed for `delegate` but emitted by nothing yet. Every line is `{ kind, payload }`, the shape `events.jsonl` already had. Runtimes emit through `RunContext.emit`; `core/transcript.ts` prints today's transcript lines from the events (a golden run per runtime in the conformance tests pins them), and `rate_limit` is emitted once by `main.ts` from the settled run. A Claude `tool_result` carries no error text, so the Claude transcript still shows no `✗` line. The machine keeps the stream kinds in the file and off the task's log. Usage accounting still reads `result.json`.
- **§7 Fingerprint.** `result.json`'s `run` names the runtime, engine, pinned model ID, the SDK and its installed version, and a sha256 over the template, the role as the runtime sends it (helpers and addendum), the skills' files, the access, the answer schema and the factory rules; a decision pack's questions stand in for its template. `stage_runs`, `pack_runs` and `slack_triage_runs` store `runtime`, `model_id`, `sdk_version` and `fingerprint`; `GET /tasks/:id` shows them per stage run and `GET /metrics?groupBy=fingerprint` compares them. `GET /metrics?groupBy=engine` groups `stage_runs.engine` beside it: per engine, stage runs, first-pass rate, escalations, runs ended on a usage limit, mean turns, mean duration and cost.
- **§8 Policy as data.** `access` is declared per pack in runtime-neutral words (`contracts/src/access.ts`) and enforced by `factory/src/core/guards.ts` in both agent runtimes on top of the container's mounts. Every guard decision, allowed or denied with its reason, is a `tool_call` event in `/out/events.jsonl`.
- **§9 Contracts and boundaries.** `StageInput` and `StageOutput` both carry `schema` (3). No lint rule keeps an SDK inside its runtime folder; that holds by review.
- **§10 Kill switch and budgets.** The switch is `MACHINE_DISABLE_RUNTIMES` (a comma list, `eve` and/or `jev`, read at boot), named like the machine's other variables; `claude` is refused at boot rather than sending packs anywhere, since every default runs on it. An engine on a disabled runtime is unavailable like one without a credential: a pick of it runs the default with a note, no fallback goes to it, `GET /engines` says `disabled by MACHINE_DISABLE_RUNTIMES`, `POST /runs` answers 409 `runtime_disabled`. The caps are not in `PIPELINE.md` but `MACHINE_ENGINE_BUDGETS` (`codex=0,openai=20,jev=5`: per engine or per credential) and a repo's luna.yaml `budget.engines`, over the calendar month's recorded cost (stage runs, `POST /runs` calls, Slack triage runs; a repo's cap its own stage runs; Jira intake keeps no run record). Every metered engine is tracked in dollars, not only Jev; Codex records no cost, so a `codex` cap never trips, and Claude cannot be capped. At 80, 90 and 100% a `budget.alert` names the cap (`scope: "engine"`); at 100% the engine is unavailable like a missing credential (`POST /runs`: 409 `budget`), and `GET /engines` shows `spentThisMonthUsd` and `budgetUsd`. The daily ceiling (`MACHINE_DAILY_BUDGET_USD`) still counts stage runs and `POST /runs` calls alike.
- **Dependency hygiene.** Runtime SDKs are pinned exactly (`@anthropic-ai/claude-agent-sdk`, `eve`, `@typesafe-ai/sdk`, the Codex CLI's `CODEX_VERSION`); there is no automated dependency grouping. `docs/contributing.md` asks an engine, model or SDK change for a scorecard and the conformance table.
- **Runbooks.** [`docs/runbooks/upgrade-a-model.md`](../runbooks/upgrade-a-model.md) is the playbook as it can be followed without shadow and canary. `add-a-runtime.md` and `retire-an-engine.md` are not written.
