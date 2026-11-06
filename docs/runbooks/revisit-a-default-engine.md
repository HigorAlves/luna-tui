# Revisit a decision's default engine

Which engine answers each decision slot is read from `contracts/src/decision-defaults.json`, written by `pnpm eval defaults --write` from baselines. Revisit one slot when:

- a model was upgraded ([upgrade-a-model](upgrade-a-model.md)) and the slot's engine uses it;
- the pack's questions, criteria or bars changed (`contracts/src/packs.ts`): the cases that quote the criteria break until they are read again;
- a scorecard row looks wrong (an engine that wins on six cases, a tie that went the unexpected way);
- a month of new truth has gathered: more labelled records than there were cases.

A decision pinned on Jev by the owner (`PINNED` in `evals/src/scorecard.ts`) is not revisited by these steps: its pin is the owner's to lift.

## The steps for one pack

1. **See what exists.** `pnpm eval records --pack <p> --since <date>`: how many records are labelled, to confirm, waiting for a label, or local only.
2. **Label what has no truth.** `pnpm eval label --pack <p> --next` (or `pnpm eval label push --queue <id>`, label in the trace tool, `pnpm eval dataset pull --pack <p>`).
3. **Harvest with readings.** `pnpm eval harvest --pack <p> --with-truth`; for each new case write its `reading` from the pack's own criteria (see `evals/README.md`) and review the cases as a PR. The pack needs at least eight cases, six labelled, an adversarial one with its twin and a borderline one.
4. **Preflight.** `pnpm eval preflight`: no model call; it names what is missing.
5. **The three baselines.** `pnpm eval --pack <p> --engine claude:haiku --save-baseline`, then `codex:luna`, then `jev` (metered: needs `AI_GATEWAY_API_KEY` or `TYPESAFE_API_KEY`). Use `--trials 3` to see a model's variance.
6. **Scorecard.** `pnpm eval scorecard`.
7. **Dry run.** `pnpm eval defaults`. Read the acted-on accuracy with its interval, the per-answer table for `triage_signals`, `ticket_assess` and `conversation_assess`, and any `kept: ... 8 are needed to move a default` line.
8. **Write or except.** `pnpm eval defaults --write` writes every slot the rule moves; `pnpm eval defaults --write --except <pack>` leaves a pack exactly as it is. Nothing here is automatic: a person reads the dry run first.
9. **Check and commit.** `pnpm --filter @hardness/contracts test`, `pnpm --filter site facts` (the site's fact for the slot), then commit `evals/baselines/**`, `evals/scorecard.md`, `contracts/src/decision-defaults.json` and the facts.

## Overriding by hand, and going back

To keep an engine the rule did not pick, edit its entry in `contracts/src/decision-defaults.json` by hand and start its `reason` with `override:` and why; the contracts test checks the file. To go back, restore the entry from git (`git checkout <sha> -- contracts/src/decision-defaults.json`), run the contracts test and `pnpm --filter site facts`, and commit. A repository can still pin an engine per task or in `luna.yaml`; this file is only the default.

The bars (`decisions.<pack>.<question>` in `luna.yaml`) and the priority weights are separate: `pnpm eval calibrate --pack <p>` and `pnpm eval calibrate --weights` propose them from ground truth and change nothing.
