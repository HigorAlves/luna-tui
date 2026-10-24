# Plan 0001: the machine, dev version

The product is now called Luna TUI; this plan keeps the working name Hardness.

The machine is a TypeScript orchestrator that runs the harness pipeline from the
Local Dev Harness plan and drives the Hardness Board. This plan covers the **dev
version**: the orchestrator runs on the host with `pnpm dev`, and only Postgres
runs in Docker. Running everything with `docker compose up` comes after this plan.

## Decisions

| Area | Decision |
|---|---|
| First milestone | Full pipeline skeleton. Every stage is in the graph with state, retries and approvals. Triage and Implementer run for real; the other stages are stubs. |
| Agent runtime | Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) for every agent call. No Eve or AI SDK yet; Eve can be added later for channels or memory. |
| Where agents run | One fresh Docker container per stage run, deleted when the stage ends. |
| Watching an agent | The machine opens a herdr pane that follows the stage container, so you can watch it like a local agent. |
| Auth | Your Claude subscription token, personal use only. Phase 0 proves it works and checks the current terms. API key is the fallback. |
| Dev runtime | Orchestrator on the host with hot reload. Postgres in Docker via `compose.dev.yml`. |
| State | Postgres is the source of truth for tasks, stage runs, events and approvals. |
| Board link | The machine serves an HTTP API for commands and a Server-Sent Events stream for updates. The board becomes a client. `board.json` is imported once, then retired. |
| Code handoff | The machine creates a git worktree on a task branch on the host and mounts it into the stage container. The agent commits there. No tokens in containers. |
| Repo layout | `board/` (Rust), `machine/` (TypeScript, pnpm), `contracts/` (shared API schema). |

Choices made without a question, open to change:

- HTTP server: Hono on Node 24. SSE for the stream.
- Database: TypeORM with its migrations, generated and run through the TypeORM CLI. Entities declare every column type explicitly, because `tsx` (esbuild) does not emit decorator metadata.
- Docker control: `dockerode`.
- Tests: Vitest. Engine tests are pure; database tests run against the dev Postgres.
- Machine address: `http://127.0.0.1:4317`, overridable with `HARDNESS_MACHINE_URL`.
- Columns follow stages for machine-managed tickets (see the mapping below), so `m`/`M` no longer move those tickets by hand.

## Shape

```
Mac (host)
├── herdr
│   ├── Board (Rust TUI) ──HTTP commands / SSE updates──┐
│   └── watch panes: `docker logs -f <stage container>` │
├── machine (pnpm dev) ◄─────────────────────────────────┘
│   ├── engine: stage graph, retries, approvals
│   ├── git: worktrees on task branches
│   ├── sandbox: start / wait / collect / delete containers
│   └── herdr: open watch panes, notifications
├── Postgres (compose.dev.yml)
└── stage containers (one per stage run)
    └── runner: Agent SDK `query()` on the mounted worktree
```

## Components

`machine/src/`

- `engine/`: the state machine. Stage graph, transitions, retry caps (3 per loop, 6 implementer runs in total), approvals. Pure functions over task state, so it is fully unit tested.
- `stages/`: one definition per stage: input and output schemas (zod), runner kind (`agent`, `script`, `stub`, `host`), allowed tools, time limit.
- `sandbox/`: runs a stage in a container. Mounts the worktree and an `/in` and `/out` folder, waits with a timeout, collects `/out`, deletes the container.
- `git/`: creates and removes worktrees, names branches `task/<id>-<slug>`, records input and output commits.
- `herdr/`: opens a pane following a stage container, sends notifications.
- `db/`: TypeORM data source, entities and migrations.
- `api/`: Hono routes and the SSE stream.

`machine/runner/`: the stage container image. Node 24, git and the Agent SDK. The entrypoint reads `/in/stage.json`, runs `query()` with that stage's prompt and tools, writes the validated result to `/out/result.json`, and prints the transcript to stdout so the watch pane shows it.

`contracts/`: the API types as zod schemas, exported as JSON Schema so the Rust board can check its structs against them.

## Stages in the first milestone

| Stage | Runner | Milestone 1 |
|---|---|---|
| Triage | agent, read-only tools | real |
| Answers / approval | gate in the board | real |
| Test designer | agent | stub |
| Test check | gate in the board | real gate, stub input |
| Implementer | agent, edit tools | real |
| Verifier + Reviewer | script + agent | stub |
| E2E builder | agent | stub |
| Deliver | host | stub |
| CI watch | host | stub |
| Evidence | agent | stub |
| Ship | gate in the board, then host (`git push` + `gh pr create`) | real gate, real action |
| Close | host | stub |

