# Calibrate the decision packs

The decision packs answer typed questions with a confidence. The machine acts on an answer only above the pack's bar. The choice of engine for each slot is not a guess. The machine reads it from `contracts/src/decision-defaults.json`. The command `pnpm eval defaults --write` writes that file from the scorecard over every baseline (RFC 0005 wave 7). This runbook shows how to produce that evidence and change a default.

For one pack, step by step, with the labelling and the case readings, see [revisit a decision's default engine](revisit-a-default-engine.md). The current rule has these parts. An engine qualifies with coverage 0.6 and four graded cases. The three packs measured answer by answer also need 20 labelled answers. The default is the qualifying engine with the highest acted-on accuracy. A tie goes to Jev, else to the cheaper engine. An engine that acted on every case and was right on every one wins outright. A default moves only on eight graded cases and six labelled cases. Nobody moves the owner's pins.

## Run the baselines

Each decision pack has seed cases under `evals/<pack>/cases/` (two clear, one borderline and one adversarial). More cases come from `pnpm eval harvest` (see `evals/README.md`). A baseline is one engine's run of one pack:

```sh
# needs docker, the runner image (pnpm --filter @hardness/machine runner:build) and the engine's credential
MACHINE_TRACES=metadata pnpm eval --pack risk_score --engine claude:haiku --trials 3 --save-baseline
MACHINE_TRACES=metadata pnpm eval --pack risk_score --engine codex:luna   --trials 3 --save-baseline
MACHINE_TRACES=metadata pnpm eval --pack risk_score --engine jev          --trials 3 --save-baseline   # only with a Jev key
```

- Run every decision pack on at least two engines. A pack with one engine measured stays `unmeasured` and keeps its default.
- `claude:haiku` runs on your Claude subscription token and `codex:luna` on your local Codex login. Neither has a meter. **Jev is metered** (`AI_GATEWAY_API_KEY` or `TYPESAFE_API_KEY`). Jev is by far the cheapest engine per call. The rule below gives Jev a tie. Jev must still act on enough cases to qualify.
- With a Laminar key (`LMNR_PROJECT_API_KEY`, the `observe` compose profile), each engine's run is an evaluation in group `<pack>`. Compare engines side by side in the UI. `--trials 3` shows a model's variance. Three trials of every decision pack on three engines make a few hundred small calls.
- A decision pack runs without the judge. Add `--judge` to include the judge.

## Read the scorecard and take the defaults

```sh
pnpm eval scorecard          # writes evals/scorecard.md: a row per pack and engine, then the proposed default per slot
pnpm eval defaults           # prints the proposal, changing nothing
pnpm eval defaults --write   # updates contracts/src/decision-defaults.json
```

`evals/scorecard.md` states the rule. An engine qualifies with coverage >= 0.6 and n >= 4. The default is the qualifying engine with the highest **acted-on accuracy** (right when the machine would have acted). Engines within 2 points tie. A tie goes to Jev when it is among them (by far the cheapest engine), else to the cheaper one. A pack with fewer than two engines measured keeps its default.

Read overconfidence (wrong at or above the bar) and ECE when two numbers look alike. Compare two models. One is right 90% of the time and sure 99% of the time. The other is right 88% and sure 90%. The first model is worse.

## Accept or override a default

- **Accept**:
  - Run `pnpm eval defaults --write`.
  - Commit `evals/baselines/**`, `evals/scorecard.md`, `contracts/src/decision-defaults.json` and the site fact (`pnpm --filter site facts`).
  - The file holds the reason and the date.
- **Override**:
  - Edit the entry by hand in `contracts/src/decision-defaults.json`.
  - Say why in its `reason` (`override: ...`).
  - The command `pnpm --filter @hardness/contracts exec vitest run` checks the file. Every decision pack must have an entry. Every engine must be within the pack's `allowed` list (`jev`, `claude:haiku`, `codex:luna`). Every entry must have a reason and a date.
  - A bad file fails that test. The machine then falls back to the built-in default (Jev, then `claude:haiku`). It does not fail at boot.
- A repo can still pin an engine per task or in `luna.yaml`. This file is only the default.

## What to re-run

- After you change a decision pack's questions, criteria or instructions (`contracts/src/packs.ts`):
  - Re-run that pack's baselines on every engine.
  - Run `scorecard`.
  - Run `defaults`.
- After you upgrade a model ([upgrade-a-model](upgrade-a-model.md)), re-run every pack on the engines that use the model. A baseline measures one model ID on one set of questions. The diff that `pnpm eval` prints against the saved baseline is the regression check (RFC 0003 section 3).
- After you add cases (a harvest, or a labelled dataset pulled back), re-run the packs that gained cases on all their engines. The numbers then still compare.
