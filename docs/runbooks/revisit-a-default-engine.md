# Revisit a decision's default engine

The machine reads the engine for each decision slot from `contracts/src/decision-defaults.json`. The command `pnpm eval defaults --write` writes that file from baselines. Revisit one slot when:

- a person upgraded a model ([upgrade-a-model](upgrade-a-model.md)) and the slot's engine uses it;
- the pack's questions, criteria or bars changed (`contracts/src/packs.ts`), because the cases that quote the criteria break until a person reads them again;
- a scorecard row looks wrong (an engine that wins on six cases, a tie that went the unexpected way);
- a month of new truth has gathered: more labelled records than there were cases.

The owner pins a decision on Jev (`PINNED` in `evals/src/scorecard.ts`). These steps do not revisit that decision. Only the owner lifts the owner's pin.

## The steps for one pack

1. **See what exists.**
   - Run `pnpm eval records --pack <p> --since <date>`.
   - The output shows how many records are labelled, to confirm, waiting for a label, or local only.
2. **Label what has no truth.**
   - Run `pnpm eval label --pack <p> --next`.
   - Other ways to label: `pnpm eval label push --queue <id>`, the trace tool, or `pnpm eval dataset pull --pack <p>`.
3. **Harvest with readings.**
   1. Run `pnpm eval harvest --pack <p> --with-truth`.
   2. For each new case, write its `reading` from the pack's own criteria (see `evals/README.md`).
   3. Review the cases as a PR.
   - The pack needs at least eight cases, six labelled, an adversarial one with its twin and a borderline one.
4. **Preflight.**
   - Run `pnpm eval preflight`.
   - It makes no model call. It names what is missing.
5. **The three baselines.**
   1. Run `pnpm eval --pack <p> --engine claude:haiku --save-baseline`.
   2. Repeat with `codex:luna`.
   3. Repeat with `jev`. It is metered and needs `AI_GATEWAY_API_KEY` or `TYPESAFE_API_KEY`.
   - Add `--trials 3` to see a model's variance.
6. **Scorecard.**
   - Run `pnpm eval scorecard`.
7. **Dry run.**
   1. Run `pnpm eval defaults`.
   2. Read the acted-on accuracy with its interval.
   3. Read the per-answer table for `triage_signals`, `ticket_assess` and `conversation_assess`.
   4. Read any `kept: ... 8 are needed to move a default` line.
8. **Write or except.**
   - Run `pnpm eval defaults --write` to write every slot the rule moves.
   - Or run `pnpm eval defaults --write --except <pack>` to leave a pack exactly as it is.
   - Nothing here is automatic. A person reads the dry run first.
9. **Check and commit.**
   1. Run `pnpm --filter @hardness/contracts test`.
   2. Run `pnpm --filter site facts` (the site's fact for the slot).
   3. Commit `evals/baselines/**`, `evals/scorecard.md`, `contracts/src/decision-defaults.json` and the facts.

## Overriding by hand, and going back

To keep an engine the rule did not pick:

- Edit its entry in `contracts/src/decision-defaults.json` by hand.
- Start its `reason` with `override:` and say why.

The contracts test checks the file. To go back:

- Restore the entry from git (`git checkout <sha> -- contracts/src/decision-defaults.json`).
- Run the contracts test.
- Run `pnpm --filter site facts`.
- Commit the change.

A repository can still pin an engine per task or in `luna.yaml`. This file is only the default.

The bars (`decisions.<pack>.<question>` in `luna.yaml`) and the priority weights are separate. The commands `pnpm eval calibrate --pack <p>` and `pnpm eval calibrate --weights` propose them from ground truth. They change nothing.
