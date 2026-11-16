# RFC 0011 — Small agent teams: effort per run, config proposals, two councils and a foreman

- **Author:** Higor Alves
- **Status:** Accepted, built (2026-11-16)
- **Created:** 2026-11-16
- **Discussion:** [PR #228](https://github.com/higoralves/luna-tui/pull/228)
- **Related:** [RFC 0003](./0003-upgradable-harness.md) (evals, baselines), [RFC 0005](./0005-software-factory-v1-5.md) (gates, risk), [RFC 0004](./0004-harness-for-luna-notch.md) (the notch approves its own plans), [RFC 0009](./0009-sandbox-state-of-the-art.md) (trust)

## Summary

One agent with one prompt does everything badly. A small team of specialised agents does each part better. Luna already has the parts: packs, engines and gates. This RFC adds six things that make a small team useful with a person near the loop:

- **Effort per run.** A repo and an eval run can set the effort of a pack.
- **An effort axis in the evals.** A scorecard says how a pack does at each effort.
- **Config proposals.** A fixed rule reads the scorecards and the repo's own runs. It proposes a change of engine or effort. A person approves it.
- **A plan council.** A security reviewer and a second opinion on another model read the finished plan.
- **A question council.** Agents settle open triage questions from the code before they ask a person.
- **A foreman.** One agent reads the open board and suggests actions. A person confirms each one.

## Why

- A pack is a role with a prompt. A role that has one job and a narrow tool list is easy to test and easy to swap.
- A person stays near the loop. Every team member only suggests, reads or settles a question. A person approves what changes state, money or the repo.
- The cost of a model varies by pack. A cheap engine at low effort is enough for some packs. A strong engine at high effort pays back for others. The machine should show which, from numbers.

## Alternatives weighed

**An LLM lead against the deterministic machine.** A lead agent could assign work, pick engines and decide when a plan is good enough. We rejected it.
- The machine already holds the order of the stages, the gates and the budgets. They are tested code.
- A lead agent adds a model call to every decision. Its mistakes are hard to replay.
- A lead that reads a stranger's issue text can be steered by it.
- So the machine stays the lead. Agents advise it at fixed points, and a person decides at the gates.

**Agents that apply their own config against a person who approves.** An agent could edit `luna.yaml`, its own engine or its own effort. We rejected it.
- A change of engine changes cost and quality for every later card. A person should own it.
- A fixed rule proposes the change. It calls no model, so the same numbers give the same proposal.
- The proposal is a card on a gate. The person reads the changes and the file, and approves or rejects. A rejected change does not come back for 30 days.

## Decisions

### Effort per run

The pack's `effort` is the default. A repo overrides it in `luna.yaml` under `effort:`. An eval run overrides it with `--effort` (`StageInput.effort`). The machine reads the effort when a stage starts. A decision pack takes none. A pack that runs on its own (`foreman`, `slack_triage`, `chat_triage` and the like) takes none either, so the file is invalid with one. If the engine that runs does not support the effort, the stage runs the pack's own effort. A `stage.engine` event says why.

### The effort axis in the evals

`pnpm eval --pack <p> --engine <e> --effort <x> --save-baseline` writes a scorecard to `baselines/<engine>@<effort>/`. `pnpm eval baseline-plan --efforts` prints the runs. A bad effort is refused before any case runs. An image that ignores the effort fails each case and refuses `--save-baseline`. So a baseline never records a setting that did not apply.

### Config proposals

`pnpm eval propose --repo <path>` turns the baselines into candidates. It posts them to `POST /repos/proposals`. `proposeConfig` is a fixed rule. It reads the candidates, the repo's runs of the last 30 days and the changes a person rejected. It proposes at most three changes, to `engines` and `effort` only.
- A candidate needs at least 3 cases and must be at most 90 days old. Its model must be the engine's current catalog model.
- A pack needs 10 runs in the repo, and one engine must have run 80% of them. Otherwise the pack gets no proposal. The answer names it under `skipped`.
- The pack steps up at a trouble rate of 25% or more. It steps down below 10%, only to an engine that costs at most 70% and loses at most 0.05 of quality.
- The proposal is a card on route `config` at the setup gate. `a` writes the file. `N` rejects it.
- A person's edit of a field the card changes makes the approve fail with `409 config_changed`. The machine never overwrites a hand edit.

### The plan council

After `plan_check`, the plan stage may run a council (`plan.council`). The members are `council_security` and `council_second`, on another model. They read the final plan, not a diff. If they find something, the planner revises once, and the members read the revised plan. Open findings go to the gate as `council.security` or `council.second`. A member that cannot answer is recorded, and the stage goes on. A failed revision ends the stage.

**`counts_as_pass`.** A passed council can stand in for the Low-risk bar of the auto-approve timer. The other bars stay. The timer approves a Medium or High-risk plan only when all of these hold:
- one approver at most is needed (`plan.approvers`);
- the plan carries no flag, no re-plan evidence and no open question;
- no answer on the card was settled by the question council;
- every check proceeded, and the council passed;
- the card is trusted, and is not a notch card.

A reply, an archive and a split always wait for a person.

### The question council

Before triage asks a person, the `question_council` pack reads the open questions from the code and the card, read-only. It answers `null` when it cannot settle one. The machine settles a question only when the answer's confidence reaches the bar of its field.
- It never answers urgency or archive questions. They always reach a person.
- It never writes ground truth. A field it settled is not a person's reading, so it confirms nothing.
- It does not run on an untrusted card. Every question goes to the person, and a note says so.
- Each settled answer carries its evidence. It shows on the board, and a person can overrule it with `T`.
- The plan gate lists the settled answers as `settledByCouncil`. The timer never approves such a plan.

### The foreman

The `foreman` pack reads a snapshot of the open board (60 cards at most) and answers one question. It returns a reply and suggested actions. It has no route to the machine and no tool. The board runs each action after a per-action `y`.
- A suggestion is bound to the card's open approval when the snapshot was taken. If the card moved to another gate, the row is stale and runs nothing.
- The machine drops a suggestion that is not safe to run. Examples are an `approve` at a gate with its own confirm flow, on a `config` card, or on a card with flags or an open council finding. It lists each drop with its reason.
- A reply to a ticket, an archive and a split keep their own confirm flow. Nothing outward goes without a tap.

## What was built

- **Effort.** `luna.yaml` `effort:`, `StageInput.effort`, `--effort` and the `<engine>@<effort>` baselines. A pack that runs on its own refuses `effort`. A re-attached run skips the effort-mismatch note.
- **Proposals.** `POST /repos/proposals`, the rule in `machine/src/domain/config-proposal.ts`, the `config` card with its change table, and `pnpm eval propose`. The rule refuses stale evidence and evidence from an off-model scorecard. It takes the baseline engine from the repo's own runs. The edit keeps comments, key order and every other key.
- **Plan council.** Two rounds by default, one revision, `plan.council.counts_as_pass`, and the council section on the plan review page.
- **Question council.** The `question_council` pack, `triage.council`, the settled answers on the board and `T` to overrule.
- **Foreman.** `POST /foreman`, the popup on `m`, flags, council state, trust and pending approvals in the snapshot, and a sanitised reply.
- **Recovery.** After a restart, `recover()` removes the council containers and their proxies. Nothing waits on them any more.

## Still open

- `plan` cannot get proposals. It runs in the `test_design` state beside the `test_design` pack. A state counts for a pack only when it runs exactly one agent pack.
- `evals/baselines/` holds no `<engine>@<effort>` folder yet. Nobody has run the baselines at each effort, so the rule has no effort scorecards to read.
- No schedule harvests, re-measures or proposes. A person runs `pnpm eval propose`.
