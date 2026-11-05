# Calibrate the decision packs

The decision packs answer typed questions with a confidence, and the machine acts on an answer only above the pack's bar. Which engine answers each slot is not a guess: it is read from `contracts/src/decision-defaults.json`, which `pnpm eval defaults --write` writes from the scorecard over every baseline (RFC 0005 wave 7). This runbook is how to produce that evidence and change a default.

## Run the baselines

Each decision pack has seed cases under `evals/<pack>/cases/` (two clear, one borderline, one adversarial; more come from `pnpm eval harvest`, see `evals/README.md`). A baseline is one engine's run of one pack:

```sh
# needs docker, the runner image (pnpm --filter @hardness/machine runner:build) and the engine's credential
MACHINE_TRACES=metadata pnpm eval --pack risk_score --engine claude:haiku --trials 3 --save-baseline
MACHINE_TRACES=metadata pnpm eval --pack risk_score --engine codex:luna   --trials 3 --save-baseline
MACHINE_TRACES=metadata pnpm eval --pack risk_score --engine jev          --trials 3 --save-baseline   # only with a Jev key
```

- Run every decision pack on at least two engines: a pack with one engine measured stays `unmeasured` and keeps its default.
- `claude:haiku` runs on your Claude subscription token and `codex:luna` on your local Codex login: no meter. **Jev is metered** (`AI_GATEWAY_API_KEY` or `TYPESAFE_API_KEY`) and by far the cheapest engine per call: the rule below gives it a tie, and it must still act on enough cases to qualify.
- With a Laminar key (`LMNR_PROJECT_API_KEY`, the `observe` compose profile) each engine's run is an evaluation in group `<pack>`: compare engines side by side in the UI. `--trials 3` shows a model's variance; three trials of every decision pack on three engines is a few hundred small calls.
- A decision pack runs without the judge; `--judge` adds it.

## Read the scorecard and take the defaults

```sh
pnpm eval scorecard          # writes evals/scorecard.md: a row per pack and engine, then the proposed default per slot
pnpm eval defaults           # prints the proposal, changing nothing
pnpm eval defaults --write   # updates contracts/src/decision-defaults.json
```

The rule, stated in `evals/scorecard.md`: an engine qualifies with coverage >= 0.6 and n >= 4; the default is the qualifying engine with the highest **acted-on accuracy** (right when the machine would have acted); engines within 2 points tie, and a tie goes to Jev when it is among them (by far the cheapest engine), else to the cheaper one; a pack with fewer than two engines measured keeps its default. Overconfidence (wrong at or above the bar) and ECE are what to read when two numbers look alike: a model that is right 90% of the time and sure 99% of the time is worse than one that is right 88% and sure 90%.

## Accept or override a default

- **Accept**: `pnpm eval defaults --write`, commit `evals/baselines/**`, `evals/scorecard.md` and `contracts/src/decision-defaults.json`, and the site fact (`pnpm --filter site facts`). The reason and the date are in the file.
- **Override**: edit the entry by hand in `contracts/src/decision-defaults.json` and say why in its `reason` (`override: ...`). `pnpm --filter @hardness/contracts exec vitest run` checks the file: every decision pack has an entry, every engine is within the pack's `allowed` list (`jev`, `claude:haiku`, `codex:luna`), every entry has a reason and a date. A bad file fails that test; the machine falls back to the built-in default (Jev, then `claude:haiku`) rather than failing at boot.
- A repo can still pin an engine per task or in `luna.yaml`; this file is only the default.

## What to re-run

- After changing a decision pack's questions, criteria or instructions (`contracts/src/packs.ts`): that pack's baselines on every engine, then `scorecard` and `defaults`.
- After a model upgrade ([upgrade-a-model](upgrade-a-model.md)): every pack on the engines that use the model. A baseline is a measurement of one model ID on one set of questions; the diff `pnpm eval` prints against the saved baseline is the regression check (RFC 0003 section 3).
- After adding cases (a harvest, or a labelled dataset pulled back): the packs that gained cases, on all their engines, so the numbers still compare.
