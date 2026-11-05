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
| D11 | Measured default per decision slot | "Jev by default" | **Keep** (decided 2026-11-05), refined the same day: a tie on acted-on accuracy goes to Jev when it qualifies, because it is by far the cheapest engine. |
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
| **11 Sandbox** | The per-card spec, egress allowlist, `env_hash`, a fresh sandbox in Verify and for fixes, preview deploy or start-and-seed, the kept sandbox; every interpolation of ticket and model text in the factory's prompt templates flattened, capped and marked as data (decided 2026-11-05, from the wave 9b security pass); the sandbox works on its own clone, because today a task's worktree shares the repository's git directory and a container can write its refs and objects (found in the wave 10 security pass) | Verify runs on a clone at the head SHA; an `env_hash` mismatch is a blocker finding |
| **11b Code graph** | Every repository's image is its project base plus the machine's layer, which carries the pinned Graphify; the graph build and the stages both run in it; the stamp records the Graphify version and the image, and a mismatch rebuilds. A repository's first graph is built at setup and Plan waits for it (bounded); a failed build is retried once, then shown as an environment problem instead of planning without a map. The graph rebuilds when the monitor sees a merge (the poll stays as a fallback) and when it is stale past `graph.stale_commits` before a map is drawn from it. Declared out-of-map files seed the mapper for that repository. Graph health (commit, version, last build, failures) is on the board | No card plans without a graph unless the repository turned the graph off; the Graphify that queries a graph is the version that built it |
| **12 Verify and Evidence as drawn** | Review before checks; Finding v2 with duplicates merged; one Build round per finding set; findings carried back from e2e and Evidence; reviewer family policy; coverage threshold and mutation hook; per-scenario e2e judge and artifacts; PR body template; CI class as a decision; format labels and terminal capture; narration and recording concurrently; frame check for secrets; publish and mark ready inside Evidence; stale parts regenerated; thumbs | The PR is ready for review with its pack when Evidence passes; misreadings 16 to 22 closed |
| **13 Ship as drawn** | Monitor in `awaiting_ship` with its SLAs; the nine event classes; the read-comment step; `fix_scope` for nits with affected scenarios; text sections regenerated; media refreshed for real; `re_plan` to ③ with context; readiness view; approval after readiness; merge config and merged SHA; `ship.merged`; a closed PR archives; the retro runs in `reviewing_memory` and a "no" closes the card; retro outputs applied | A low-risk card goes from an approved plan to closed with no further click; misreadings 23 to 27 closed |
| **14 Intake and backlog** | `create_card`, the Card fields, the duplicate/related decision and merge, context setup and its gate, the shared ranked backlog and its TUI view | A duplicate report merges into its card; the backlog orders candidates by score |
| **15 Size and stacks** | The size estimate and guard, the decomposition loop and split check, child tickets, `card.base`, stacked PRs, parent events | A ticket over the limit is split into children that ship as a stack |
| **16 Ticket Machine** | Canonical ticket, assignee scope, validity then assessment, WSJF, bot comment, recommendation, drafts behind a tap, ticket → factory events, ticket SLAs, ground truth | Nothing is posted to a ticket without a tap; an edited scope re-assesses the card; misreadings 1 and 2 closed |
| **17 Conversation Machine** | Canonical message, conversation object, debounce, enrichment, typed decisions, relation, weighted priority, the draft with context, expiry, ground truth, outbound to the source thread, scope and quiet rules, the secrets check | A thread about a card in progress attaches to it and gets a status draft; misreadings 3 to 5 closed |
| **18 Evals for what is new** | Cases and baselines for every new decision; weights and bars recalibrated from ground truth; the scorecard rerun. **Gather everything by default** (decided 2026-11-05): full traces for the machine's own calls, every decision record with its context and answer, ground truth from every gate and every correction a person makes, the three decisions that get no automatic truth today, and a retention long enough to learn from, all local; each switch stays in config for a repository that wants less | Every decision pack has a baseline on two engines again; a card that ran end to end leaves a labelled or labelable record for every decision it took |

