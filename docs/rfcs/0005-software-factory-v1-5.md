# RFC 0005 — Software Factory v1.5: typed decisions at every gate, a Plan stage, a video Evidence Pack and a maintenance loop in Ship

- **Author:** Higor Alves
- **Status:** Draft
- **Created:** 2026-11-03
- **Discussion:** (open a PR with this file)
- **Decision deadline:** 2026-11-10
- **Related:** [RFC 0002](./0002-native-agent-runtimes.md) (runtimes, decision packs), [RFC 0003](./0003-upgradable-harness.md) (catalog, evals, rollout), [RFC 0004](./0004-harness-for-luna-notch.md) (the notch owns the ticket, the machine owns the run)
- **Source diagram:** Software Factory, Flow Diagram, Draft v1.5 (eight Mermaid panels: Overview, Intake, Triage, Plan, Build, Verify, Evidence, Ship)

## Summary

The machine runs eight stages with seventeen agent roles and one decision pack. The v1.5 diagram keeps the eight stages and the same task states but puts a typed decision (Jev, or a small model behind a JSON schema with a confidence) in front of every branch the pipeline takes, splits planning from triage, adds a fast lane, a Graphify service, pushed checkpoints during Build, a scope check, a video Evidence Pack, and a maintenance loop that keeps a PR alive until it merges. This RFC maps every node of the diagram onto what exists, names the agents, decision packs and machine code that are missing, and orders the work into seven waves, one PR each. Nothing here changes the stage names or the board columns; it changes what runs between them.

## Goals

- Every branch in the pipeline that the diagram marks purple is a decision pack with typed questions, a confidence and a policy for what to do below it, and runs on `jev` or on `claude:haiku` with the same contract.
- A Triage Record and an Evidence Pack exist as contract schemas on the task, written once and read by every later stage, and shown on the TUI (and on the notch once it connects).
- Build never loses work: every green slice is pushed to the task branch before the next one starts.
- Evidence can be a narrated video for UI changes, produced from the approved scenarios and the e2e recording, checked by a cold critic on another engine, and degraded to screenshots on a second failure.
- A shipped PR is watched until it merges: comments, CI, conflicts and staleness are classified and answered on the task, with human stops at disagreement, freezes and the third round trip.
- Every decision pack has eval cases and a recorded ground truth (what the person changed or overrode), so recalibration is a data job, not a guess.

## Non-goals

- Renaming stages, columns or task states. The notch's `BoardStage` mapping from RFC 0004 stays valid throughout.
- Retiring the TUI's Jira, Slack or PR inbox. RFC 0004 step 7 stays gated on the notch test.
- Making Jev required. Luna works the same without a `TYPESAFE_API_KEY` or `AI_GATEWAY_API_KEY`; the decision slots then run on `claude:haiku`.
- Adopting a third-party video CLI as a dependency of the stage image. Ideas and contracts are borrowed; the renderer is ours.
- Deploys. Ship hands off at merge, as the diagram does.

## Background / Context

### What exists

