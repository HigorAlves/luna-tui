# Revisit a decision's default engine

The machine reads the engine for each decision slot from `packages/contracts/src/decision-defaults.json`. The command `pnpm eval defaults --write` writes that file from baselines. Revisit one slot when:

- a person upgraded a model ([upgrade-a-model](upgrade-a-model.md)) and the slot's engine uses it;
- the pack's questions, criteria or bars changed (`packages/contracts/src/packs.ts`);
- a scorecard row looks wrong (a win on six cases, an unexpected tie);
- a month of new truth has gathered: more labelled records than there were cases.

A change to the criteria breaks the cases that quote them. The cases stay broken until a person reads them again.

The owner pins a decision on Jev (`PINNED` in `evals/src/scorecard.ts`). These steps do not revisit that decision. Only the owner lifts the owner's pin.

## The steps for one pack

1. **See what exists.**
   - Run `pnpm eval records --pack <p> --since <date>`.
   - The output counts the records in each state: labelled, to confirm, waiting for a label, or local only.
2. **Label what has no truth.**
   - Run `pnpm eval label --pack <p> --next`.
   - Other ways to label: `pnpm eval label push --queue <id>`, the trace tool, or `pnpm eval dataset pull --pack <p>`.
3. **Harvest with readings.**
   1. Run `pnpm eval harvest --pack <p> --with-truth`.
   2. For each new case, write its `reading` from the pack's own criteria, as `evals/README.md` explains.
   3. Review the cases as a PR.
   - The pack needs at least eight cases, six labelled, an adversarial one with its twin and a borderline one.
4. **Preflight.**
   - Run `pnpm eval preflight`.
   - It makes no model call. It names what is missing.
5. **The three baselines.**
   1. Run `pnpm eval --pack <p> --engine claude:haiku --save-baseline`.
   2. Repeat with `codex:luna`.
   3. Repeat with `jev`. Its provider meters it, and it needs `AI_GATEWAY_API_KEY` or `TYPESAFE_API_KEY`.
   - Add `--trials 3` to see a model's variance.
   - An agent pack also takes `--effort low|medium|high`. Its baseline then goes to `baselines/<engine>@<effort>/`. `pnpm eval baseline-plan --efforts low,high` lists those runs.
6. **Scorecard.**
   - Run `pnpm eval scorecard`.
   - The `## Agent packs` table in `evals/scorecard.md` shows each agent pack by engine and effort. It proposes no default.
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
   3. Commit `evals/baselines/**`, `evals/scorecard.md`, `packages/contracts/src/decision-defaults.json` and the facts.

## Proposing a change for one repo

The steps above move the machine's default. A repo can also ask for its own engine and effort per pack in `luna.yaml`. After new baselines exist, the machine can draft that change:

1. Run `pnpm eval propose --repo <abs path> --dry-run`. It prints the request and calls nothing.
2. Run `pnpm eval propose --repo <abs path>`. The machine must be up. The command reads `MACHINE_API_TOKEN` or `~/.config/hardness/machine-api-token`. `--machine <url>` or `MACHINE_URL` names another machine. The default is `http://127.0.0.1:4317` (`pnpm dev`).
3. The output lists the changes and the card id. It says `no change proposed` when the repo's runs do not call for one.
4. On the board, open the card. `a` writes `luna.yaml`. `N` rejects it, and the same change stays out for 30 days.

Today only `triage` can produce a proposal. A pack needs both eval cases and run signals in the repo. The packs with cases are `triage`, `plan` and `slack_triage` (plus the decision packs). `plan` shares the `test_design` state with the test designer and the code map, so it has no signal. `slack_triage` runs in no task state, so it has none. The decision packs run on demand, so they have none. Other packs, such as `verifying` and `setup`, have run signals but no eval cases yet. A scorecard also counts for 90 days only, and only for the engine's current model. Re-run the baselines after a model swap.

The rule is in [architecture](../architecture.md#config-proposals).

## Overriding by hand, and going back

To keep an engine the rule did not pick:

- Edit its entry in `packages/contracts/src/decision-defaults.json` by hand.
- Start its `reason` with `override:`.
- Say why in the rest of the `reason`.

The contracts test checks the file. To go back:

- Restore the entry from git (`git checkout <sha> -- packages/contracts/src/decision-defaults.json`).
- Run the contracts test.
- Run `pnpm --filter site facts`.
- Commit the change.

A repository can still pin an engine per task or in `luna.yaml`. This file is only the default.

The bars (`decisions.<pack>.<question>` in `luna.yaml`) and the priority weights are separate. The commands `pnpm eval calibrate --pack <p>` and `pnpm eval calibrate --weights` propose them from ground truth. They change nothing.