Stubs pass by default. A dev-only endpoint sets a stub to fail, so retry and escalation paths can be tested without agent cost.

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

The card states the board already shows map from the same data: a waiting gate is "needs you", a running stage is "working", `escalated` and an aborted run are "lost".

## Data (Postgres, first milestone)

Trimmed from the harness plan. Memory, artifacts, checks and feedback come later.

- `tasks`: id, title, description, criteria (jsonb), repo_path, branch, worktree_path, state, retries (jsonb), created_at.
- `stage_runs`: id, task_id, stage, attempt, status, container_id, input_commit, output_commit, transcript_path, started_at, ended_at.
- `events`: id, task_id, stage_run_id, kind, payload (jsonb), at.
- `approvals`: id, task_id, kind, requested (jsonb), decision, reason, decided_at.

## API

| Method | Path | Does |
|---|---|---|
| GET | `/tasks` | List tasks with their state and column. |
| GET | `/tasks/:id` | One task with stage runs, open approvals and recent events. |
| POST | `/tasks` | Create a task: title, description, criteria, repo path. |
| POST | `/tasks/:id/start` | Start the pipeline. |
| POST | `/tasks/:id/answers` | Answer triage questions: `{ "answers": { "<question>": "<answer>" } }`. |
| POST | `/tasks/:id/decision` | Approve or send back whatever the task waits on, including an escalation: `{ "decision": "approved" \| "sent_back", "reason"? }`. |
| POST | `/tasks/:id/abort` | Stop a running or paused task; it then waits for you. |
| POST | `/tasks/:id/resume` | Re-run the stage a task paused in after a usage limit. |
| POST | `/tasks/:id/worktree/remove` | Remove the task's worktree from disk. The task, its branch and commits stay. |
| GET | `/events` | SSE: `task.updated` (the whole task) and `task.event` (one activity entry), plus `ready` and a `ping` every 15 s. |
| GET | `/health` | Liveness check. |
| POST | `/dev/stubs` | Dev only: queue results for a stub stage, e.g. three `fail`s for `verifying`. |

Errors use `{ "error", "message" }`: 400 for invalid input, 404 for an unknown task, 409 for an action that does not fit the task's state. Shapes live in `contracts/src/api.ts`.

## Dev workflow

Docker Desktop is already installed (Docker 29.9, Compose v5.6), so nothing extra is needed on the host.

```sh
docker compose -f compose.dev.yml up -d   # Postgres
pnpm --dir machine db:migrate
pnpm --dir machine runner:build           # stage container image
pnpm --dir machine dev                    # orchestrator with hot reload
cargo build --release --manifest-path board/Cargo.toml
```

The herdr plugin moves with the board, so it is relinked from `board/` once.

## Phases

0. **Spike (gate). Done: go.** Agent SDK `query()` ran a read-only stage in a container on a subscription token. Results and design findings are in `spikes/0-agent-sdk/RESULTS.md`: check `is_error` rather than `subtype`, restrict tools with `tools`/`disallowedTools` (not `allowedTools`), and drive `paused_rate_limit` from the `rate_limit_event` messages.
1. **Repo layout. Done.** The Rust board is in `board/`, with `machine/` and `contracts/` as a pnpm workspace, `compose.dev.yml` for Postgres 16 on `127.0.0.1:5433`, and the herdr plugin relinked from `board/`. `contracts/` already holds the task states and their board columns. The board's existing tickets are in `~/.local/state/herdr/plugins/hardness.board/board.json`, which Phase 5 imports.
2. **Engine and database. Done.** `machine/src/engine/transition.ts` is the stage graph as a pure function; `machine/src/pipeline/pipeline.ts` applies it to Postgres in row-locked transactions and runs stages (stubs for now) until the task waits, pauses or closes. Tables are TypeORM `EntitySchema`s (no decorators) with one generated migration. Decisions made while building it:
   - A new `draft` state holds tasks that are created but not started.
   - Escalated and paused tasks remember where to continue (`resume_to`). Your guidance on an escalation resets the retry budget.
   - Abort applies to running and paused tasks and escalates them, so you decide whether to re-run the stage.
   - A runner that throws counts as a failed run; triage, test design and deliver escalate on failure instead of retrying.
   - Tests run against a separate `hardness_test` database, rebuilt from the migrations on each run.