| Diagram | Today | Where |
|---|---|---|
| ① Intake: sources, card, dedup, context, SLA | `draft` → `setup` → `awaiting_setup` means "propose `luna.yaml`"; Jira intake and Slack triage packs; GitHub issue intake; `issue_classify` decision pack exists but nothing calls it; no duplicate check; SLA clocks only for Jira (`sla.ts`) | `machine/src/application/{intake,jira-intake,slack-inbox}.ts`, `stages/setup.ts`, `contracts/src/packs.ts` |
| ② Triage: Jev signals → policy → LLM triage → Triage Record | One pack (`triage`, opus or codex:sol) reads the ticket and writes criteria, assumptions, slices, questions and its own `confidence`/`risk`; `awaiting_answers`; `minConfidence` is one number per decision pack | `factory/roles/triage-planner`, `TriageAnswer` |
| ③ Plan: Graphify service, code-map, risk, plan, scenarios, coverage check, independent plan check, one approval, ground truth | Planning happens inside `triage`; `test_design` (sonnet) designs cases after approval; two human gates (`awaiting_approval`, `awaiting_test_check`); `code-discovery` skill queries Graphify inside the container with grep fallback; no risk score, no coverage or plan check, no ground truth | `transition.ts`, `factory/roles/test-designer`, `factory/plugin/skills/code-discovery` |
| ④ Build: red check, checkpoints, scope check, typed escalation, Opus one shot | `implementing` (sonnet, 80 turns) does red → green per slice on the ledger, commits locally; `deliver` pushes once, later; escalation is free text with options; `fail` retries the stage; `paused_rate_limit` exists | `factory/roles/implementer`, `stages/deliver.ts`, `core/guards.ts` |
| ⑤ Verify: independent review, findings classified, coverage delta, E2E judged per step, failure cause, auto-rebase, CI class | `verifying` (opus, with a `second-opinion` helper on codex:sol) writes tests, runs checks, reviews; `e2e` (qa-validator, sonnet) drives the app and writes `qa-manifest.json`; `deliver` opens a draft PR; `ci_watch` classifies a red run and re-runs a flake once; loops back to `implementing` with retry counters | `stages/{verify,e2e,deliver,ci}.ts` |
| ⑥ Evidence: format decision, video pipeline, Evidence Pack, media store, publish, completeness | A host script lists the e2e packet and shows three thumbnails in the ship approval; the video is the raw screen recording when `ffmpeg` is present; `ship` marks the PR ready | `stages/evidence.ts`, `stages/ship.ts` |
| ⑦ Ship: monitor, maintenance loop, merge readiness, auto-merge by risk, close the loop, retro | `awaiting_ship` is one human gate, then `shipping` marks the PR ready and `reviewing_memory` proposes rules; review comments on the person's PRs are handled by separate PR tasks (`review`, `address`, `ci_fix` routes), not by the originating task | `stages/{ship,memory,pr-review,pr-address}.ts`, `pr-tasks.ts` |

### Two facts that shape the design

