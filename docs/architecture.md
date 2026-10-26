# Architecture

## Pipeline

Every ticket moves through these stages, from Intake (not ready yet) to Done:

1. **Intake**: a ticket you're still shaping. Nothing runs until you start it.
2. **Triage**: an agent reads the ticket and the repo, asks questions if needed, and proposes a plan.
3. **Build**: the implementer agent writes the change on a task branch (a git worktree on the host).
4. **Verify**: runs the project's own checks, then the review pack.
5. **E2E and Evidence**: for a repo with a web surface, a QA agent drives the app in a browser (the `runner-qa` image) and writes a manifest, screenshots and video; repos with none skip with a recorded reason. Evidence then checks the manifest on the host and shows its verdict, artifact count and a few screenshot paths in the ship approval.
6. **Deliver**: pushes the branch and opens a draft PR with `gh`, so CI starts early. Its body follows orc's caveman-pr shape and adds `Closes #N` when the ticket came from a GitHub issue in the same repo.
7. **CI watch**: polls the PR's checks until they settle, outside the stage pool (polling computes nothing, so its slot goes to the queue meanwhile). A red run goes to the `ci_watch` pack: a fixable failure loops back to Build with its findings, a flake is re-run once, and infra or needs-debug failures escalate.
8. **Ship**: marks the draft PR ready for review (it opens a ready PR only if Deliver never did), then you review before closing it. After a passing Ship, a read-only memory review (orc's retro pack) looks at `.orc/` and `git log` and proposes rules for `docs/agents/project-context.md`; the last gate shows them, `a` commits them to the task branch (refused above 150 lines / 6 KB, pushed only if the branch has an upstream) and `A` skips them.

Triage and Build run orc packs (see [Factory mode](#factory-mode)) when a credential and the runner image are available. Deliver and Ship run for real too — they are plain host commands (`git push` + `gh pr create --draft` / `gh pr ready`), not Claude agents — as soon as a task has a branch. CI watch polls on the host and runs its pack only for a red check. Evidence runs on the host. Intake, Done and any stage without a runner are stubs that pass, unless you queue a result with `POST /dev/stubs`. Full route list: [api.md](./api.md).

The machine is one service for every repo you point a task at, not one per repo: `MACHINE_MAX_CONCURRENT` (default 4) caps how many tasks can be driving a stage at once *in total*, across all of them, not per repo. Each repo can still speak for itself through a `PIPELINE.md` at its root (QA on or off, a monthly budget, a concurrency cap, timer-approved plans, held-out test cases; see [configuration](configuration.md)), and `/metrics?groupBy=repo` tells the repos apart. A task past that cap is `queued` until a slot frees — durably, in Postgres, so a restart doesn't lose track of it. Open as many boards as you like, from any workspace: they're all clients of this one machine and see the same tasks and the same queue.

## Board columns from task state

| Column | Task states |
|---|---|
| Intake | `draft` |
| Triage | `triage`, `awaiting_answers`, `awaiting_approval` |
| Approved | `test_design`, `awaiting_test_check` |
| Build | `implementing`, `escalated`, `paused_rate_limit` |
| Verify | `verifying`, `e2e`, `delivering`, `ci_watch` |
| Evidence | `evidence` |
| Ship | `awaiting_ship`, `shipping`, `reviewing_memory` |
| Done | `closed` |

The card states the board already shows map from the same data: a waiting gate is "needs you", a running stage is "working", `escalated` and an aborted run are "lost". Source of truth: `COLUMNS` and `COLUMN_OF` in `contracts/src/index.ts`.

## Repository layout

| Path | What it is |
|---|---|
| `board/` | The Luna TUI board, the Rust TUI and herdr plugin. A client of the machine. |
| `machine/` | The orchestrator: TypeScript on Node 24+, HTTP API plus an SSE stream, Postgres for state. |
| `contracts/` | Types shared by the machine and the board. |
| `fixtures/` | Fixture repos used by `pnpm golden` (one seeded bug or feature each). |
| `docs/` | This folder. |
| `compose.yaml` | Postgres and the machine (`docker compose up`); `pnpm dev` starts only Postgres. |

## Layout inside `machine/src`

Grouped by layer, not by technology:

- `domain/` — pure types and logic with no I/O: task/stage-run/event rows, the transition engine, locked-files/pr-body/detect-checks helpers, memory-rule parsing, stage-input building.
- `application/` — use cases and ports: `pipeline.ts` (orchestrates the transition engine and the stage runners), `task-store.ts` (the persistence port `pipeline.ts` depends on, never a concrete DB call), `ports.ts` (the `StageRunner`/`StageContext`/`StageResult` contract), the stage runners under `application/stages/` (`pack-runner.ts`, `verify.ts`, `deliver.ts`, `ship.ts`, `ci.ts`, `e2e.ts`, `evidence.ts`, `memory.ts`, `ingest.ts`, `stubs.ts`), and the GitHub poll loop (`intake.ts`).
- `adapters/` — everything that talks to the outside world: `persistence/` (Postgres via TypeORM, implementing the `TaskStore` port), `http/` (the Hono API), `docker/` (the stage sandbox), `process/` (the generic subprocess runner), `git/` (worktrees), `github/` (the `gh` CLI). `http/` also announces running stage containers on the event stream, which the board follows in herdr tabs.
- `bootstrap/` — wires the above together at startup (`stages.ts`); `main.ts` itself is just the entry point.

Dependencies point inward: `adapters` depend on `application` ports, `application` depends on `domain` types, nothing in `domain` or `application` imports `typeorm`, `pg`, `hono`, or shells out to `docker`/`gh` directly.

This is a lightweight application of ports-and-adapters, not a formal DI container: most stage runners already took their dependencies as plain function parameters before this layout existed (`deps.exec`, `deps.runPack`, `deps.sandbox`), so the move mostly made that existing seam's *location* match its *role*. A port got a named interface only where three or more call sites actually shared one (`TaskStore`, the `gh` CLI, the generic `exec`).

## Shipping

Approving the Ship gate runs `git push -u origin <task branch>` from the task's worktree, then `gh pr create` (or reuses the PR if one is already open for that branch). It needs, on the host:

- The [`gh` CLI](https://cli.github.com/), signed in (`gh auth status`).
- A repo with an `origin` remote you can push to.

Without either, the stage fails with a clear reason and escalates — nothing silently retries a `git push` against a repo with no remote.

## Factory mode

The agent stages run as [orc](https://github.com/HigorAlves/orc) stage packs (`orc-stage run`) inside the stage container: Triage, Build and the later agent stages each get a pack with its own prompt, tool allowlist and limits. The sandbox guardrails stay: `settingSources: []`, the pack's tool allowlist, one pinned orc plugin baked into the image at `/orc`, and read-only mounts for everything the stage does not own. The stage contract (pack discovery, `/in`/`/out`, the `StageOutput` shape) is defined by orc's own [ADR 0009](https://github.com/HigorAlves/orc/blob/main/docs/adr/0009-factory-mode-and-stage-contract.md).