3. **API and stream. Done.** Hono server in `machine/src/api/`, started by `pnpm dev` after running pending migrations, on `127.0.0.1:4317`. Verified by driving a task through every gate, an escalation and the error cases with curl while listening to `/events`. Stages still run inline inside the request (Phase 4 moves them to a worker).
4. **Sandboxes. Done.** `machine/runner/` is the stage image (`pnpm --filter @hardness/machine runner:build`). Triage and Implementer run as real agents in a fresh container per run (`machine/src/stages/agents.ts`); the other stages stay stubs. Stages now run in a background loop per task, so API calls return at once. Verified on a demo repo: triage wrote a plan in 20 s, the implementer fixed the bug, its tests passed, and the machine committed on the task branch; abort killed a running container. How it works:
   - Each task gets a git worktree on `task/<id>-<slug>` under `WORKTREES_DIR` (default `~/Developer/worktrees/<repo>/`). Triage mounts it read-only, Implementer read-write. The repo's git dir is mounted read-only so git works inside.
   - Tools are restricted per stage with the SDK's `tools` plus `permissionMode: "dontAsk"`, and `settingSources: []` so a repo's `.claude/` settings and hooks never load. Answers come back as structured output against a JSON schema.
   - The machine commits the implementer's changes on the host with the repo's identity. These commits are **not signed** (`commit.gpgsign=false`), because signing needs a passphrase a background run cannot ask for.
   - herdr opens one watch tab per task that follows the stage container (`docker logs -f`). Transcripts and run files are kept in `~/.local/state/hardness/runs/<run id>/`.
   - A usage limit pauses the task and resumes it 30 s after the window resets. On start, the machine removes leftover stage containers and escalates tasks a previous run left mid-stage.
   - Without a credential or the image, or with `MACHINE_AGENTS=off`, every stage is a stub.
   - Not done yet: verify findings are not fed back to the implementer (the verifier is still a stub), and tasks need a `repoPath` to run real stages.
5. **Board client. Done.** The board (`board/`) no longer keeps its own tickets: it reads `/tasks` and `/tasks/:id` from the machine, follows `/events` (Server-Sent Events) on a background thread, and sends every action through the HTTP API. `HARDNESS_MACHINE_URL` overrides the default `http://127.0.0.1:4317`.
   - **Columns follow task state** via the `COLUMN_OF` map in `contracts/`; manual column moves are gone.
   - **One key per gate.** `a` does the one obvious next step (start a draft, approve, open `$EDITOR` on triage's questions, add guidance to an escalation, resume after a usage limit); `r` sends the plan or tests back with a required reason (typed in the footer); `X` asks, then aborts a running or paused stage; `f` focuses the agent's herdr watch tab; `d` asks, then deletes.
   - **Details view** shows the open gate's content (triage's brief, criteria, assumptions or questions), stage runs with their status, and a window onto the activity log, all from `/tasks/:id`.
   - **Offline is a state, not a crash.** While the machine is down the header turns red with the reason and the board keeps running; it reconnects and reloads automatically.
   - **One-time import.** On first launch the board moves any tickets from the old local `board.json` into the machine via `POST /tasks`, then renames the file to `board.json.imported` so the import never runs twice.
   - **Added to the machine for this:** `PATCH /tasks/:id` (edit text) and `DELETE /tasks/:id` (blocked while a stage is running), plus a `task.deleted` stream message.
   - **Bug found and fixed:** the Rust client sent `"reason": null` for "no reason," which `DecisionInput`'s `z.string().optional()` rejected (optional allows a missing key, not `null`). Fixed by making `reason` `.nullable()` too. Found by driving the board end to end in a pseudo-terminal against the real HTTP/SSE loop, not by unit tests.
   - Verified by scripted pseudo-terminal runs: import, create, start, approve twice (plan, then tests), send back with a reason, abort-when-idle, delete, and that the board survives the machine stopping. Also verified: answering triage's questions through `$EDITOR`.
   - Not verified live: aborting a stage genuinely mid-run through the board (the pipeline-level abort is covered in Phase 2/4; a stub stage resolves too fast to catch in a scripted test).
6. **Golden task. Done.** `fixtures/golden-task/` is a tiny repo with one seeded bug (`formatPrice` drops the second decimal); `machine/scripts/golden-task.mjs` (`pnpm golden`) copies it into a fresh git repo per run, creates a task on it, and drives every gate through the HTTP API: approve the plan, approve the tests, approve publish, approve the memory review, then checks the task closed. With a credential and the runner image (the normal case), it also runs the fixture's own `npm test` against the implementer's real commit and expects it to pass, then deletes the temp repo and its worktree. Without agents it still checks the whole state graph, just skips the fix check. Run three times end to end: ~22-35s each, real triage + implementer, no leftover worktrees. This is the regression check for every later change to the engine, the API, or the agents.

