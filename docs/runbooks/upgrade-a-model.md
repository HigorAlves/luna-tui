# Upgrade a model

[RFC 0003](../rfcs/0003-upgradable-harness.md)'s playbook as it can be followed today. The same steps for a Claude, OpenAI or Jev model. What RFC 0003 calls shadow and canary is not built yet; step 5 says what to do instead.

Everything here runs on your machine: evals and live runs need a model credential, so none of it runs in CI.

## 1. Catalog entry

Add the model to `contracts/src/models.ts`, the only source file that holds a model ID: a new key (`anthropic/opus-5.6`) with its `runtime`, the exact `id` the vendor SDK takes (never an alias), `status: "preview"` and its `caps` (tools, structured output, the efforts it supports). Then add a candidate engine for it in `contracts/src/engines.ts` (`"claude:opus-next": { model: "anthropic/opus-5.6" }`; a `codex:*` or `openai:*` engine also names its `auth`). No pack names the candidate yet.

For a `codex:*` engine, check the model is served on a ChatGPT login at all: `gpt-6-sol` is API-only there, which is why `codex:sol` runs `gpt-5.6-terra`. Jev's entry is `jev-latest`, TypeSafe's own alias: it can change under the harness, and the only check is the `triage_signals` cases (step 4).

## 2. Contract test

```sh
pnpm --filter @hardness/contracts test
```

`contracts/src/engines.test.ts` fails when an engine names a model that is not in the catalog, when a pack's engine cannot serve it (an agent pack needs tools and structured output, and the pack's effort among the model's), when anything references a retired model, and when any source file under `contracts/src`, `factory/src` or `machine/src` other than `models.ts` names a model ID. Its "keeps today's models as the defaults" case fails on purpose if a pack's default engine changes.

## 3. The SDK, if it has to move

If the new model needs a newer runtime SDK (`@anthropic-ai/claude-agent-sdk`, `eve`, `@typesafe-ai/sdk`, or the Codex CLI's `CODEX_VERSION` in `machine/runner/Dockerfile`), bump that alone first, as its own PR, to an exact version:

```sh
pnpm --filter @hardness/factory test                      # the conformance table, on each runtime's fake
pnpm --filter @hardness/machine runner:build              # the stage image, with the new SDK
pnpm --filter @hardness/machine smoke:sandbox             # evidence and a dry-run implementing pack in the hardened container
```

The conformance table (`factory/src/runtimes/conformance/table.ts`) is the bar: every runtime runs the same scenarios against a fake of its own transport. That PR changes no model.

## 4. Replay

Build the stage image from your branch (the evals run in it), then run the cases of every pack that uses the engine being replaced, the candidate against today's engine:

```sh
pnpm --filter @hardness/machine runner:build
pnpm eval --pack triage --engine claude:opus-next --against claude:opus
```

An engine outside a pack's `allowed` runs as a candidate, so the pack needs no change for this. The scorecard (pass rate, judge score, turns, duration, cost) goes in the PR description. Keep a laptop awake for the run (`caffeinate -s` on macOS).

Only `triage`, `slack_triage` and `triage_signals` have cases (`evals/<pack>/cases/`). For any other pack the alias touches, either add cases first ([evals/README.md](../../evals/README.md), "Add a case") or run the golden tickets on a branch that already points the alias at the new entry (step 6) and compare with the same run on `main`:

```sh
pnpm golden --matrix       # needs a running machine from that branch, a credential and docker
```

## 5. Try it on real tasks (instead of shadow and canary)

Shadow (the candidate answering the same input without being acted on) and canary (a share of tasks by hash) are not built. What exists is a per-repo and per-task choice of engine, so a trial is done by hand:

1. Add the candidate to the pack's `engines.allowed` in `contracts/src/packs.ts`, leaving `default` alone. A reviewed one-line change, reverted after the trial.
2. Pick it for one repo in that repo's `luna.yaml` (`engines: { triage: claude:opus-next }`), or for one task: `stages` on `POST /tasks`, `PATCH /tasks/:id/stages`, or the engine picker on the board.
3. Run a few real tickets. Every stage run records the engine it started on (`GET /tasks/:id`); `/metrics` does not split by engine yet, so compare the runs by hand: approved plans, first-pass verifying, cost, escalations.

## 6. Promote

Point the alias at the new catalog entry in `contracts/src/engines.ts` (`"claude:opus": { model: "anthropic/opus-5.6" }`) and remove the candidate engine and any `allowed` entry from step 5. Packs, `luna.yaml` files and tasks that name `claude:opus` follow without a change. The PR carries the scorecard, and the conformance result if step 3 happened. Then save new baselines on the promoted engine:

```sh
pnpm eval --pack triage --engine claude:opus --save-baseline
```

Rollback is reverting the alias line; a stage already running keeps its engine, and the next stage starts on the old model.

## 7. Retire

Mark the old entry `status: "deprecated"` with `retireAfter: "YYYY-MM-DD"`. From the day after, the contract test fails while any pack's engines still reach it. Once nothing does, delete the entry.
