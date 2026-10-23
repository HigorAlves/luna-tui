# Hardness

Hardness is a local dev harness for working with AI coding agents. You plan
tickets on a board inside [herdr](https://herdr.dev/); a machine then moves each
ticket through a fixed pipeline, running Claude agents in throwaway Docker
containers, and stops at approval gates so you stay in control.

## Pipeline

Every ticket moves through five stages:

1. **Triage**: an agent reads the ticket and the repo, asks questions if needed, and proposes a plan.
2. **Build**: the implementer agent writes the change on a task branch (a git worktree on the host).
3. **Verify**: checks that the change works.
4. **Evidence**: gathers proof for the reviewer.
5. **Publish**: ships the result.

Triage and Build run as real Claude agents when a credential and the runner
image are available. The other stages are stubs that pass, unless you queue a
result with `POST /dev/stubs`. See `docs/plans/0001-machine-dev.md` for the
details.

## Repository layout

| Path | What it is |
|---|---|
| `board/` | Hardness Board, the Rust TUI and herdr plugin. A client of the machine. |
| `machine/` | The orchestrator: TypeScript on Node 24+, HTTP API plus an SSE stream, Postgres for state. |
| `contracts/` | Types shared by the machine and the board. |
| `fixtures/golden-task/` | A small repo with one seeded bug, used by `pnpm golden`. |
| `spikes/` | Throwaway experiments, kept with their results. |
| `docs/plans/` | Plans. Start with `0001-machine-dev.md`. |
| `compose.dev.yml` | Postgres for local development. |

## Prerequisites

- Docker (for Postgres and the stage containers)
- Node 24+ and pnpm
- Rust (to build the board)
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
- **Board**: `HARDNESS_MACHINE_URL` overrides the machine address
  (default `http://127.0.0.1:4317`).

## API example

```sh
curl -s -X POST 127.0.0.1:4317/tasks -H 'content-type: application/json' \
  -d '{"title":"Login page","criteria":["Bad password shows an error"]}'
curl -s -X POST 127.0.0.1:4317/tasks/<id>/start
curl -s -X POST 127.0.0.1:4317/tasks/<id>/decision -H 'content-type: application/json' \
  -d '{"decision":"approved"}'
curl -sN 127.0.0.1:4317/events      # live updates
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
