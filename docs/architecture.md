# Architecture

## Pipeline

Every ticket moves through these stages, from Intake (not ready yet) to Done:

1. **Intake**: a ticket you're still shaping. Nothing runs until you start it.
2. **Triage**: an agent reads the ticket and the repo, asks questions if needed, and proposes a plan.
3. **Build**: the implementer agent writes the change on a task branch (a git worktree on the host).
4. **Verify**: runs the project's own checks, then the review pack.
5. **E2E and Evidence**: for a repo with a web surface, a QA agent drives the app in a browser (the `runner-qa` image) and writes a manifest, screenshots and video; repos with none skip with a recorded reason. Evidence then checks the manifest on the host and shows its verdict, artifact count and a few screenshot paths in the ship approval.
6. **Deliver**: pushes the branch with git and opens a draft PR through the GitHub API, so CI starts early. Its body follows the caveman-pr shape (a one-line what, terse why bullets) and adds `Closes #N` when the ticket came from a GitHub issue in the same repo.
7. **CI watch**: polls the PR's checks until they settle, outside the stage pool (polling computes nothing, so its slot goes to the queue meanwhile). A red run goes to the `ci_watch` pack: a fixable failure loops back to Build with its findings, a flake is re-run once, and infra or needs-debug failures escalate.
8. **Ship**: marks the draft PR ready for review (it opens a ready PR only if Deliver never did), then you review before closing it. After a passing Ship, a read-only memory review (the `reviewing_memory` pack) looks at the task's slice ledger, its runs and `git log` and proposes rules for `docs/agents/project-context.md`; the last gate shows them, `a` commits them to the task branch (refused above 150 lines / 6 KB, pushed only if the branch has an upstream) and `A` skips them.

