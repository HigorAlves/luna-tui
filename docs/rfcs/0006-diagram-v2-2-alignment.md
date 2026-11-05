# RFC 0006 — Aligning the machine with the v2.2 flow diagram

- **Author:** Higor Alves
- **Status:** Approved (2026-11-05)
- **Created:** 2026-11-05
- **Discussion:** the PR that adds this file
- **Decision deadline:** 2026-11-12 (decided at the plan gate on 2026-11-05: all eleven waves; D1 aligned with `policy.preview` as the opt-in; D3 scripts where facts decide; D4 on for Low and Medium only where a review is required)
- **Builds on:** [RFC 0005](0005-software-factory-v1-5.md) (the v1.5 diagram, waves 0 to 7, PRs #173 to #184)
- **Diagram:** Software Factory, Flow Diagram, draft v2.2 (ten panels: overview, ⓪ Conversation, ⓪ Tickets, ① Intake to ⑦ Ship)

## Summary

RFC 0005 mapped the v1.5 diagram onto the machine and seven waves built it. The diagram is now at v2.2, with implementation-level detail on every stage: schemas, config values, budgets, SLAs, events and a ground-truth capture per stage, plus two machines in front of Intake (Conversation and Tickets), a shared backlog, a decomposition loop and stacked cards. An audit of all 684 elements of v2.2 against the head of the stack found 188 built as drawn, 195 partly, 154 missing, 75 built another way with no recorded reason, and 68 built another way on purpose (recorded in RFC 0005). This RFC names the misreadings to correct, revisits the recorded deviations that v2.2 now states the other way, scopes what is new, and orders the work into eleven waves on top of #184.

## Goals

- Every one of the 75 unrecorded differences is either corrected or becomes a recorded deviation with its reason.
- Every recorded deviation that v2.2 contradicts is decided again, once, here.
- The contracts carry the diagram's objects by name: Card, Triage Record, Plan, Scenario, Finding, Build Report, Verify Report, Evidence Pack, and the events each stage emits.
- The two ⓪ machines exist as the diagram draws them, built from today's Slack inbox and Jira intake, with a human tap before anything leaves the machine.
- Each wave leaves the stack shippable: a wave that changes a default says so, and old records still load.

## Non-goals

- A second client. The TUI stays the only client (RFC 0004 and the notch stay out).
- Deploys. Ship hands off at the merge with `ship.merged`, as the diagram does.
- Discord, Linear or Teams adapters. The adapter seams are built; only Slack, Jira and GitHub Issues get adapters now.
- Embeddings through a provider API. Similarity search is lexical first (see the dedup deviation below); an embeddings port can follow.
- Replacing the measured decision defaults with "Jev by default". The scorecard keeps deciding each slot (wave 7, decided 2026-11-05).

## Background: what the audit found

Five read-only audits compared every node, edge, schema field, config value, SLA, state and event of v2.2 against the code at `5c4fd1e` (the head of #184), citing a file and line per row. A row is a *deviation* only where RFC 0005 states the different choice and why.

| Panel | Elements | As drawn | Partly | Missing | Different, unrecorded | Deviation, recorded |
|---|---|---|---|---|---|---|
| Overview | 44 | 23 | 8 | 5 | 1 | 7 |
| ⓪ Conversation | 62 | 16 | 19 | 19 | 6 | 0 |
| ⓪ Tickets | 87 | 10 | 30 | 37 | 10 | 0 |
| ① Intake | 55 | 11 | 12 | 21 | 7 | 4 |
| ② Triage | 78 | 26 | 18 | 23 | 8 | 3 |
| ③ Plan and fast lane | 61 | 21 | 19 | 5 | 8 | 8 |
| ④ Build | 72 | 17 | 23 | 12 | 12 | 8 |
| ⑤ Verify | 57 | 16 | 16 | 12 | 6 | 7 |
| ⑥ Evidence | 63 | 22 | 17 | 9 | 7 | 8 |
| ⑦ Ship | 63 | 18 | 20 | 7 | 3 | 15 |
| Cross-cutting (events, ground truth, config, states) | 42 | 8 | 13 | 4 | 7 | 8 |
| **Total** | **684** | **188** | **195** | **154** | **75** | **68** |

Four rows are not applicable. The full tables are in the appendix files beside this RFC.

Two facts shape the plan. First, RFC 0005 was written against v1.5, which had no panel for either ⓪ machine and listed "retiring the TUI's Jira, Slack or PR inbox" as a non-goal, so most of the missing rows are scope that was never attempted, not work that went wrong. Second, v2.2 is explicit where v1.5 was a sketch, so several choices recorded as deviations (publishing at Ship, a preview gate on every card, auto-merge off) are now the opposite of what the diagram says in words.

## Proposed design

### 1. Misreadings to correct

Built against the diagram, with no recorded reason. Each is corrected in the wave named.

**Sources and intake**
1. Jira and GitHub intake create cards and post comments, refusals included, with no human tap; a confident "question" is declined with a canned comment and no card. The diagram: "always a human tap for anything leaving the machine", drafts "never auto-posted". (Wave 16)
2. Assessment runs before validity on tickets, and of the eight signals only `kind = question` is acted on. (Wave 16)
3. Slack scope is inverted: DMs are read every poll and channels are opt-out. The diagram: opted-in channels only, DMs excluded unless invited. (Wave 17)
4. Task updates go to a second, machine-owned Slack thread; the diagram posts to the originating thread. (Wave 17)
5. The Slack draft is written inside the triage call, with no tools, so it never sees card state, an Evidence Pack or docs. (Wave 17)
6. The `backlog` state was retired; the diagram has a ranked shared backlog. (Wave 14)

**Triage and plan**
7. `type_of_work` was built as `area`, whose labels are this repository's own folders, in a pack that runs for any repo. (Wave 9)
8. The triage agent picks the fast lane; the diagram has a config rule (risk Low, size at most S, type not infra or data, no cross-team owners) the machine checks. (Wave 9)
9. Signals run before the card exists for GitHub and Jira, and the stage-side call ignores the repo's policy overrides. (Wave 9)
10. The risk level is the sum of the three scores; the diagram multiplies them (at most 4 Low, 5 to 11 Medium, 12 and up High). (Wave 9)
11. The test designer is handed the plan's slices; the diagram gives it the acceptance criteria and the goal, "not the plan steps". (Wave 9)
12. The coverage loop is driven by exact criterion-text matching, with no score and no 0.85 bar. (Wave 9)
13. The fast lane runs the code map with impact analysis; the diagram says locate only. (Wave 9)

**Build**
14. Scenarios are "a guide" for the implementer; the diagram has one failing test per scenario, tagged `@scenario:id`, committed before the implementation. (Wave 10)
15. A scope failure re-runs the stage, up to six runs; the diagram allows one fix pass, then escalates. (Wave 10)

**Verify and evidence**
16. Verify runs the checks first and a red check ends the stage before any review; the diagram reviews first, classifies, then runs the suite. (Wave 12)
17. "One Build round per finding set, then escalate" was built as a three-failure cap that is not configurable. (Wave 12)
18. An API or CLI change gets text; the diagram sends it to screenshots or terminal captures. (Wave 12)
19. An incomplete pack fails Ship and asks a person; the diagram fixes the sections. (Wave 12)
20. A CI flake still red after its re-run goes to Build as fixable; the diagram sends it to a person. (Wave 12)
21. Evidence can fail back to Build on a missing manifest row; the stage is drawn "degrade, never block". (Wave 12)
22. An e2e or Evidence failure returns to Build with no findings attached. (Wave 12)

**Ship**
23. The high-risk ship approval is given at the preview gate, before review and readiness, so the approver never sees the checklist. (Wave 13)
24. The machine's own merge records the PR head as the merged SHA, not the merge commit. (Wave 13)
25. A head older than fourteen days waits as a blocker; the diagram forces a partial re-verify. (Wave 13)
26. A nit skips `fix_scope`; `refresh_text` only appends a sentence; a rejected ship approval re-runs Evidence where the diagram archives. (Wave 13)
27. `refresh_media` re-runs Evidence on the old browser run. (Wave 13)

### 2. Recorded deviations, decided again

| # | RFC 0005 chose | v2.2 says | Proposed |
|---|---|---|---|
| D1 | A human preview gate on every card (`awaiting_ship`); publish and mark ready at Ship; monitor in `shipping`; the retro waits for a click even on "no" | Evidence publishes and marks the PR ready; `awaiting_ship` is the monitored wait; High risk asks a human after readiness; "most cards: no → Done" | **Decided: align.** The PR is the preview. `policy.preview: on` keeps the old gate for a repo that wants it. |
| D2 | `plan_wrong` and `re_plan` return to ② Triage | Both return to ③ Plan, with evidence and the reviewer's context | **Align**, and render the evidence into the planner's prompt. |
| D3 | Scripts and agent packs where the diagram draws a purple node: merge readiness, pack complete (scripts); code map, CI failure class, video QA (agents); escalation reason (the agent's own word) | Typed decisions | **Keep scripts where facts decide** (readiness, pack complete, the new entry contract): a checklist computed from GitHub's facts is right or wrong, never 0.7 sure. **Make typed decisions** of the CI failure class and the escalation reason. **Keep agent packs** for code map and video QA, which need tools and frames, and give both a confidence. **Decided as proposed.** |
| D4 | `policy.auto_merge: off` by default | Auto-merge Low and Medium when the checklist passes | **Decided: on for Low and Medium, only where a review is required** (branch protection or CODEOWNERS demands an approval); a repo with no required review stays manual, so the machine never merges unreviewed code by default. |
| D5 | SLA: one reminder after an hour; auto-archive off; reason `sla_expired` | 2 days reminder, 5 days auto-archive or escalate; reasons `no_setup`, `no_answer` | **Align the defaults and reasons**; they stay configurable. |
| D6 | Narration, then recording (the recorder holds each scene for its clip) | Narration and recording concurrently, in two sandboxes; compose aligns by timings | **Align.** The recorder paces by scenario; compose holds or trims against `timings.json`. |
| D7 | Red, green and commit per slice in one run; checkpoint to `refs/luna/wip/<branch>`, one attempt; regression sweep in Verify | Tests first as its own step; checkpoint on branch `card/<id>` with three retries; regression sweep in Build | **Align** tests-first, the retries and the sweep in Build (it also stays in Verify). **Keep the wip ref**: a checkpoint on the branch runs branch CI on every iteration and moves a PR head when one exists; the diagram's intent (work on the remote, a human can pick it up) holds. |
| D8 | Graph as a read-only mount with CLI verbs, rebuilt by poll, stale after one commit | A shared service: `locate(text)`, `impact(files)`, rebuilt on merge, stale past 50 commits | **Align the interface**: `locate` and `impact` as a machine port over the same graph (intake, tickets, plan and build all call it); rebuild when the monitor sees a merge; the threshold in config (50). The mount stays for agents. |
| D9 | Verifier on `claude:opus`, the implementer's family | A different model family when available | **Align by policy**: `verifying` allows a second family and prefers it when its credential exists; the eval scorecard keeps the choice honest. |
| D10 | Patch coverage of added lines, no threshold | Before/after on touched files, a 0.5% drop is a finding, optional mutation testing | **Keep patch coverage** (stricter, and needs no run on the base), add the threshold and an optional mutation command to config. |
| D11 | Measured default per decision slot | "Jev by default" | **Keep** (decided 2026-11-05). |
| D12 | A conversation ends `archived: not_for_agent` | Ends `closed`, replied | **Align.** |
| D13 | Board columns keep their v1 grouping (the plan gate sits under Triage) | Seven stages, each with its states | **Align the columns to the seven stages.** |
| D14 | Event-class labels `comment, approval, changes_requested, push, noise`; no read step before intent; fixes on the task worktree; a static `freeze[]` list; event `task.shipped` | The nine event classes; "LLM · Read comment"; fresh sandbox; a freeze calendar source; `ship.merged` | **Align** labels, the read step and the event name; fresh sandbox arrives with wave 11; the freeze source becomes a port with `luna.yaml` as its first adapter. |

### 3. New in v2.2

- **Contracts.** A Card with `source[]`, reporter, hints, owners, followers, budgets, SLA clocks and a timeline; Triage Record v2 (summary, type of work, goal, urgency with sub-scores, preliminary risk, hints used, who decided, version); Plan (steps with files and `done_when`, criteria with ids, out of scope, migration, flags); Scenario (id, criterion, type, given/when/then, data needs, layer); Finding (id, severity, category, criterion, suggested fix); Build Report; Verify Report; Evidence Pack v2 (results, resolutions, preview URL, local paths, version).
- **Events and metrics.** The named events of each panel (`card.*`, `build.*`, `verify.*`, `evidence.*`, `ship.*`) on the stream, and the metrics they feed (plan cycle time, coverage rounds, iterations, cost, the four DORA numbers).
- **Config.** Each panel's config block as a `luna.yaml` section with the diagram's values as defaults.
- **Weighted scoring.** One module for both machines and triage: who ×3, what ×3, impact ×2, time sensitivity ×2, demand ×1, knock-outs first, weights in config, sub-scores kept; priority as cost of delay over cost of doing for the backlog.
- **Intake.** The `create_card` contract; a duplicate/related decision over open cards, 90 days of closed ones and the backlog; merge into an existing card; context setup (repo, project, owners) and a context-complete gate; the SLA on it.
- **Sandbox.** A spec per card: limits (4 CPU, 8 GB, 90 minutes, 2M tokens), egress to registries and GitHub only, scoped secrets, `env_hash`; a fresh sandbox in Verify cloned at the head SHA; a preview deploy or a start-and-seed command for e2e; an escalated sandbox kept 24 hours.
- **Change size.** An estimate before a card, a guard at Plan (2.5k LOC hard, 1 to 2k target), a decomposition loop into child tickets (8 children, 3 rounds, depth 2) with a split check.
- **Stacked cards.** `card.base`, the dependency rule for scheduling, PRs that target the parent's branch, `parent_merged` and `parent_changed` in the maintenance loop, readiness for a stacked PR.
- **⓪ Tickets.** Canonical ticket and ticket object, scope by assignee, validity and four assessments as typed decisions, a WSJF score, a bot comment, a recommendation, drafts behind a tap, ticket → factory events, ticket SLAs.
- **⓪ Conversation.** Canonical message and conversation object, debounce, enrichment, typed decisions with confidence, relation to cards and backlog, knock-outs, the weighted score, a draft written with card state and docs, one draft per thread expiring in 24 hours, ground truth as sent / edited / ignored, a secrets and PII check before storing.
- **Shared backlog.** One ranked list for tickets and chat candidates, demand bumps, stale items re-assessed.
- **Ground truth per stage.** What a person dismissed, added, edited or overrode at every stage, feeding the eval loop of wave 7.
- **Evidence.** A secrets and PII check on video frames, TTS voice and language in config, a storage-target port, 180-day retention.
- **Retro.** The structured outputs (recalibration, graph feedback, prompt and runbook proposals) acted on, and the missing signals for "worth learning".

### Migration: eleven waves on top of #184

Each wave is one PR stacked on the last, its own flow with a failing test first, one commit per slice, a security pass, and notes appended here. A wave that changes a default or a route says so in its PR.

| Wave | Work | Exit criterion |
|---|---|---|
| **8 Contracts and events** | The v2.2 schemas above (old records still parse), named events on the stream, the config sections with defaults, the scoring module, the metrics the events feed | A card's plan, scenarios, findings and reports validate against the v2.2 schemas; the stream carries every event name of the diagram |
| **9 Triage and Plan as drawn** | Signals v2 with generic type of work, sub-scores and P0 to P3; per-field confidence bars and ask-a-person below them; question caps; record-complete check; the fast-lane rule in the machine; conversation ends closed; plan order (map, risk and complexity, size guard, plan, scenarios, coverage, check); risk as a product; structured scenarios from criteria; coverage score; `plan_wrong` to ③ with evidence; approver outside the owning team; triage ground truth | A ticket reaches Build with a v2 record and plan; the fast lane is taken by the rule; misreadings 7 to 13 closed |
| **10 Build as drawn** | Entry contract; tests first, tagged per scenario, committed and pushed; loop limits in config (iterations, tokens, minutes); regression sweep; self-review with a Diff Summary; scope check with one fix pass; escalation reason as a decision; budget monitor; Build Report; `build.*` events | Every approved scenario has a tagged test that failed first; a second scope red escalates; misreadings 14 and 15 closed |
| **11 Sandbox** | The per-card spec, egress allowlist, `env_hash`, a fresh sandbox in Verify and for fixes, preview deploy or start-and-seed, the kept sandbox | Verify runs on a clone at the head SHA; an `env_hash` mismatch is a blocker finding |
| **12 Verify and Evidence as drawn** | Review before checks; Finding v2 with duplicates merged; one Build round per finding set; findings carried back from e2e and Evidence; reviewer family policy; coverage threshold and mutation hook; per-scenario e2e judge and artifacts; PR body template; CI class as a decision; format labels and terminal capture; narration and recording concurrently; frame check for secrets; publish and mark ready inside Evidence; stale parts regenerated; thumbs | The PR is ready for review with its pack when Evidence passes; misreadings 16 to 22 closed |
| **13 Ship as drawn** | Monitor in `awaiting_ship` with its SLAs; the nine event classes; the read-comment step; `fix_scope` for nits with affected scenarios; text sections regenerated; media refreshed for real; `re_plan` to ③ with context; readiness view; approval after readiness; merge config and merged SHA; `ship.merged`; a closed PR archives; the retro runs in `reviewing_memory` and a "no" closes the card; retro outputs applied | A low-risk card goes from an approved plan to closed with no further click; misreadings 23 to 27 closed |
| **14 Intake and backlog** | `create_card`, the Card fields, the duplicate/related decision and merge, context setup and its gate, the shared ranked backlog and its TUI view | A duplicate report merges into its card; the backlog orders candidates by score |
| **15 Size and stacks** | The size estimate and guard, the decomposition loop and split check, child tickets, `card.base`, stacked PRs, parent events | A ticket over the limit is split into children that ship as a stack |
| **16 Ticket Machine** | Canonical ticket, assignee scope, validity then assessment, WSJF, bot comment, recommendation, drafts behind a tap, ticket → factory events, ticket SLAs, ground truth | Nothing is posted to a ticket without a tap; an edited scope re-assesses the card; misreadings 1 and 2 closed |
| **17 Conversation Machine** | Canonical message, conversation object, debounce, enrichment, typed decisions, relation, weighted priority, the draft with context, expiry, ground truth, outbound to the source thread, scope and quiet rules, the secrets check | A thread about a card in progress attaches to it and gets a status draft; misreadings 3 to 5 closed |
| **18 Evals for what is new** | Cases and baselines for every new decision; weights and bars recalibrated from ground truth; the scorecard rerun | Every decision pack has a baseline on two engines again |

Waves 8 to 13 bring the eight stages into line and can ship before any of 14 to 17. Wave 11 has no dependant until 12's fresh-sandbox item; it can trade places with 12 if the sandbox work runs long.

## Alternatives considered

### Update the diagram to match the code
Record every difference as a deviation and redraw. Rejected: 75 differences have no reason behind them, and several (auto-posting without a tap, the risk formula, the review order) are plainly worse than what is drawn.

### One wave per panel
Ten waves, one per diagram panel. Rejected: the contracts, events and config cut across every panel, so each wave would redo the last one's schema work. A contracts wave first makes the rest additive.

### The ⓪ machines first
They hold the largest share of missing rows. Rejected as an order: they feed Intake, which still lacks the entry contract, the backlog and dedup they need; and the stage corrections are cheaper and change behaviour people already rely on.

### Keep doing what we do
Ship the stack as built against v1.5. Rejected: the diagram is the design of record and the user asked for the match; the gap grows with every version.

## Open questions

- Q1: Dedup needs similarity search. Preferred: a lexical index (trigram and token overlap over title, summary and source links) that shortlists five candidates for the typed decision; an embeddings port later. The diagram's thresholds (0.90, 0.70) then apply to the decision's `similarity`, not a cosine.
- Q2: Egress allowlisting in Docker Desktop needs a proxy container or a custom network policy. Preferred: an allowlisting forward proxy the sandbox must use, with direct egress dropped; cost is one more container per run.
- Q3: "Release owner" has no source today. Preferred: `luna.yaml` `ship.release_owners[]`, with CODEOWNERS of the changed paths as the other half of "release owner or code owner".
- Q4: The preview deploy is the project's own command. Preferred: `luna.yaml` `verify.e2e.deploy{command, url_pattern, health_check, timeout}` beside today's `qa_targets[]`, which stays as the static case.

## Risks and unknowns

- **Removing the preview gate** (D1) takes a human look out of every card. The PR review replaces it only if the repo requires reviews; readiness must refuse to auto-merge where no review is required.
- **Schema migration.** Cards in flight carry v1 records and plans. Every v2 schema must parse a v1 value, and the first wave proves it with fixtures from the current state dir.
- **The size of the ⓪ machines.** Waves 16 and 17 rebuild two working features (the Slack inbox, Jira intake). Each keeps the old path until its replacement passes the same eval cases.
- **Fourteen days of polling** became webhooks in the diagram. The machine has no public endpoint; polling stays, with the interval in config, and is recorded as a deviation.

## Success criteria

- A second audit of v2.2 after wave 13 finds no unrecorded difference in panels ① to ⑦, and after wave 18 none in any panel.
- A low-risk ticket goes from a tap in the TUI to a merged PR and a closed card with one approval (the plan).
- Nothing leaves the machine toward a ticket or a thread without a tap, measured by the events: every outbound post has a human decision before it.
- Every decision pack, old and new, has a baseline on two engines and a default from the scorecard.

## Appendix

The audit tables, one row per diagram element with file and line: `0006-audit/overview-and-machines.md`, `0006-audit/intake-triage.md`, `0006-audit/plan-build.md`, `0006-audit/verify-evidence.md`, `0006-audit/ship-and-cross-cutting.md`.
