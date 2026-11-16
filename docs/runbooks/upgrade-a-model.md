# Upgrade a model

This runbook is [RFC 0003](../rfcs/0003-upgradable-harness.md)'s playbook, as you can follow it today. The steps are the same for a Claude, OpenAI or Jev model. RFC 0003 calls two things shadow and canary. Nobody has built them yet. Step 5 says what to do instead.

Everything here runs on your machine. Evals and live runs need a model credential, so none of it runs in CI.

## 1. Catalog entry

- Add the model to `contracts/src/models.ts`. This is the only source file that holds a model ID.
  - Use a new key (`anthropic/opus-5.6`).
  - Set its `runtime`.
  - Set the exact `id` that the vendor SDK takes (never an alias).
  - Set `status: "preview"`.
  - Set its `caps` (tools, structured output, the efforts it supports).
- Add a candidate engine for it in `contracts/src/engines.ts` (`"claude:opus-next": { model: "anthropic/opus-5.6" }`). A `codex:*` or `openai:*` engine also names its `auth`.

No pack names the candidate yet.

For a `codex:*` engine, check that a ChatGPT login serves the model at all. `gpt-6-sol` is API-only there, so `codex:sol` runs `gpt-5.6-terra`. Jev's entry is `jev-latest`, TypeSafe's own alias. It can change under the harness. The only check is the `triage_signals` cases (step 4).

## 2. Contract test

```sh
pnpm --filter @hardness/contracts test
```

`contracts/src/engines.test.ts` fails in these cases:

- An engine names a model that is not in the catalog.
- A pack's engine cannot serve its model. An agent pack needs tools and structured output, and the pack's effort must be among the model's.
- Anything references a retired model.
- Any source file under `contracts/src`, `factory/src` or `machine/src` other than `models.ts` names a model ID.

Its "keeps today's models as the defaults" case fails on purpose if a pack's default engine changes.

## 3. The SDK, if it has to move

The runtime SDKs are `@anthropic-ai/claude-agent-sdk`, `eve`, `@typesafe-ai/sdk` and the Codex CLI's `CODEX_VERSION` in `machine/runner/Dockerfile`. If the new model needs a newer one, do these steps first:

- Bump that SDK alone.
- Make the bump its own PR.
- Use an exact version.

Then run these commands in order:

```sh
pnpm --filter @hardness/factory test                      # the conformance table, on each runtime's fake
pnpm --filter @hardness/machine runner:build              # the stage image, with the new SDK
pnpm --filter @hardness/machine smoke:sandbox             # evidence and a dry-run implementing pack in the hardened container
```

The conformance table (`factory/src/runtimes/conformance/table.ts`) is the bar. Every runtime runs the same scenarios against a fake of its own transport. That PR changes no model.

## 4. Replay

- Build the stage image from your branch. The evals run in that image.
- Run the candidate against today's engine on the cases of every pack that uses the engine you replace:

```sh
pnpm --filter @hardness/machine runner:build
pnpm eval --pack triage --engine claude:opus-next --against claude:opus
```

An engine outside a pack's `allowed` runs as a candidate, so the pack needs no change for this.

- Put the scorecard (pass rate, judge score, turns, duration, cost) in the PR description.
- Keep a laptop awake for the run (`caffeinate -s` on macOS).

Only `triage`, `slack_triage` and `triage_signals` have cases (`evals/<pack>/cases/`). For any other pack the alias touches, add cases first ([evals/README.md](../../evals/README.md), "Add a case"). Or run the golden tickets on a branch. The branch already points the alias at the new entry (step 6). Compare the result with the same run on `main`:

```sh
pnpm golden --matrix       # needs a running machine from that branch, a credential and docker
```

## 5. Try it on real tasks (instead of shadow and canary)

Nobody has built shadow (the candidate answering the same input without anyone acting on it) or canary (a share of tasks by hash). The harness has a per-repo and per-task choice of engine. So you run a trial by hand:

1. Add the candidate to the pack's `engines.allowed` in `contracts/src/packs.ts`.
   The reviewer sees a one-line change that leaves `default` as it is.
2. Pick the engine for one repo in that repo's `luna.yaml` (`engines: { triage: claude:opus-next }`).
   Or pick the engine for one task through `stages` on `POST /tasks`, `PATCH /tasks/:id/stages`, or the engine picker on the board.
3. Run a few real tickets.
4. Compare the runs by hand: approved plans, first-pass verifying, cost, escalations.
   Every stage run records the engine it started on (`GET /tasks/:id`). `/metrics` does not split by engine yet.
5. Revert the one-line change from step 1.

## 6. Promote

- Point the alias at the new catalog entry in `contracts/src/engines.ts` (`"claude:opus": { model: "anthropic/opus-5.6" }`).
- Remove the candidate engine and any `allowed` entry from step 5.

Packs, `luna.yaml` files and tasks that name `claude:opus` follow without a change. The PR carries the scorecard, and the conformance result if step 3 happened. Then save new baselines on the promoted engine:

```sh
pnpm eval --pack triage --engine claude:opus --save-baseline
```

To roll back, revert the alias line. A stage already running keeps its engine. The next stage starts on the old model.

## 7. Retire

- Mark the old entry `status: "deprecated"` with `retireAfter: "YYYY-MM-DD"`.

From the day after that date, the contract test fails while any pack's engines still reach the entry.

Delete the old entry once no pack's engines reach it.

The evals measure a decision pack's engine default. Nobody assumes it. After the upgrade, do these steps:

- Re-run the baselines of the packs on that model.
- Re-take the defaults ([calibrate-decisions](calibrate-decisions.md)).
