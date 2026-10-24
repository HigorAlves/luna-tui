# Install

## Prerequisites

- Docker (for Postgres and the stage containers)
- Node 24+ and pnpm
- Rust (to build the board)
- Optional, for the E2E stage: the QA image (`pnpm --filter @hardness/machine runner-qa:build`). It adds Playwright with Chromium, ffmpeg and agent-browser on top of the runner image, so expect about 2 GB more disk (a 3.9 GB image against 1.9 GB). Without it E2E is skipped with a note and the rest of the factory runs.
- [herdr](https://herdr.dev/), to run the board as a plugin

## Quick start

```sh
pnpm install
pnpm --filter @hardness/machine runner:build   # the stage container image
pnpm start            # Postgres + the machine on http://127.0.0.1:4317, in Docker
pnpm board:build      # the board; then `herdr plugin link ./board` once
```

## Two ways to run

- **`pnpm start`** (or `docker compose up -d`): Postgres and the machine both run in Docker, so there's no server to keep open in a terminal. It passes your `gh auth token` and git identity to the machine; `pnpm stop` stops both and keeps the data. Stage containers still run on your Docker, so repos, worktrees and run folders are mounted at the same paths as on your host (see [configuration.md](./configuration.md#compose)). herdr watch panes are off in this mode, since herdr runs on the host.
- **`pnpm dev`**: for working on the harness itself. It stops the machine container, starts only Postgres (`docker compose up postgres`), and runs the machine on your host with hot reload, loading `machine/.env` if one exists. `pnpm db:down` stops Postgres and keeps its data.

Both use the same database, so tasks carry over when you switch. For board usage and keys, see [`board/README.md`](../board/README.md).

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

`pnpm golden --matrix` runs every ticket of `fixtures/golden-task`, `golden-web` and `golden-cli` (a bug and a feature each) and grades the suite, stages, stubs, evidence verdict, cost and diff size. It exits 1 under an 80% pass rate and writes `golden-result.json`; `--only <fixture>`, `--ceiling-usd` and `--threshold` tune it. The nightly `golden` workflow runs it. `node machine/scripts/golden-task.mjs --selftest` checks the fixtures without a machine.

`pnpm golden` drives `fixtures/golden-task/` through every gate of the pipeline against a running machine, the same way the board would, and checks that the implementer's fix makes its tests pass. Run it after any change to the engine, the API, or the agents.