Each phase ends with its tests passing and a short demo through the board.

## Found after Phase 6, on real repos

Testing the implementer against this repo itself (not just the golden fixture) surfaced
three gaps, all fixed:

- **A ticket's repo path wasn't found outside herdr.** `workspace_repo()` only checked
  herdr's `workspace_cwd` for an exact `.git`, and returned nothing when the board ran
  standalone. It now walks up to the repo root from either herdr's workspace or the
  board's own working directory, so a ticket defaults to the right repo either way.
  Starting (or resuming) a ticket with no repo path no longer fails in triage — the
  board opens the editor and asks for one first.
- **No way to reclaim a worktree's disk space once a ticket closed.** `POST
  /tasks/:id/worktree/remove` (`w` in the board, asks first) removes the worktree
  checkout; the task, its branch and commits stay, so you can still merge or inspect
  the work. `pnpm golden` was updated to use the same cleanup so it leaves nothing
  behind either.
- **A task's herdr watch tab stayed open after it closed.** The machine now closes it
  itself the moment a task reaches `closed` — and, since deleting a task bypassed that
  same code path, `DELETE /tasks/:id` now closes its tab too.
- **A retry after an abort, timeout, or crash reused a dirty worktree with no warning.**
  `ensureWorktree()` only created a worktree if missing, never reset it, so a half-edited
  attempt fed straight into the next one. The implementer's stage runner now discards
  anything left uncommitted (`git reset --hard && git clean -fd`) whenever a run ends
  without a clean, committed answer — aborted, timed out, crashed, or rate-limited — but
  never on a deliberate `test_change` return, since those edits are meant to carry over.
  Verified live: aborted a real implementer run mid-edit and confirmed the worktree came
  back clean.
- **Ctrl+C left containers and dirty worktrees running unseen.** Graceful shutdown now
  aborts every running task's stage loop (killing its container) and waits up to 5s for
  them to wind down before the process exits, instead of only relying on the next
  startup's crash-recovery sweep. Verified live: `SIGTERM` during a real triage run killed
  and removed its container immediately and escalated the task with `reason: "aborted"`.
- **Opening the board with no machine running wasn't obvious enough.** The header already
  showed a red "machine offline" banner, but nothing called it out at the moment you open
  the board. It now also shows a startup toast telling you to run `pnpm dev`.
- **No cap on concurrent tasks (P1 from the review).** Starting several tickets — even
  across different repos — used to launch that many containers and agent sessions at
  once. `MACHINE_MAX_CONCURRENT` (default 4) now caps how many tasks can be driving a
  stage at the same time, globally, across every repo the machine knows about. A task
  past the limit is marked `queued` on its row in Postgres (not just in memory), so a
  restart tells a task that was genuinely mid-run (escalate it) apart from one that was
  only waiting for a slot (just reschedule it, nothing was lost). The board shows a
  queued ticket distinctly (grey "…", status `queued: <stage>`) rather than as running.
  Verified live with `MACHINE_MAX_CONCURRENT=1`: two real tasks correctly took turns for
  every stage, including two different tasks contending for the same slot mid-pipeline;
  and after a hard kill, the task that was actually running got escalated while the one
  that was merely queued resumed on its own.
- **One machine serves every repo — confirmed as the intended model, with one addition.**
  There's one machine (one Postgres, one HTTP server) per host, not one per repo; every
  board, from any workspace, is just a client of that same machine and sees the same
  tasks and the same queue. Added `@` in the board: filters the view to only the tickets
  whose repo matches the one this board defaults new tickets to (herdr's workspace, or
  the board's own working directory standalone). Off by default, so a board still shows
  every repo's tickets unless you ask it not to.
- **Typing a repo path by hand invites typos.** `R` in the board opens a type-to-filter
  search over every repo under `HARDNESS_REPOS_DIR` (default `~/Developer`) — a repo
  found directly under it, or grouped with others under a project folder
  (`~/Developer/some-project/backend`, `.../frontend`, both found; `board/src/discover.rs`
  stops descending the moment it finds a `.git`, so it never walks into a repo's own
  history or a submodule). The missing-repo guards on `a` (draft, escalated) now open this
  search instead of the markdown editor. One real gap this surfaced: the default
  `WORKTREES_DIR` (`~/Developer/worktrees`) sits inside the default search root, so every
  live task's own checkout would otherwise show up as a pickable "repo" — fixed by
  skipping any directory named `worktrees`.

## Intake, Ship/Done, and a popup for tickets

Four more changes, from the same session, carrying through on requests made earlier that
hadn't landed yet:

- **Intake is its own column, ahead of Triage.** A ticket you create is a `draft` and now
  shows in **Intake**, not **Triage** — nothing new in the engine, just `COLUMN_OF` giving
  `draft` its own column, so a ticket you're still shaping is visibly separate from one
  actually being triaged.
- **Ship replaces Publish, and it does something real.** `awaiting_publish` is renamed
  `awaiting_ship`; approving it no longer just waits at `reviewing_memory` — it runs a new
  `shipping` stage (`machine/src/stages/ship.ts`) that does, on the host, exactly what a
  person would: `git push -u origin <task branch>`, then `gh pr create` (reusing an existing
  PR for that branch rather than failing a retry on it). This is a plain host command, not a
  Claude agent, so it runs unconditionally — no credential needed. On any failure (no
  remote, `gh` missing or unauthenticated, push rejected) it escalates with a clear reason
  rather than retrying blindly; `resumeTo: "shipping"` re-runs just this stage once you've
  fixed whatever was wrong. `closed` now has its own **Done** column, separate from **Ship**
  (which holds `awaiting_ship`, `shipping`, `reviewing_memory`). Verified live: a real golden
  task run reached `shipping`, attempted the push, and escalated cleanly with "ship failed"
  since the throwaway fixture repo has no remote — `pnpm golden` now expects and accepts
  that outcome rather than treating it as a failure.
- **The ticket view is a popup over the board, not a full-screen replacement.** `enter`'s
  `Mode::Detail` renders the exact same content as before (status, the open gate's content,
  stage runs, activity), just in a centered overlay with the board still visible behind it,
  instead of replacing the whole screen. The same popup is what shows a plan to read, tests
  to check, or — once shipping works — the PR's URL, since that's the same gate-content
  rendering path.
- **Editing a ticket happens in place, not in `$EDITOR`.** `e` (and a new ticket's first
  edit) opens a `tui-textarea`-backed text area inside the board, pre-filled with the same
  markdown `$EDITOR` used to show; `ctrl+s` saves (reusing the existing `parse_ticket`/
  `update` call), `esc` cancels. Nothing shells out or suspends the terminal for this
  anymore. (`tui-textarea` on crates.io is pinned to an older ratatui; the maintained fork
  `tui-textarea-2` — same `tui_textarea` library name, so it's a drop-in — tracks the one
  this board already uses.) Triage's answer-questions flow still uses `$EDITOR`; it wasn't
  part of this change.

**Explicitly not done, and why:** the original ask also wanted Triage to run through
`orc:triage`, the implementer through `orc-implementer`, and Ship through `orc:ship`
directly. Those are interactive Claude Code skills built around a full session — your
plugins, `.orc/` state, broad tool access (`gh`, `acli`, arbitrary `Bash`). The stage
containers are deliberately the opposite: `settingSources: []` so a repo's own `.claude/`
never loads, a short allowed-tools list, no plugin access at all — that boundary is the
whole point of running agents in a disposable sandbox. Invoking those skills for real would
mean removing the guardrails, not adding a shortcut, so it isn't done. What ships instead,
as the concrete resolution: Ship actually opens a real PR (above), and Triage/Implementer
already run as real, if differently-built, agents (Phase 4).

## Later, not in this plan

Git and egress proxies with a secret vault, fresh clones instead of mounted worktrees, the real Verifier, Reviewer and E2E stages, memory slots, evals, and `docker compose up` for everything.

## Risks

- **Subscription use may not be allowed or may hit limits.** Phase 0 decides; the API key path stays ready.
- **Mounted worktrees weaken isolation.** A container can write anywhere in its worktree, so locked tests are not enforced yet. Accepted for dev; the git proxy fixes it later.
- **File performance on macOS bind mounts.** Large repos may be slow in containers; measure in Phase 4.
- **The board needs the machine.** When the machine is down, the board must show an offline state instead of failing.

## Open questions

- Which repos tickets target: the workspace the board is opened from, or a repo path chosen per ticket.
- Whether manual column moves stay available for tickets the machine does not manage.