Wave 11 is delivered as two PRs, with 11b between them: **11a** is isolation (the workspace as a clone, what a container mounts, fresh clones for Verify and for fixes, the environment hash, the sandbox's size, the kept sandbox, and the prompt-template hardening), because the wave 10 security pass found a container can write the repository's refs; **11c** is the egress allow-list, dependencies installed from the lockfile by the machine, the start-and-seed command and preview URL for e2e, and scoped secrets.

Wave 11b was added on 2026-11-05 at the user's request, after wave 11 because it builds on the per-repository image of the sandbox spec. Today the graph is already one per repository and is built and queried inside the machine's own image, so nothing depends on the user's machine; what 11b closes is that a first card can plan before its repository has a graph, that a failed build is silent, and that a per-repository image must carry the same Graphify that built the graph.

**Later, not in these waves: an automatic improvement loop (TBD).** Today the loop is turned by hand: harvest the records, label what has no truth, rerun the baselines, read the scorecard, write the defaults. Wave 18 makes the machine gather everything that loop needs by default. What would close it automatically (a scheduled harvest and re-measure, a proposal to change an engine or a bar when the evidence moves, and the rule for when a person must approve the change) is not designed here. It is to be planned once real cards have produced enough ground truth to say what such a loop should optimise.

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

## Implementation notes (wave 8, 2026-11-05)

Wave 8 landed as one PR on `feat/factory-v2-2-wave-8`, stacked on #184, nine slices. It gives the machine the diagram's vocabulary and changes no route and no default. Where the build differs from the plan above:

- **The schemas are additive, and today's values read as v2.2 through normalisers.** `Scenario` is the same schema `TestCase` was, with the diagram's fields optional (`id`, `criterion_ref`, `type`, given/when/then, `data_needs`, `layer`, `version`); `scenarioOf`, `criteriaOf`, `stepOf` and `planOf` turn a case, a criteria list, a slice and the plan's parts written before this wave into `Scenario`, `Criterion {id, text}`, `PlanStep` and `Plan`. Ids are positional (`S1`, `C1`, `P1`) until wave 9 has the planner and the test designer write them. `Finding` gains an id (a short hash of path, line and title), a category, a criterion, a suggested fix and a resolution; its severity stays a string on the wire and `severityOf` reads it as blocker, should_fix or nit; `mergeDuplicateFindings` keeps the highest severity. `TriageRecord` gains the v2 fields, all optional. Nothing consumes a severity level, a merged finding or a v2 record field for a verdict yet.
- **The entry contract is accepted, not stored.** `NewTaskInput` takes `sources[]`, `reporter`, `hints`, `originMachine` and `attachments[]` and drops them; the card's columns arrive with Intake in wave 14.
- **Reports are assembled, not written by agents.** `buildReportOf` and `verifyReportOf` are pure functions over the stage runs and the logged details; the Build Report rides on the passing `implementing` finish and the Verify Report on the passing `ci_watch` finish, and both are on `GET /tasks/:id`. What the machine cannot know yet is null with its wave named: `envHash` and the environment reproduction (11), a test's before and after and the token count (10), overrides (12). A finding's resolution is inferred: raised by an earlier review and absent from the last one reads as fixed by the implementing run between them, so a finding whose line moved shows as fixed plus a new one.
- **An event name is a name on the fact, not a second row.** `namesOf(event)` derives the diagram's names from a logged event's kind and payload, and `TaskEvent.names` carries them on the stream and in the replay (`GET /events?names=`). Thirty-four of the thirty-five names are produced; `card.merged` waits for the duplicate check of wave 14 and a test fails if a name is neither produced nor listed as pending. Nine facts had no row and got one (`ci.status`, `verify.findings`, `evidence.media_ready`, `evidence.published`, `ship.ready`, `ship.approval_needed`, `ship.event`, `card.fast_lane`, `card.learned`), each with ids, counts and enum values only. `card.planned` and `card.tests_designed` both come from the `test_design` finish, because one run plans and designs the scenarios; `build.paused` and `build.escalated` are read only from a transition out of `implementing`.
- **The scoring model is one pure module.** Priority from five sub-scores with the diagram's weights, each pulled toward the neutral 2 by its confidence, bands of 28, 22 and 16 for P0 to P2 (the diagram gives no cut-offs; these are ours and in config); knock-outs; cost of delay over cost of doing; risk as the product. `riskLevelOf` still sums: wave 9 switches it.
- **Config is defined once and wired where nothing changes.** `FactoryConfig` holds every config block of the diagram with its numbers as defaults, `luna.yaml` accepts the sections, and `CONSUMED_FROM` names the wave that reads each key. Six keys are wired now because today's constant already equalled the default: `plan.coverage_rounds`, `plan.plan_check_retries`, `ship.stale_days`, `verify.env_flake_retries`, `verify.ci_flaky_reruns`, `verify.auto_rebase`. The CI re-run and the rebase act in the ship monitor, the only place that counts them (the CI watch stage is single-shot). `evidence.video_budget_s` is defined but not wired: the 240 seconds live only in the film's prompts and nothing in the machine enforces them (wave 12). Command and template strings are stored and never run or rendered.
- **Flow metrics come from the events.** `Metrics.flow` gives the plan cycle time, coverage rounds, implementer runs, lead time to merge and merges per week through `namesOf`; the change failure rate and the time to restore are null with the reason (nothing records a failed change yet).
- **Security pass.** No blocking finding. Tightened before the PR: the two plan loop caps a repository may set stop at 5 (at 10 each they multiplied to about twelve times today's model runs per task); `ship.stale_days` is 1 to 60, so a repository cannot switch the stale-head blocker off; a stage may emit only four event kinds (`ship.event`, `ship.ready`, `ship.approval_needed`, `evidence.published`), anything else is dropped, and a row logged from a stage can never read as `ship.merged`, `card.closed` or an approval; the flow metrics read only tasks that ended inside the window; the entry contract's strings and lists are capped and an attachment must be an http(s) URL; a severity word the table does not know reads as should_fix, never as a nit, and the table knows `critical`, `high` and `major`; an inferred resolution says so, and a test holds that nothing published carries a local path or the v2 pack fields; the bounds of keys later waves will wire are tightened now (50 build iterations, 20M tokens, 20k LOC, 20 children, depth 3, 365 days).

## Implementation notes (wave 9a, 2026-11-05)

Wave 9 was split in two at its plan gate. Wave 9a, Triage as drawn, landed as one PR on `feat/factory-v2-2-wave-9`, stacked on #186, ten slices. It closes misreadings 7, 8 and 9 and applies D5 at the triage gates, D8 and D12. Wave 9b, Plan as drawn, follows on its own branch. Where the build differs from the plan above:

- **The code graph answers on the host, with no model.** `Graph.locate(repo, text)` is a lexical match of the ticket's words against the graph's labels and paths, with owners from the repo's CODEOWNERS and a confidence from the score margin; `Graph.impact(repo, files)` is the two-hop walk Verify already did, moved behind the port. A graph more than `graph.stale_commits` (50) behind the base is stale. A repo with no graph gets null and every reader says so.
- **The signals are step one of ②, for every source and on every entry.** `triage_signals` stays one call with one schema: kind (now with `task` and `incident`), type of work, size as a five-level choice, five urgency sub-scores, a preliminary risk, an archive suggestion, readiness. The machine turns the sub-scores into P0 to P3 with `scorePriority`; an incident or a security label is P0 first. The goal reference comes from machine facts (a Jira epic link, an id in the text), never from the model. A stored v1 answer (`area`, one urgency score) still reads.
- **The person is asked, not the agent.** Each field is read against its bar (0.80, 0.60, 0.70, 0.85, 0.90) and the 0.15 band under it: at the bar it proceeds, in the band it is flagged on the plan gate, under it the person gets a question that carries the model's guess. Three questions a round and two rounds, counted from the answers already given; the next need escalates. A filer's hints move a field's confidence by half at most.
- **The triage agent is bounded and does not pick the lane.** Twelve turns and five minutes, with one read-only tool, `card_search`, over the cards of the same repository and the same kind of source. It writes a summary, the goal and its decision (`plan`, `conversation` or `archive`). This is still an agent with a tool, not the diagram's single model call: recorded as a deviation.
- **The machine composes the Triage Record and checks it.** `composeRecord` assembles the v2 record from the signals, the agent's part and the answers; `recordComplete` sends an incomplete one round once and then escalates, so no card leaves triage with a null record.
- **The fast lane is a rule.** Low preliminary risk, size S or smaller, a type that is not infra or data, one owning team from `locate`, both signals at proceed. A repo with no graph skips the owners condition and the gate shows `not_checked`; wave 9b checks the owners again from the plan's own files.
- **A conversation ends closed, and the source hears about it.** The reply waits for one tap, is flattened and posted where the card came from, and the card ends `closed`. Questions go to the source as one comment. A card left at `awaiting_setup` or `awaiting_answers` is reminded after two days and archived after five as `no_setup` or `no_answer`; an answer restarts the clock. The two-day reminder now applies to every gate, where it was one hour.
- **Corrections are ground truth.** A person can change the record's kind, type of work, size, risk or priority while the card waits for answers or at the plan gate (`PATCH /tasks/:id/record`, `T` on the board). Each correction, a reply or archive tap, and an approval with no edit writes truth on the `triage_signals` decision record. A priority edit writes none: the model answered five sub-scores, not a level.
- **Defaults and routes that changed:** gate reminders one hour → two days; auto-archive on at five days; the question-versus-ticket bar 0.7 → 0.8; a conversation ends `closed`; new `PATCH /tasks/:id/record`, `POST /tasks/:id/questions/post`, the `task.questions` event, `graph.stale_commits`, the board keys `T` and `p`, the luna tool `card_search`. Each default can be set back in `luna.yaml`.
- **Two security passes, three fix commits.** The first found the board search handing an agent with web access the text of cards from other sources (now the same kind of source only, and no summaries), unbounded mailbox reads, and a fast-lane owners rule that passed when it could not be checked (now shown at the gate). The second found that a question holding a token was posted redacted where it should be refused, and that the agent's own questions left the machine with no person in the loop. **Deviation from the diagram:** only the questions the machine builds from the signals are posted automatically; a question the agent wrote waits for a tap (`p`, `POST /tasks/:id/questions/post`), because model text written after reading an untrusted ticket could quote private repository content. Also fixed: a person can raise the record's risk but the machine's grade stays the floor for the plan, the approvers and Ship; nothing is archived before a reminder at least a day old, so a repo with `sla.gate: off` is never auto-archived; a conversation or archive gate is never auto-approved; outbound comments go to the source's own key. The shared sanitiser now breaks Markdown link, image and reference syntax in every outward text, the evidence section included.
- **The measured default did not move.** Baselines on six cases: claude:haiku passed six with every labelled answer right (Brier 0.089), codex:luna four (0.210), Jev three (0.327). The defaults rule needs an engine to act on 60% of the cases and none does, because the per-field bars put most answers under "ask": the slot keeps Jev as the unmeasured default with claude:haiku as its fallback (confirmed by the user on 2026-11-05). Wave 18 measures triage per field, which is how the machine reads it.
- **Verification.** At ef655f2 on the host: typecheck clean; contracts 343, factory 752, machine 1749, evals 107, site 43 and board 268 passing; `facts` in step; the runner image rebuilt from the branch. Not done: a run of the whole triage stage against a live model (the decision pack was run on three engines; the agent's part is covered by tests with a fake runner).

## Implementation notes (wave 9b, 2026-11-05)

Wave 9b, Plan as drawn, landed as one PR on `feat/factory-v2-2-wave-9b`, stacked on #187, eleven slices. It closes misreadings 10 to 13 and applies D2, D5 at the plan gate, D8 and D13. Where the build differs from the plan above:

- **The plan is written knowing its risk.** The order is code map, risk, plan, scenarios, coverage, plan check. `risk_score` reads the record and the map, not the plan, and gains a `complexity` question. The level is the product of the three levels (4 or less low, 5 to 11 medium, 12 or more high), never below triage's grade. Because the risk is now fixed before the plan, a script reads the plan afterwards: a step that touches the repository's control plane (CI configuration, `CODEOWNERS`, `luna.yaml`, lockfiles) raises the level to high, and step files outside the map are flagged at the gate.
- **The code map names roles.** Each file is `change`, `read` or `test`, with entry points and a stale flag from the graph port. The mapper starts from `locate`'s shortlist. Only `change` and `test` files count as planned for Build's scope check.
- **The planner writes the v2.2 Plan.** Steps carry files, `done_when` and an estimate; criteria get ids; out of scope, migration and flags are kept; the version rises on every revision. A criterion id is never handed out twice. Paths a model names must be plain repository paths: globs, absolute paths and `..` are dropped and the plan check names them. Brackets and parentheses are read literally.
- **Scenarios come from the criteria and the goal**, in given/when/then, each tied to a criterion by id. The designer no longer sees the plan's steps. On the fast lane "one or two scenarios" is an instruction in the prompt, not enforced.
- **Coverage is computed by id**, with a score and the 0.85 bar. The judged part is whether each scenario pins its criterion. A typed decision cannot name a criterion, so a confident "untestable" excuses the criteria that have no scenario: the gate flags it and names them. "Thin" (no edge or failure scenario where the criterion names a limit or an error) is a keyword heuristic.
- **The plan check is a script and two judged questions.** `planFacts` checks that every criterion has a step, every step names a file in the map or declared new, and a rollback is present. The decision is asked only whether the plan fits the record and suits its risk, and never reads the plan's brief. On the fast lane script issues flag the gate; they do not send the fast planner back.
- **The gate takes three decisions.** `changes_requested` is stored as `sent_back`. `rejected` works only at the plan gate, by a person, with a comment (`N` on the board), and archives the card. A high-risk plan needs two names, one outside the owning team. The owners for that rule come from `CODEOWNERS` only, never from a model. It is an attestation and the gate says so; when the owners are team handles the machine cannot check membership and says that too.
- **The machine's risk is a floor at the gate.** A person may raise the level; a lower value is kept with its reason as ground truth and does not apply. A raised level survives a re-plan. Steps, risk, map and rollback can be edited at the plan gate only: once a plan is approved they are refused.
- **The plan gate reminds after two days and escalates after five.** The line posted at the source names nobody. The clock never approves a re-plan or a gate that carries a flag.
- **A wrong plan returns to the planner with its evidence** (D2): `plan_wrong` from Build, Verify or Ship runs the plan stage again, once per card, then a person. The reviewer's thread and the failing output reach the prompt flattened and capped, under a heading marked as data, and the new plan goes through the gate again.
- **The fast lane is as drawn.** `locate` only, one planner run, the same checks, one approver. The owners are checked again from the plan's own files; more than one team leaves the lane.
- **Board columns follow the seven stages** (D13). The API's `column` values change: `Approved` is now `Plan`, and `awaiting_approval` moved from Triage to Plan.
- **Two security passes, five fix commits.** The first (slices 1 to 4) found a criterion id handed out twice after an edit, and that scoring the risk before the plan removed the last thing that let the plan's files raise it: hence the control-plane rule above. The second (slices 5 to 11) found that the outside-approver rule read its owners from the mapper's answer (now `CODEOWNERS` only), that an edit at the test check could rewrite an approved plan's steps, risk and map (now refused), that a raised risk was lost on a re-plan, that the auto-approve clock could approve a re-plan or a flagged gate, that one "untestable" excused every gap unseen, and that the approval rule was read outside the task lock. The host's own read added: a failed `CODEOWNERS` read at approval keeps the owners the gate was opened with; the plain-path rule must allow brackets and parentheses (Next.js routes); the escalation line names nobody outward.
- **Carried forward.** Build's scope check still switches off when a stored plan names no file: wave 10 keeps it on whenever a plan exists (a v2.2 plan cannot reach Build that way, because `planFacts` fails a step with no file). The factory's prompt templates interpolate ticket and model text unflattened outside the fields this wave caps: wave 11 owns that (decided 2026-11-05).
- **The measured defaults kept their engines.** `risk_score` stays on codex:luna, `coverage_check` and `plan_check` on claude:haiku. `risk_score` reads less than it did (the record and the map, no plan) and its best engine was right on two of three labelled cases, where it was right on all three before; four cases are too few to conclude from, and wave 18 adds cases.
- **Verification.** At 416a9a5 on the host: typecheck clean; contracts 398, factory 764, machine 1898, evals 107, site 43 and board 279 passing; `facts` in step; the runner image rebuilt from the branch. Not done: a run of the whole plan stage against live models (each decision pack was run on three engines; the agents' parts are covered by tests with a fake runner). The plan gate for this wave was not shown to the user, who was away: the slice list followed this RFC as approved.

## Implementation notes (wave 10, 2026-11-05)

Wave 10, Build as drawn, landed as one PR on `feat/factory-v2-2-wave-10`, stacked on #188, twelve slices. It closes misreadings 14 and 15 and applies D3 and D7. The plan gate was not shown: the user confirmed on 2026-11-05 that the waves continue without one. Where the build differs from the plan above:

- **Build starts only with what Plan hands it.** `entryContract` is a script over the approved gate: a plan with a version, a scenario for every criterion the gate did not excuse, a code map or the reason there is none, a risk, the Triage Record, at least one planned file. What is missing sends the card back to the planner once, then to a person. A gate approved before this wave is read through wave 8's normalisers; a `plan` object that fails its schema is a missing plan, not a v1 gate.
- **Tests first is its own step, and the machine does not trust it.** A new pack, `build_tests` (role `test-writer`), writes one test per scenario tagged `@scenario:<id>`. It can run the repository's test commands, so it can run any code in its container: holding no commit tool is not a boundary. The machine therefore records the base commit before the writer runs and refuses a HEAD that moved, checks the diff by script (only test files with a source extension and fixtures; no deletion or rename of anything else; no control-plane path; no symlink or nested repository; one tag per line), makes the commit `test(<card>): scenarios` itself, and later trusts only the sha it recorded. With `policy.holdout_cases` the step is skipped.
- **The red check is per scenario and gates the step.** The writer reports each test's failing output through a new tool, the machine supplies "the tag exists", and `red_check` judges the reason. A wrong reason goes back twice, then escalates. "Green" for a scenario means the stage passed with the suite and the sweep green: the machine does not re-run each test by itself.
- **Checkpoints are pushed after the red and after every green**, to `refs/luna/wip/<branch>` (kept, D7), with three retries at 1, 5 and 25 seconds inside the stage's signal. Only a push that landed is a `build.checkpoint` row.
- **Build has a budget per card:** 15 iterations, 2,000,000 tokens, 90 minutes. The minutes are the machine's own clock and hold on every path. Iterations count the machine's own rows as well as the agent's ledger. Tokens come from the runtime's usage and count new work: uncached input, cache writes and output; cache reads are recorded beside the count and kept off it, because a long session re-reads its context every turn. A run that reports no usage leaves tokens uncounted and the gate says so.
- **The regression sweep runs in Build** over the repository's `luna.yaml` checks (a new optional `checks[].minutes` marks a suite that fits the ten-minute rule). A failing check returns to the implementer as context, twice at most. Verify's own sweep is unchanged.
- **The Diff Summary is the implementer's last step, not a separate model call.** Git's facts win over its prose on what changed, what is in the map, dependencies and TODOs.
- **The scope check covers the card's whole change.** It diffs from the machine's tests commit (else the branch's base), not from the run's own start, so a failed run's leftovers cannot hide from the fix pass. Issues have severities; a blocker gets one fix pass and the second scope red escalates `undeclared_scope` by the machine (misreading 15). A scenario test may not change after the tests commit without the existing `test_change` answer, which a person rules on. A scope check that cannot be computed fails closed.
- **Why a card escalated is a typed decision** (`escalation_reason`) with a confidence. A fact decides where one can: a second scope red, an environment that never started. A spent budget goes to the decision, as drawn, because flaky tests and a broken environment spend one too. `too_complex` gets the stronger model once with one fresh budget; `plan_wrong` re-plans once per card; everything else waits for a person, who can correct the reason (`C` on the board) and whose commits after the escalation are recorded as ground truth by name and line count.
- **The Build Report is complete** except `envHash` (wave 11): the base, tokens and minutes, the iteration log, each scenario's test before and after, the Diff Summary, the declared files and the scope result with severities.
- **Three security passes, thirty findings, three fix commits.** What they share: the test writer and the implementer can run any code in their container through the repository's test commands, can write any line into the run's event file, and can move HEAD and any ref. So a missing tool is not a boundary, an event row is not proof the machine wrote it, and a ref is not a fact. The fixes: the tests step lets through only test files and added fixtures, from a base read before the writer ran; the tests commit is trusted again only by ancestry, parent and content; a container's event can never take a kind the machine writes (`machine/src/domain/reserved-kinds.ts`); the scope base comes from the machine's own run records (`stage_runs`), never from a ref or the current run; a branch the container rewrote escalates `head_moved`; scope issue texts, sweep output and report paths are redacted, flattened and capped.
- **The baselines changed a default and found a defect.** `red_check` asked whether a test fails "because the behaviour is missing, not because of a missing import". Tests come first, so a new test fails because the function is not there, and two of three engines read that as a broken import: every such test would have gone back twice and escalated. The question now says code under test that does not exist yet is the behaviour missing. After it, every labelled answer was right on all three engines. Two case labels were corrected, each named in the commit.
- **A tie between engines goes to Jev (the user's decision, 2026-11-05, refining D11).** Jev is by far the cheapest engine, so where it qualifies (it acts on at least 60% of the cases) and is level on acted-on accuracy it is the default, with claude:haiku to fall back on; the five-point margin it needed over claude:haiku is gone. Accuracy still comes first. Under that rule `scope_check`, `escalation_reason`, `evidence_format` and `worth_learning` moved to Jev (`event_class`, `comment_intent` and `triage_signals` were already on it); `red_check` moved from codex:luna to claude:haiku on its own numbers; seven decisions stay on claude:haiku and `risk_score` on codex:luna, because there Jev is behind or acts on too few cases.
- **Carried forward.** To wave 11: a task's worktree shares the repository's git directory and a container can write its refs and objects, so the sandbox must work on a clone; `envHash`; the project image; egress. To wave 12: Verify reading the Build Report's `should_fix` and `nit` scope issues. Not covered by a test: the heuristic that reads a container that could not start as `env_broken`, and the resume path end to end.
- **Also in this PR.** `pnpm eval dataset push --queue` takes the queue's id: a self-hosted Laminar has no route to list queues by name. On eve the budget reads the cached part of the input from `cacheReadTokens`.
- **Verification.** At 00098b2 on the host: typecheck clean; contracts 419, factory 781, machine 2087, evals 109, site 43 and board 286 passing; `facts` in step; the runner image rebuilt from the branch. Not done: a run of the whole Build stage against live models (each decision pack was run on three engines; the agents' parts are covered by tests with a fake runner and real git repositories).

## Implementation notes (wave 11a, 2026-11-05)

Wave 11 is delivered in three PRs. 11a, isolation and prompt hardening, landed on `feat/factory-v2-2-wave-11a`, stacked on #189. Where the build differs from the plan above:

- **The sandbox is two repositories, not a clone.** The first build gave each card an independent clone and ran host-side git in it with `config` and `hooks` sealed. A security review reproduced host code execution through `.git/commondir`, and two ways to swap `.git`. Git documents only serving a fetch as safe against an untrusted repository, so the rule became: the host never runs git in a git directory a container can write. Per card the machine owns a bare repository `M` under its state directory, never mounted, borrowing the user's repository's objects through alternates; the work folder `W` is a checkout whose `.git` is the agent's scratch repository, reseeded by the host before each run and never read. Every host-side git call on a workspace is pinned to `M` and `W`. The user chose this over going back to worktrees, on condition it cost no more than one.
- **Commits cross only as bundles, outward.** The factory writes a bundle at each slice commit and at the end of a run; the host reads it as a bounded regular file opened without blocking, fetches it with fsck on, and accepts it only as a compare-and-swap fast-forward; anything else is `head_moved`. The folder must equal the branch tip when a run ends.
- **No nested repository reaches host git.** A second review found that a gitlink makes `status`, `add` and a work-tree `diff` run a child git inside the nested repository, with its config. The host now walks the work folder before any command that reads it, removes a nested `.git` and fails the run; a bundle or a staged change with a gitlink is refused.
- **Repository commands never run on the host.** With no sandbox executor the checks escalate as an environment problem. A checkout run mounts the repository's git directory read-only.
- **The card's branch is still in the user's repository,** published by the machine as a fast-forward fetch from `M`.
- **Verify and Ship fixes run on a fresh workspace** made from `M` at the head commit; their commits return as a fast-forward. The environment hash is the image id, each lockfile's blob id at the commit and the commit; a mismatch in Verify is a blocker finding of category `env`.
- **Sandbox size: 2 CPUs and 4 GB by default, the user's decision,** a recorded deviation from the diagram's 4 and 8; a repository can set more. An escalated sandbox is kept 24 hours (`sandbox.keep_hours`), its uncommitted work saved on `refs/luna/kept/<run>` in `M`.
- **Prompts quote foreign text.** One helper puts every ticket or model field into a data block that the text cannot end or forge, capped per field and per prompt; a template variable is declared foreign or the machine's own, and an undeclared one throws. The caps are larger where a pack's main input needs it.
- **Carried forward.** To 11b: one image per repository and the code graph. To 11c: the egress allow-list, dependencies installed from the lockfile by the machine, start-and-seed and the preview URL, scoped secrets. Known limits: a nested `.git` inside an installed dependency fails the run; a repository's `sandbox` size and `keep_hours` are not yet read by Verify's check containers and kept fresh folders.
- **Verification.** At 79691b3 on the host: typecheck clean; contracts 420, factory 830, machine 2180 (Postgres-backed tests included), evals 109, site 43, board 287 with its lint, all passing; `facts` in step; the runner image rebuilt from this branch; the sandbox smoke 12 of 12 with a real container, including that neither the repository nor the machine's repository is mounted. Every decision's baseline was rerun on three engines after the prompt change: no default moved.