**A decision pack answers three kinds of question** (`contracts/src/questions.ts`): a `choice` among fixed labels, a `yesno` with a probability, a `score` on a rubric. It cannot emit a list, a path, a file name or a sentence. Several purple nodes in the diagram ask for exactly that: "duplicate_of", "components · files · owners", "gaps · redundant · untestable", "undeclared files outside code-map". Each of those is either an agent pack on `claude:haiku` with a structured answer, or a decision pack whose `choice` labels are built per call from candidates the machine already has (the open tasks, the plan's criteria). This RFC says which, node by node.

**Today the TUI and the machine own the ticket.** Tickets reach the machine from its own loops (the Slack inbox, Jira intake, GitHub issue intake) or by hand from the TUI, and the machine talks to the source about them. RFC 0004 moves that ownership to the notch for `source.kind: notch` tasks once the two are tested together; until then every Intake source and every "close the loop with the source" in this RFC is the machine's. The design keeps that boundary as one switch: who posts is decided by `source.kind`, so the notch's turn adds a case, not a rewrite. The machine always owns dedup against its own tasks, the SLA clocks on its gates, and the archive.

## Proposed design

### Three rules for typed decisions

1. **Any engine, same contract.** A decision pack's `engines` gains `allowed` and `fallback` like an agent pack: `{ default: "jev", allowed: ["jev", "claude:haiku", "codex:luna"], fallback: ["claude:haiku"] }`. The `claude` and `eve` runtimes get a `decide()` path: the questions rendered as a prompt, the pack's `answerSchema` as the structured output, one turn, no tools. The confidence is then self-reported; the diagram's note holds: same contract, same gates, only calibration quality differs. Without a Jev credential the machine picks the fallback, so a factory with Claude alone runs every slot.
2. **Confidence policy is data.** `minConfidence` becomes a `policy` per question: `{ proceed: 0.85, flag: 0.6 }`. At or above `proceed` the answer is acted on; between, it is acted on and shown to the approver as flagged; below, the task waits for a person (or, where the diagram says so, the agent path runs). The defaults live in `contracts/src/packs.ts`; `luna.yaml` `policy.decisions.<pack>.<question>` overrides them per repo.
3. **Lists are not decisions.** An answer that names things is an agent pack (`kind: "agent"`, `claude:haiku`, `effort: "low"`, `maxTurns` ≤ 8, read-only) or a decision with per-call labels (`criteria` built from the stage input by a `labels(input)` function on the pack). The eval runner records both the same way.

### New contract schemas

- **`TriageRecord`** on the task (`task.record`), written by ② and read by ③ to ⑦: `source`, `kind`, `goal`, `size`, `urgency`, `risk`, the decision answers with their confidences, the Q&A, `decision` and `reason`. The existing `TriageAnswer` fields (criteria, assumptions, slices) move to the plan; the record keeps what later stages need to judge against.
- **`EvidencePack`** (`task.evidence`): `summary`, `scenarios[]` each with the test and result that proves it, `findings[]` with resolutions, `outOfMap[]`, `risk`, `rollback`, `howToVerify` (preview URL or steps), `commitSha`, `media[]` (kind, label, URL), `format` (`video | captures | text`). Its `commitSha` must equal the PR head for Ship to proceed; a change of head invalidates it.
- **`EscalationReason`** enum: `plan_wrong | env_broken | flaky_tests | too_complex | undeclared_scope | other`, on every `escalated` answer. The transition engine routes `plan_wrong` to triage, `too_complex` to one retry on `claude:opus`, the rest to a person.
- **`archived`** task state, a sibling of `closed`, with `archiveReason` (`duplicate | sla_expired | rejected | not_for_agent | pr_closed`). The board shows it in Done, dimmed.
- **SLA clocks on gates**: `sla.ts` generalised from Jira tickets to `awaiting_*` states, with `luna.yaml` `sla.gate` (reminder) and `sla.archive` (auto-archive) durations; the ticker posts the reminder as a task event, which the TUI shows and posts to the source (and the notch shows, later).

### Stage by stage

**① Intake.** New decision pack `intake_dedup` (per-call labels: the open and last-30-days-closed tasks of the repo plus `none`; questions `duplicate_of` choice, `related_to` choice, each with confidence). Runs on `POST /tasks` for every source; a confident duplicate merges (links the source, archives the new task as `duplicate`) and the client is told with a 200 naming the kept task. Context setup is machine code: repo map, reporter, thread history already arrive in the work order. `setup` keeps its meaning (propose `luna.yaml`). `awaiting_setup` gets the SLA clocks.

**② Triage.** `issue_classify` is renamed `triage_signals` and extended: `kind`, `area`, `size`, `ready`, plus `urgency` (score), `risk` (score), `archive` (yesno with a `reason` choice: duplicate, out_of_scope, stale, not_actionable). Intake calls it before the triage agent; its answers and confidences enter the prompt and the Triage Record. The `triage-planner` role shrinks to what the diagram calls the triage agent: clarify, ask at most three questions, settle defaults, write the Triage Record and pick the outcome (`plan | fast_lane | conversation | archive`). A `conversation` outcome runs the `reply-drafter` role with a new template `triage_reply.md` and closes the task; the machine posts the reply to the source thread (Slack, Jira or the GitHub issue) through its adapters, and a future notch client posts instead for its own tasks. `fast_lane` requires `risk` low and `size` ≤ small from `triage_signals`, both at or above `proceed`.

**③ Plan.** A new agent role `planner` (opus or codex:sol) takes the Triage Record, the code-map and the risk and writes the plan: criteria, slices, assumptions, rollback. `test-designer` stays and becomes the second step of the same stage run (the stage returns both). Three decision packs follow: `coverage_check` (per-call labels: the criteria; one `yesno` per criterion "a scenario pins this" plus a `score` for redundancy; at most three rounds back to `test-designer`), `plan_check` (independent: `score` plan-vs-record, `yesno` touchpoints consistent with code-map, `yesno` rollback stated; at most two rounds back to `planner`), and `risk_score` (three `score` questions, blast radius, reversibility, data sensitivity, each 1–3; the level is derived in contracts, never asked). The two human gates become one: `awaiting_approval` after scenarios and checks; `awaiting_test_check` stays in the state enum for compatibility and is skipped by the feature route. High risk asks for a second approver (the TUI asks for a second approver's name; the notch's Inbox shows two Approve buttons once it connects). **Ground truth**: on approval the machine stores the diff between the proposed and approved plan and the list of flagged decisions the person overrode under `evals/<pack>/ground-truth/`, scrubbed as the eval cases are. The fast lane runs a `fast-planner` role (sonnet, low effort, 15 turns, one to three steps), then `test-designer` at low effort (one or two scenarios, 15 turns), then `plan_check` only, then the single approval; `plan_check` below `flag` sends it to the full path. Test design is never skipped: a scenario is what Build's red check and Verify's e2e run against, so a lane without one would have nothing to prove.

**Graphify as a shared service.** A `Graphify` port in `machine/src/application/graphify.ts` and an adapter in `machine/src/adapters/graphify/` build the graph per repo on merge to the default branch (the intake poller already sees merges), stamp it with the commit, and mount it read-only into every stage container at `/graph`. The `code-discovery` skill queries `/graph` first, as it does today, and falls back to grep when the stamp is older than the base commit. A new agent pack `code_map` (haiku, low, read-only, Graphify only) answers `components[]`, `files[]`, `owners[]` from CODEOWNERS, `confidence`. Build's declared out-of-map files are appended to a per-repo `graph-misses.jsonl` the rebuild reads.

**④ Build.** The `implementer` keeps red → green per slice on the ledger. Three additions: after each red, `red_check` (decision: per-slice `yesno` "the failure is for the right reason", `yesno` "no tautological test", from the test output the runner captures); after each green commit, a **checkpoint push** by the machine (the `deliver` push code runs when the ledger marks a slice `committed`; no PR yet); before the stage ends, the implementer's answer gains `diffSummary` and `outOfMap[]` (path and reason), and `scope_check` (decision: `yesno` only planned files or declared, `yesno` no new dependency, `yesno` no secret or PII in the diff, `yesno` no test skipped or deleted, `yesno` no TODO left; a red one gives the implementer one fix pass). A **regression sweep** runs as a script step inside `verifying`'s container: the importers of touched symbols from `/graph`, then the full suite when `luna.yaml` says it fits ten minutes, then lint, type and format checks. Escalations carry the typed `EscalationReason`; `too_complex` re-runs the stage once on `claude:opus` (the `fallback` mechanism with a new trigger) before the person is asked.

**⑤ Verify.** The `verifier` keeps the second opinion. Additions: a **coverage delta** on touched files when `luna.yaml` `checks[].coverage` names a report path (a script step, numbers into the answer, a drop is a `should_fix` finding); `finding_classify` (decision, `choice` blocker/should_fix/nit per finding, used to calibrate the verifier's own severities, not to override them); `e2e_failure_cause` (decision: `choice` product_bug/test_bug/env_flake; env_flake re-runs e2e once, then a person); `deliver` rebases once on a conflict before opening the PR and `ci_watch` once more on `conflict`; `ci-investigator` gains `conflict_unresolvable`. The qa-validator drives the approved Given/When/Then scenarios, not the raw criteria, and records one chapter per scenario; the manifest row per scenario is what Evidence reads.

**⑥ Evidence.** `evidence` becomes an agent stage with a script prelude. `evidence_format` (decision: `choice` video/captures/text with reasons as labels, from the Triage Record's `kind` and `area`, whether e2e ran, whether a web surface exists). Text and captures assemble the Evidence Pack from upstream and stop. Video runs the pipeline below, then `video_qa`, then the pack. The pack is published by the machine as a PR description section and one PR comment, media stored as GitHub release assets on a `luna-evidence` pre-release tag (never in git), a local copy under `<stateDir>/evidence/<task>/<sha>/`, retention from `luna.yaml`. `pack_complete` is a script: sections present, `commitSha` equals the PR head, every link resolves. A head change after this point sends the task back to `evidence` with `format` kept.

**⑦ Ship.** `awaiting_ship` becomes a monitored wait. A PR monitor (the `pulls.ts` poller, scoped to the task's PR) raises events: CI, base moved, conflict, review comment, freeze window from `luna.yaml` `freeze[]`, blocked by another PR. `event_class` (decision), then for a comment `comment_intent` (decision: question/nit/change_request/disagreement) and `fix_scope` (decision: in_place/re_verify_partial/re_plan). The existing `addressing` pack runs the fix in place with the Evidence Pack in its input, capped at two round trips per thread; `re_verify_partial` runs `verifying` on the delta; `re_plan` sends the task to triage with the record. `evidence_valid` (decision: valid/refresh_text/refresh_media) decides whether the pack is rewritten, and only a changed scenario outcome refreshes media. **Merge readiness** is a script: CI green on head, no conflict, CODEOWNERS approvals present, evidence `commitSha` equals head, no freeze, not blocked, head younger than fourteen days. Low and medium risk auto-merge (squash, merge queue when the repo has one) when `luna.yaml` `policy.auto_merge` allows it; high risk waits for a ship approver who is not the plan approver. Close the loop: the machine's Slack, Jira and GitHub adapters post what shipped, the evidence link and how to verify to the thread or issue the task came from; a `task.shipped` event carries the same summary so a future notch client can post instead for its tasks. `reviewing_memory` starts with `worth_learning` (decision, `yesno`); the `retro-reviewer` answer gains `recalibration[]` (predicted vs actual size, risk, iterations, escalations, format), `graphMisses[]` and `promptUpdates[]`.

### The video pipeline

The diagram's two parallel agents and the deterministic compose are kept. The design borrows from the six reference repositories the way they borrow from each other: narration first, word-level timing, one named-beat timeline, scenes as pure functions of time, stills before render, measured QA on the file, a cold critic, one bounded fix round.

**Packs and roles.**

| Pack | Role | Engine | Does | Answer |
|---|---|---|---|---|
| `video_script` | `video-director` | `claude:sonnet`, medium | Reads the approved scenarios, the Triage Record and the Evidence Pack facts (never the diff). Writes `script.md` (one scene per approved scenario, 8–18 word sentences, terms defined once, 45–120 s total, `{shown|spoken}` for identifiers) and `timeline.json` (scenes, beats, reads, captions, a `FACTS` table where every number on screen cites a QA artifact). Decides the dials: clock = voice, continuity = chaptered, text policy = in-world captions. | `{ script, timeline, facts[], durationEstimateS }` |
| `narration` (Agent A) | script, no model | runner-qa image | kokoro-js renders each scene's text to WAV (content-hashed and cached), whisper word timestamps replace `ESTIMATED` reads, loudness to −14 LUFS. Intro and chapter cards are rendered from `timeline.json` by our own time-driven canvas page (`seek(t)`, `DUR`, `FPS`, `READY`, no `Date.now()`), frame by frame through Playwright. | files under `/out/files/video/narration/` |
| `recording` (Agent B) | `demo-recorder` | `claude:sonnet`, medium | Turns the approved Playwright steps the e2e stage already ran into a demo script with a `narration` fixture: `startRecording`, `mark(scene)` at each scene, `durationFor(scene)` for holds taken from the TTS clip lengths, highlight and cursor overlays injected through `page.evaluate` after a no-op evaluate flushes renders, captions from `timeline.json`. Runs it against the same QA target; writes `.timing.json`. | `{ timing, recordingPath, scenesRecorded[] }` |
| `compose` | script, no model | runner-qa image | ffmpeg: cards + recording cut at marks, narration aligned at marks with 100 ms gaps, captions burned from word timings, chapters, `.srt`/`.vtt`, cover, `meta.json` provenance (engines, voices, resolution, commit SHA). Hard cap four minutes. | `walkthrough.mp4` and sidecars |
| `video_qa` | `video-critic` | `codex:sol` default, `claude:haiku` fallback (another engine than the writer, as `verifying` already does) | Gets the contact sheet (one frame per scene, plus frame 0 and the end card), the transcript from ASR of the final audio, `timeline.json` and the scenario list. States the film's message from the frames alone, then checks: every approved scenario present, duration within budget, audio present and ASR matches the script, no secret or PII on screen, hook text ≥ 84 px and captions ≥ 48 px at 1080, no single-frame pops (frame diff spike over three times both neighbours), no dead stretch over four seconds. Scores clarity, readability, truth and sync 1–10, lists P0/P1/P2 defects with a timestamp and a measurable fix, answers ship or one more pass. | `{ verdict, scores, defects[], weakestScene }` |
| `video_fix` | `video-director` | `claude:sonnet` | One fix round, bounded by the critic's fix cards ("change only scene N"); re-render only the scenes named; the compose step proves frames outside the scope are identical. A second `fail` degrades the format to captures. | the same as `video_script` |

Machine-side numeric checks run before the critic sees the file (loudness, true peak, black frames, silence, duration, frame-0 not empty, caption safe area): they are cheap and never wrong about what they measure, and they let the critic spend its turns on meaning.

**Tooling decisions.** The stage image already carries Chromium, ffmpeg and agent-browser. It gains kokoro-js with the English voice pack, whisper-cpp for word timestamps, and our own small canvas scene page for cards and animated diagrams (time-driven, `seek(t)`, seeded randomness, a stable `data-id` per element so a critic's note can name it). Nothing from the reference repositories is installed in the image: explainroo carries a watermark and 400 MB of models by default, huashu-motion is macOS-only with a bundled GSAP licence, argo is an npm package whose fixture is forty lines we can write against our Playwright. What is borrowed is contract and prompt material: argo's fixture API and `.scenes.json` manifest shape, video-director's `timeline.json` fields, FACTS rule, fix card and critic rubric, explainroo's narration rules and `script.md` syntax, huashu-motion's frame-anchored comment schema for the preview gate, reanimate's rule that thresholds are never relaxed silently.

**The preview gate.** The TUI's Evidence approval (and the notch's Inbox once RFC 0004 lands) shows the walkthrough with the critic's verdict and scores. A person's note at this gate is structured like huashu-motion's: time, scene id, element id, text. It becomes a fix card for `video_fix` or, with "Looks right", the pack is published.

### Who talks to the source

Today every row is the machine's, driven from the TUI. The right column is what changes for `source.kind: notch` tasks once RFC 0004's test together has happened; nothing in this RFC depends on it.

| Node | Today (TUI → machine) | Later (notch task, RFC 0004) |
|---|---|---|
| Intake sources, card created | Slack inbox, Jira intake, GitHub issues, the TUI by hand | the notch, `POST /tasks` |
| `intake_dedup` | the machine, against its tasks; the 200 names the kept task | the machine, the same |
| SLA reminders and auto-archive | the machine posts them where the task came from and shows them on the TUI | the machine emits `task.sla` events; the notch shows them |
| Conversation reply, close the loop | the machine drafts and posts | the machine drafts; the notch posts |
| Approvals, second approver, ship approver | the TUI; a named second approver | the notch's Inbox or the TUI; the first answer wins (409 for the other) |

### Migration

Each wave is one PR, its own `/orc:flow` with a failing test first and one commit per slice. A wave is over the 300-line budget by design: its slices only make sense reviewed together, so each PR carries a `Size-budget-override:` trailer naming this RFC. A wave's exit criterion is written beside it; a later wave never starts on a repo before the earlier one's criterion holds there.

| Wave | Work | Unblocks | Exit criterion |
|---|---|---|---|
| **0 Foundations** | decision packs on any engine with `decide()` in the `claude` and `eve` runtimes; confidence policy as data; `TriageRecord`, `EvidencePack`, `EscalationReason`, `archived`; SLA clocks on gates; conformance rows for `decide()` | everything below | `issue_classify` runs on `claude:haiku` with the same eval cases passing; a task can be archived with a reason from the TUI |
| **1 Triage and Plan** | `triage_signals` wired into intake; `triage-planner` writes the Triage Record; `planner` and `fast-planner` roles; `risk_score`, `coverage_check`, `plan_check`; one approval gate; second approver on high risk; ground-truth capture | waves 3 to 6 | a ticket reaches Build with a record, a plan, scenarios, a risk level and one approval; a low-risk small ticket takes the fast lane with a lightweight plan and low-effort test design |
| **2 Graphify service** | port and adapter; build on merge; `/graph` mount; `code_map` pack; graph misses file | 3, 4 | `code-discovery` finds the graph stamped at the base commit in every stage container |
| **3 Build** | checkpoint push on `committed`; `red_check`; `scope_check` and `outOfMap[]`; regression sweep; typed escalation routing and the Opus one shot | 6 | a killed Build container leaves every green slice on the remote branch; an undeclared out-of-map file is caught before Verify |
| **4 Verify** | coverage delta; `finding_classify`; `e2e_failure_cause`; rebase once; scenario-driven e2e with chapters | 5 | the manifest has one row and one chapter per approved scenario |
| **5 Evidence and video** | `evidence_format`; Evidence Pack assembly and publish; media store; `pack_complete`; `video_script`, `narration`, `recording`, `compose`, `video_qa`, `video_fix`; image additions | 6 | a UI ticket ships with a narrated walkthrough under four minutes that the critic passed, and the PR body carries the pack |
| **6 Ship** | PR monitor; `event_class`, `comment_intent`, `fix_scope`, `evidence_valid`; `addressing` on the originating task; partial re-verify; merge readiness; auto-merge by risk; ship approver; `task.shipped` event; retro extensions | 7 | a low-risk PR merges with no click after CI; a reviewer's question is answered from the pack within one poll interval |
| **7 Evals and calibration** | eval cases for every decision pack from recorded runs and ground truth; baselines per engine; the Jev-vs-haiku scorecard that decides each slot's default | RFC 0003 §3 rollout | every decision pack has a baseline on two engines and a documented default |

Three tracks run in parallel after wave 0: **A** (waves 1, 3, 4, 6, the pipeline's judgement), **B** (wave 5, the video pipeline, which needs only wave 0's Evidence Pack and today's e2e output to start), **C** (wave 2, Graphify, which only wave 3's sweep and `code_map` wait for). Wave 7 trails each pack as it lands.

## Alternatives considered

### Keep decisions Jev-only and skip the slots when the key is absent

Rejected: CLAUDE.md makes Jev opt-in and Luna must work the same without it; a pipeline whose gates vanish without a metered key would behave differently per machine, which is the bug RFC 0003 exists to prevent.

### Keep planning inside triage, add the checks around it

Rejected: the diagram's independent plan check scores the plan against the Triage Record, which only exists if triage ends before planning begins. One pack writing both the record and the plan would be checking itself.

### Install explainroo or huashu-motion in the stage image and prompt the agents to use them

Rejected for the image, kept for the ideas: both are days old, one is macOS-only, both carry defaults we would have to turn off in every run (watermark, signature), and their scene APIs would become a dependency every pack prompt names. The pieces we need (a fixture with marks, kokoro-js, whisper timestamps, an ffmpeg compose, a canvas page with `seek(t)`) are small enough to own, and owning them keeps the determinism rule enforceable.

### Rewrite the transition engine for the new graph in one PR

Rejected: the state enum does not change, so every edge can land as its own small PR with its own test, and the notch's card mapping never breaks mid-migration.

### Keep doing what we do

The pipeline ships tickets today. What it lacks is calibrated judgement at the branches (so every gate needs a person or a guess), evidence a reviewer can watch, and a PR that survives its first review comment without a new task. Those are the three things the diagram adds; the rest is the wiring they need.

## Open questions

- Q1: Where do the two approvers' identities come from on the TUI, which has one operator? Preferred: a `LUNA_APPROVER` name per TUI instance; the notch has accounts.
- Q2: Is a GitHub pre-release the right media store for a private repo, or a bucket named in `luna.yaml`? Preferred: release assets first, a `media.store` port so a bucket adapter is one file.
- Q3: Does the video critic need to see frames (vision) or is the contact sheet plus ASR transcript enough? Preferred: frames; `codex:sol` and `claude:haiku` both take images, so the pack stays on two engines.
- Q4: Should ground truth be captured for agent answers too (the edited plan) or only for decision answers? Preferred: both; the plan diff is the planner's eval case.

Settled while drafting: the fast lane runs `test-designer` at low effort rather than skipping it (decided 2026-11-03), and each wave ships as one PR (decided 2026-11-03).

## Risks & unknowns

- **Slot count.** Sixteen decision slots at one turn each add latency per task; most are sub-second on Jev, a few seconds on haiku. Measured in wave 7; a slot whose eval shows no lift over the agent's own judgement is removed, not kept for symmetry.
- **Self-reported confidence** on `claude:haiku` may cluster high. The policy thresholds per engine come from the baselines, not from one number.
- **Video flakiness.** Recording and narration are two containers against one QA target; a target that is not re-entrant (seeded data consumed by the first run) breaks the second. `qa-targets` gains a `reentrant: false` flag that serialises them.
- **Auto-merge.** A wrong `risk_score` merges unreviewed code. `policy.auto_merge` defaults to off per repo and needs CODEOWNERS approvals even when on.
- **Container size.** kokoro-js and whisper-cpp add several hundred megabytes to `runner-qa`; they go into a `runner-video` image that only the video packs use.

## Success criteria

Three months after wave 6 lands on a repo:

- Every pipeline branch the diagram marks purple is a decision pack with a baseline on two engines; no `minConfidence` constant remains.
- A low-risk small ticket goes from Start to merged with two clicks (Approve, Looks right) and none for the merge.
- UI tickets ship with a walkthrough the critic passed on the first or second round in at least four of five cases; the fifth degrades to captures, never to nothing.
- No green slice is ever lost to a killed container (checkpoint pushes measured by the ledger).
- The reviewer-comment loop answers or fixes without a new task in at least three of four threads; the fourth stops at a person with the thread quoted.
- The notch's card mapping from RFC 0004 is unchanged.

## Appendix: decision packs

| Pack | Stage | Questions | Policy below `proceed` |
|---|---|---|---|
| `intake_dedup` | ① | `duplicate_of` choice (per-call labels + none), `related_to` choice | create the task, flag the candidate |
| `triage_signals` | ② | `kind`, `area`, `size`, `ready` (from `issue_classify`), `urgency` score, `risk` score, `archive` yesno + `archive_reason` choice | the triage agent decides, flagged |
| `risk_score` | ③ | `blast_radius`, `reversibility`, `data_sensitivity` scores 1–3 | level High |
| `coverage_check` | ③ | one yesno per criterion, `redundancy` score | one more test-design round, then a person |
| `plan_check` | ③ | `fits_record` score, `touchpoints_in_map` yesno, `rollback_stated` yesno | one more planner round, then a person |
| `red_check` | ④ | `right_reason` yesno, `not_tautological` yesno per slice | the implementer rewrites the test |
| `scope_check` | ④ | five yesno (planned or declared, no new dep, no secret, no test removed, no TODO) | one fix pass, then escalate `undeclared_scope` |
| `escalation_reason` | ④ | `reason` choice | `other`, a person |
| `finding_classify` | ⑤ | `severity` choice per finding | keep the verifier's severity |
| `e2e_failure_cause` | ⑤ | `cause` choice | treat as `product_bug` |
| `evidence_format` | ⑥ | `format` choice | `captures` |
| `event_class` | ⑦ | `event` choice | a person |
| `comment_intent` | ⑦ | `intent` choice | `change_request` |
| `fix_scope` | ⑦ | `scope` choice | `re_verify_partial` |
| `evidence_valid` | ⑦ | `validity` choice | `refresh_text` |
| `worth_learning` | ⑦ | `worth` yesno | run the retro |

Agent packs that answer with lists: `code_map` (③), `video_script`, `recording`, `video_qa`, `video_fix` (⑥). Scripts with no model: `narration`, `compose`, `pack_complete`, merge readiness, the regression sweep, the coverage delta.