Triage and Build run stage packs (see [Factory mode](#factory-mode)) when a credential and the runner image are available. Deliver and Ship run for real too — they are plain host commands (`git push` + `gh pr create --draft` / `gh pr ready`), not Claude agents — as soon as a task has a branch. CI watch polls on the host and runs its pack only for a red check. Evidence runs on the host. Intake, Done and any stage without a runner are stubs that pass, unless you queue a result with `POST /dev/stubs`. Full route list: [api.md](./api.md).

The machine is one service for every repo you point a task at, not one per repo: `MACHINE_MAX_CONCURRENT` (default 4) caps how many tasks can be driving a stage at once *in total*, across all of them, not per repo. Each repo can still speak for itself through a `PIPELINE.md` at its root (QA on or off, a monthly budget, a concurrency cap, timer-approved plans, held-out test cases; see [configuration](configuration.md)), and `/metrics?groupBy=repo` tells the repos apart. A task past that cap is `queued` until a slot frees — durably, in Postgres, so a restart doesn't lose track of it. Open as many boards as you like, from any workspace: they're all clients of this one machine and see the same tasks and the same queue.

## Board columns from task state

| Column | Task states |
|---|---|
| Intake | `draft`, `setup`, `awaiting_setup` |
| Triage | `triage`, `awaiting_answers`, `awaiting_approval` |
| Approved | `test_design`, `awaiting_test_check` |
| Build | `implementing`, `escalated`, `paused_rate_limit` |
| Verify | `verifying`, `e2e`, `delivering`, `ci_watch` |
| Evidence | `evidence` |
| Ship | `awaiting_ship`, `shipping`, `reviewing_memory` |
| Done | `closed` |

A task on a repo with no `luna.yaml` runs the `setup` stage first: the setup pack reads the checkout read-only and proposes the file, the machine proves every proposed check once with the proposed services beside it, and the `awaiting_setup` gate shows you the file and the proof. Approving writes `luna.yaml` into the checkout and the task goes on to triage; a `:setup <repo>` task (route `setup`) closes instead. Sending it back with a note re-runs setup with the note as guidance. See [configuration](configuration.md).

The card states the board already shows map from the same data: a waiting gate is "needs you", a running stage is "working", `escalated` and an aborted run are "lost". Source of truth: `COLUMNS` and `COLUMN_OF` in `contracts/src/index.ts`.

## PR tasks

The board's `P` view lists every open PR involving you (the machine polls `gh search prs --review-requested=@me` and `--author=@me`, then one GraphQL call per PR) and splits them by what you do about them: Review requested, Ready to merge, CI failed, CI running, Changes requested, Mine. `m` merges a ready PR; `c`, `v` and `t` turn a PR into a **PR task**: a task whose `source.kind` is `github_pr` and whose `route` is `ci_fix`, `review` or `address`. The transition engine switches on the route first, so a PR task walks a short graph built from the same stages:

| Route | Graph |
|---|---|
| `ci_fix` | `ci_watch` → closed on green; on red the ci-investigator pack runs and a fixable verdict goes `implementing` → `verifying` (the project's checks only, no review pack) → `delivering` (a push to the PR's branch) → `ci_watch` again, three strikes as today |
| `review` | `reviewing`: the host fetches the diff, files and existing comments; the `pr-reviewer` role answers line-anchored comments and a verdict per `inline-review`, dispatching the `security-reviewer` helper when the diff touches a sensitive path; the host posts one COMMENT review at once. A `comment` verdict closes; `approve` / `request_changes` wait at the Ship gate (`a` posts it, `r` drops it) |
| `address` | `addressing`: the host fetches the unresolved review threads; the `code-fixer` role categorizes each per `receiving-code-review` (action, question, nitpick, disagree), commits the fixes and has the `reply-drafter` helper write each reply; then `verifying` (checks only), then the follow-up `delivering` pushes, posts the replies and resolves the threads it marked, then `ci_watch` as in `ci_fix` |

A PR task's worktree is checked out on the PR's own head branch (`<worktrees>/<repo>/pr-<n>-<branch>`), and that branch is the one its stages may commit to. Agents never hold a GitHub credential: everything they read about the PR comes in the stage input, everything that goes out is posted by the host after the stage. A PR from a fork can be reviewed but not fixed or addressed; a PR in a repo with no local checkout is read-only until the board clones it (`POST /github/clone`).

## Slack inbox

The board's `S` view is the Slack twin of the PR inbox. `SlackInbox` (`application/slack-inbox.ts`) polls your workspace through the `Slack` port (`application/slack.ts`, implemented over plain `fetch` in `adapters/slack/web-api.ts` with your user token from the internal app in `slack/manifest.json`): mentions through `search.messages`, DMs and a budgeted sweep of your channels through `conversations.history`, replies in threads you are in through `conversations.replies`, and reactions pushed over Socket Mode (`adapters/slack/socket-mode.ts`, Node's own WebSocket, when an app-level token is set). Several mentions in one thread fold into one item (`domain/slack-item.ts`); the rules file (`domain/slack-rules.ts`; `MACHINE_STATE_DIR/slack-triage.md`, written from the template in `docs/agents/slack-triage.md`) drops your own messages and muted channels, settles app posts without the model and sets priority floors for VIPs, always-P0 keywords and watches; what is left goes to the `slack_triage` pack: an agent of the harness like every stage, the `slack-triager` role (`factory/agents/slack-triager.md`, rubric and worked examples) on Haiku at low effort, three turns, no tools, run through the factory runner in the stage container with the stages' image and credential (`application/stages/slack-triage-runner.ts`; `/work` is an empty folder under `MACHINE_STATE_DIR/slack-triage/<time>`, the batch of up to 25 items rides in `context.slack`, the structured answer comes back in `result.json`). A poll persists and publishes first and the pack runs after it, one container at a time, publishing again when the verdicts land; each run is a row in `slack_triage_runs` (`GET /slack/triage-runs`). Items and the watches you save live in `slack_items` and `slack_watches`, so triage and your read state survive restarts, and every change is published as one `slack.items` snapshot. Each open ask carries a reply SLA from the rules file's `## SLA` (10m, 30m, 1h, 1h by priority unless you change it): `dueAt` and `overdue` are computed when the snapshot is built, never stored, and a minute tick republishes when an item goes overdue with nothing from Slack to say so. Replying posts as you with the same token; `t` turns an item into a task whose `source.kind` is `slack`; done is manual, and a thread that moves after you cleared it reopens, re-triaged. What you do feeds back into `slack-triage.learned.md` beside the rules file, keyed by user or channel id, which the next poll merges into the rules; the snapshot's `quiet` flag says when the rules file's quiet hours are on, and the board then raises notices for P0 only.

## Repository layout

| Path | What it is |
|---|---|
| `board/` | The Luna TUI board, the Rust TUI and herdr plugin. A client of the machine. |
| `machine/` | The orchestrator: TypeScript on Node 24+, HTTP API plus an SSE stream, Postgres for state. |
| `factory/` | What runs inside a stage container: the runner (Agent SDK), the eight agent roles, the prompt templates, the skills plugin, the guards and the `luna` tool server. |
| `contracts/` | Types shared by the machine, the factory and the board, including the pack registry. |
| `fixtures/` | Fixture repos used by `pnpm golden` (one seeded bug or feature each). |
| `docs/` | This folder. |
| `compose.yaml` | Postgres and the machine (`docker compose up`); `pnpm dev` starts only Postgres. |

## Layout inside `machine/src`

Grouped by layer, not by technology:

- `domain/` — pure types and logic with no I/O: task/stage-run/event rows, the transition engine, locked-files/pr-body/detect-checks helpers, memory-rule parsing, stage-input building.
- `application/` — use cases and ports: `pipeline.ts` (orchestrates the transition engine and the stage runners), `task-store.ts` (the persistence port `pipeline.ts` depends on, never a concrete DB call), `ports.ts` (the `StageRunner`/`StageContext`/`StageResult` contract), the stage runners under `application/stages/` (`pack-runner.ts`, `verify.ts`, `deliver.ts`, `ship.ts`, `ci.ts`, `e2e.ts`, `evidence.ts`, `memory.ts`, `ingest.ts`, `stubs.ts`), and the GitHub poll loop (`intake.ts`).
- `adapters/` — everything that talks to the outside world: `persistence/` (Postgres via TypeORM, implementing the `TaskStore` port), `http/` (the Hono API), `docker/` (the stage sandbox), `process/` (the generic subprocess runner), `git/` (worktrees), `github/` (the GitHub API through Octokit, behind the `GitHub` port in `application/github.ts`). `http/` also announces running stage containers on the event stream, which the board follows in herdr tabs.
- `bootstrap/` — wires the above together at startup (`stages.ts`); `main.ts` itself is just the entry point.

Dependencies point inward: `adapters` depend on `application` ports, `application` depends on `domain` types, nothing in `domain` or `application` imports `typeorm`, `pg`, `hono`, or shells out to `docker` directly, and nothing but `adapters/github/` imports Octokit.

This is a lightweight application of ports-and-adapters, not a formal DI container: most stage runners already took their dependencies as plain function parameters before this layout existed (`deps.exec`, `deps.runPack`, `deps.sandbox`), so the move mostly made that existing seam's *location* match its *role*. A port got a named interface only where three or more call sites actually shared one (`TaskStore`, `GitHub`, the generic `exec`).

## Shipping

Approving the Ship gate runs `git push -u origin <task branch>` from the task's worktree, then `gh pr create` (or reuses the PR if one is already open for that branch). It needs, on the host:

- A GitHub token in `GITHUB_TOKEN` (or `GH_TOKEN`) with repo scope: every GitHub call goes through the API with it. Git itself stays yours: pushes and clones use your own git credentials.
- A repo with an `origin` remote you can push to.

Without either, the stage fails with a clear reason and escalates — nothing silently retries a `git push` against a repo with no remote.

## Factory mode

The agent stages run as stage packs inside the stage container, through `factory/src/main.ts` and the Claude Agent SDK. Each pack (`contracts/src/packs.ts`) names a role, a model and effort, a tool allow-list, turn and time limits, the skills the role may invoke and the answer schema the stage must return. The role's prompt body is `factory/agents/<role>.md`; the stage prompt is `factory/prompts/<pack>.md` rendered from the stage input. The runner serves the agent an in-process `luna` tool server (a progress label, the slice ledger, the settled decisions), runs the guardrails as in-process `PreToolUse` hooks (no push, no PR or tracker writes, no commits off `task/*`, no AI attribution, no writes outside `/work` and `/out`), and loads the skills from `factory/plugin`. The sandbox guardrails stay: `settingSources: []`, the pack's tool allow-list, and read-only mounts for everything the stage does not own.

The stage contract is the run folder: the machine writes `/in/stage.json` (`StageInput`), the runner writes `/out/result.json` (`StageOutput`, with the ledger and the SDK session id), `/out/events.jsonl` and `/out/files/**`. Both shapes live in `contracts/src/stage.ts`; `contracts/src/factory-contract.test.ts` checks that every answer a pack may give is one the machine ingests. The SDK's session transcripts are kept per task under the machine's state dir (`tasks/<id>/session`, mounted at `/session`), so a session outlives its container.

No other tool has to be installed: a fresh clone builds the stage image from `factory/` and `contracts/` alone. The prompts, role bodies and skills were copied from the [orc](https://github.com/HigorAlves/orc) plugin once (see `factory/NOTICE`) and are maintained here.
