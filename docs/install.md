# Install

## Prerequisites

- Docker (for Postgres and the stage containers)
- Node 24+ and pnpm
- Rust (to build the board)
- Nothing else. `pnpm start` and `pnpm dev` build both stage images first (`pnpm images`) from this checkout: the runner image (the factory runner and the Agent SDK) and the QA image on top of it, which adds Playwright with Chromium, ffmpeg and agent-browser (about 2 GB more disk: 3.9 GB against 1.9 GB). The first build takes a while; later ones reuse Docker's cache.
- [herdr](https://herdr.dev/), to run the board as a plugin

## Quick start

```sh
pnpm install
pnpm start            # builds the stage images, then Postgres + the machine on http://127.0.0.1:4318, in Docker
pnpm board:build      # the board; then `herdr plugin link ./board` once
```

## Two ways to run

- **`pnpm start`** (or `docker compose up -d`): Postgres and the machine both run in Docker, so there's no server to keep open in a terminal. It passes your `gh auth token` and git identity to the machine; `pnpm stop` stops both and keeps the data. Stage containers still run on your Docker, so repos, worktrees and run folders are mounted at the same paths as on your host (see [configuration.md](./configuration.md#compose)).
- **`pnpm dev`**: for working on the harness itself. It stops the machine container, starts only Postgres (`docker compose up postgres`), and runs the machine on your host at http://127.0.0.1:4317 with hot reload, loading `machine/.env` if one exists. `pnpm db:down` stops Postgres and keeps its data.

Both use the same database, so tasks carry over when you switch. For board usage and keys, see [`board/README.md`](../board/README.md).

## Checks

```sh
pnpm test             # machine, contracts and factory
pnpm typecheck
pnpm board:test       # board
pnpm golden           # end-to-end, needs a running machine
```

- `pnpm golden`: one ticket through every gate. Needs a running machine; a credential and docker for real agent stages, otherwise stubs.
- `pnpm golden --matrix`: the grader over every fixture ticket. Needs a running machine, a credential and docker.
- `pnpm golden:live`: abort, retry and concurrency paths in sequence. Needs a running machine with a credential and docker; concurrency needs the machine started with `MACHINE_MAX_CONCURRENT=1`.
- `pnpm --filter @hardness/machine smoke:sandbox`: runs the `evidence` and a dry-run `implementing` pack in the hardened container. Needs docker and `runner:build`; no machine or credential.
- `pnpm golden --selftest`: fixtures only. No machine, credential or docker.
- `pnpm --filter @hardness/factory test`: the runner's own tests: the guards, the prompt renderer, the ledger tools, the result writer, and a dry run of every pack.

`pnpm golden --matrix` runs every ticket of `fixtures/golden-task`, `golden-web` and `golden-cli` (a bug and a feature each) and grades the suite, stages, stubs, evidence verdict, cost and diff size. It exits 1 under an 80% pass rate and writes `golden-result.json`; `--only <fixture>`, `--ceiling-usd` and `--threshold` tune it. The nightly `golden` workflow runs it. `node machine/scripts/golden-task.mjs --selftest` checks the fixtures without a machine.

`pnpm golden` drives `fixtures/golden-task/` through every gate of the pipeline against a running machine, the same way the board would, and checks that the implementer's fix makes its tests pass. Run it after any change to the engine, the API, or the agents.
