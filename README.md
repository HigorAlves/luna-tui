<div align="center">
<img src="board/icon.png" width="112" alt="Luna TUI's icon">

# Luna TUI

**A board in your terminal that runs orc as a software factory. You approve three times.**

</div>

Luna waits on Claude in your [notch](https://github.com/HigorAlves/luna-notch); Luna TUI runs the factory in your terminal; [orc](https://github.com/HigorAlves/orc) is the engine both drive.

Luna TUI is a local dev harness for working with AI coding agents. You plan
tickets on a board inside [herdr](https://herdr.dev/); a machine then moves each
ticket through a fixed pipeline, running Claude agents in throwaway Docker
containers, and stops at approval gates so you stay in control.

## Names in the code

Packages (`@hardness/*`), the `hardness.board` plugin id, env vars such as `HARDNESS_MACHINE_URL`, the `~/.config/hardness/` directory and the `hardness-runner` images still say `hardness`. Renaming them is a separate change; the product name is Luna TUI.

## Pipeline

Every ticket moves through these stages, from Intake (not ready yet) to Done:

1. **Intake**: a ticket you're still shaping. Nothing runs until you start it.
2. **Triage**: an agent reads the ticket and the repo, asks questions if needed, and proposes a plan.
3. **Build**: the implementer agent writes the change on a task branch (a git worktree on the host).
4. **Verify**: runs the project's own checks, then the review pack.
5. **E2E and Evidence**: for a repo with a web surface, a QA agent drives the app in a browser (the `runner-qa` image) and writes a manifest, screenshots and video; repos with none skip with a recorded reason. Evidence then checks the manifest on the host and shows its verdict, artifact count and a few screenshot paths in the ship approval.
6. **Deliver**: pushes the branch and opens a draft PR with `gh`, so CI starts early. Its body follows orc's caveman-pr shape and adds `Closes #N` when the ticket came from a GitHub issue in the same repo.
7. **CI watch**: polls the PR's checks until they settle. A red run goes to the `ci_watch` pack: a fixable failure loops back to Build with its findings, a flake is re-run once, and infra or needs-debug failures escalate.
8. **Ship**: marks the draft PR ready for review (it opens a ready PR only if Deliver never did), then you review before closing it. After a passing Ship, a read-only memory review (orc's retro pack) looks at `.orc/` and `git log` and proposes rules for `docs/agents/project-context.md`; the last gate shows them, `a` commits them to the task branch (refused above 150 lines / 6 KB, pushed only if the branch has an upstream) and `A` skips them.

Triage and Build run orc packs (see Factory mode) when a credential and the
runner image are available. Deliver and Ship run for real too — they are plain host commands
(`git push` + `gh pr create --draft` / `gh pr ready`), not Claude agents — as soon
as a task has a branch. CI watch polls on the host and runs its pack only for a red check. Evidence runs on the host. Intake, Done and any stage without a runner are stubs that pass, unless you queue
a result with `POST /dev/stubs`. See `docs/plans/0001-machine-dev.md` for the
details.

The machine is one service for every repo you point a task at, not one per
repo: `MACHINE_MAX_CONCURRENT` (default 4) caps how many tasks can be driving
a stage at once *in total*, across all of them, not per repo. A task past
that cap is `queued` until a slot frees — durably, in Postgres, so a restart
doesn't lose track of it. Open as many boards as you like, from any
workspace: they're all clients of this one machine and see the same tasks and
the same queue.

## Repository layout

| Path | What it is |
|---|---|
| `board/` | The Luna TUI board, the Rust TUI and herdr plugin. A client of the machine. |
| `machine/` | The orchestrator: TypeScript on Node 24+, HTTP API plus an SSE stream, Postgres for state. |
| `contracts/` | Types shared by the machine and the board. |
| `fixtures/golden-task/` | A small repo with one seeded bug, used by `pnpm golden`. |
| `docs/plans/` | Plans. Start with `0001-machine-dev.md`. |
| `compose.yaml` | Postgres for local development. |

## Prerequisites

- Docker (for Postgres and the stage containers)
- Node 24+ and pnpm
- Rust (to build the board)
- Optional, for the E2E stage: the QA image (`pnpm --filter @hardness/machine runner-qa:build`). It adds Playwright with Chromium, ffmpeg and agent-browser on top of the runner image, so expect about 2 GB more disk (a 3.9 GB image against 1.9 GB). Without it E2E is skipped with a note and the rest of the factory runs.
- [herdr](https://herdr.dev/), to run the board as a plugin

## Quick start

```sh
pnpm install
pnpm db:up            # Postgres on 127.0.0.1:5433
pnpm --filter @hardness/machine runner:build   # the stage container image
pnpm dev              # the machine on http://127.0.0.1:4317, with hot reload
pnpm board:build      # the board; then `herdr plugin link ./board` once
```

`pnpm db:down` stops Postgres and keeps its data. For board usage and keys, see
[`board/README.md`](board/README.md).

## Checks

```sh
pnpm test             # machine and contracts
pnpm typecheck
pnpm board:test       # board
pnpm golden           # end-to-end, needs a running machine
```

- `pnpm golden`: one ticket through every gate. Needs a running machine; a credential and docker for real agent stages, otherwise stubs.
- `pnpm golden --matrix`: the grader over every fixture ticket. Needs a running machine, a credential and docker.
- `pnpm golden:live`: abort, retry and concurrency paths in sequence. Needs a running machine with a credential and docker; concurrency needs the machine started with `MACHINE_MAX_CONCURRENT=1`.
- `pnpm --filter @hardness/machine smoke:sandbox`: runs the `evidence` and a dry-run `implementing` pack in the hardened container. Needs docker and `runner:build`; no machine or credential.
- `pnpm golden --selftest`: fixtures only. No machine, credential or docker.

- `pnpm golden --matrix` runs every ticket of `fixtures/golden-task`, `golden-web` and `golden-cli` (a bug and a feature each) and grades the suite, stages, stubs, evidence verdict, cost and diff size. It exits 1 under an 80% pass rate and writes `golden-result.json`; `--only <fixture>`, `--ceiling-usd` and `--threshold` tune it. The nightly `golden` workflow runs it. `node machine/scripts/golden-task.mjs --selftest` checks the fixtures without a machine.

`pnpm golden` drives `fixtures/golden-task/` through every gate of the pipeline
against a running machine, the same way the board would, and checks that the
implementer's fix makes its tests pass. Run it after any change to the engine,
the API, or the agents.

## Configuration

- **Credentials**: put `claude-oauth-token` or `anthropic-api-key` in
  `~/.config/hardness/`. Without one, the agent stages do not run for real.
- **Environment**: see `machine/.env.example`. The defaults match
  `compose.dev.yml`, so a `.env` is only needed to change them.
  - `DATABASE_URL` (default `postgres://hardness:hardness@127.0.0.1:5433/hardness`)
  - `MACHINE_PORT` (default `4317`)
  - `MACHINE_MAX_CONCURRENT` (default `4`): tasks driving a stage at once, across every repo
  - `MACHINE_GITHUB_POLL` (default empty, off): comma-separated `owner/name` repos whose open issues labelled `MACHINE_GITHUB_LABEL` (default `ready-for-agent`) become backlog tasks; needs the `gh` CLI signed in
  - `MACHINE_GITHUB_POLL_INTERVAL` (default `300`): seconds between polls
  - `RUNNER_IMAGE` (default `hardness-runner:dev`) and `RUNNER_QA_IMAGE` (default `hardness-runner-qa:dev`, used by the QA stage): stage images
- **Runner image**: `pnpm --filter @hardness/machine runner:build` runs
  `machine/runner/build.sh`, which bakes orc into the image at `/orc`. By default
  it archives the committed HEAD of `ORC_PATH` (`ORC_SOURCE=path`, default
  `~/Developer/system/orc`); `ORC_SOURCE=git ORC_REF=<tag|branch>` clones
  `HigorAlves/orc` instead. The image is tagged `hardness-runner:dev` and
  `hardness-runner:<orc sha>`. `runner-qa:build` runs the same script with `--qa`, then
  builds `hardness-runner-qa:dev` from `machine/runner-qa/Dockerfile` on top of it.
- **Board**: `HARDNESS_MACHINE_URL` overrides the machine address
  (default `http://127.0.0.1:4317`). `HARDNESS_REPOS_DIR` is where the board's
  repo search (`R`) looks for repos (default `~/Developer`).

## Shipping

Approving the Ship gate runs `git push -u origin <task branch>` from the task's
worktree, then `gh pr create` (or reuses the PR if one is already open for that
branch). It needs, on the host:

- The [`gh` CLI](https://cli.github.com/), signed in (`gh auth status`).
- A repo with an `origin` remote you can push to.

Without either, the stage fails with a clear reason and escalates — nothing
silently retries a `git push` against a repo with no remote.

## Factory mode

The agent stages run as [orc](https://github.com/HigorAlves/orc) stage packs
(`orc-stage run`) inside the stage container: Triage, Build and the later agent
stages each get a pack with its own prompt, tool allowlist and limits. The
sandbox guardrails stay: `settingSources: []`, the pack's tool allowlist, one
pinned orc plugin baked into the image at `/orc`, and read-only mounts for
everything the stage does not own.

## API example

```sh
curl -s -X POST 127.0.0.1:4317/tasks -H 'content-type: application/json' \
  -d '{"title":"Login page","criteria":["Bad password shows an error"]}'
curl -s -X POST 127.0.0.1:4317/tasks/<id>/start
curl -s -X POST 127.0.0.1:4317/tasks/<id>/decision -H 'content-type: application/json' \
  -d '{"decision":"approved"}'
curl -sN 127.0.0.1:4317/events      # live updates
curl -s '127.0.0.1:4317/metrics?since=7d'   # factory metrics (7d, 30d or ISO): cycle time, first-pass, escalations, cost; also streamed as task.metrics
```

Give a task a `"repoPath"` so the agents have a repo to work on. The full list
of routes is in [`docs/plans/0001-machine-dev.md`](docs/plans/0001-machine-dev.md).

## Docs

- [`board/README.md`](board/README.md): running the board, keys, ticket format.
- [`docs/plans/0001-machine-dev.md`](docs/plans/0001-machine-dev.md): the machine's design and routes.
- [`fixtures/golden-task/README.md`](fixtures/golden-task/README.md): the golden task fixture.

## Contributing and license

Issues and pull requests are welcome. Run `pnpm test`, `pnpm typecheck` and
`pnpm board:test` before sending a change. This repository does not yet include
a license file; the maintainers have to choose one.
