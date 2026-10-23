# Hardness

A local dev harness: a board in herdr where you plan tickets, and a machine that
moves each ticket through stages (triage, build, verify, evidence, publish) with
Claude agents running in throwaway Docker containers.

| Folder | What it is |
|---|---|
| `board/` | Hardness Board, the Rust TUI and herdr plugin. |
| `machine/` | The orchestrator, TypeScript on Node 24+. |
| `contracts/` | Types shared by the machine and the board. |
| `spikes/` | Throwaway experiments, kept with their results. |
| `docs/plans/` | Plans. Start with `0001-machine-dev.md`. |

## Dev setup

Needs Docker Desktop, Node 24+, pnpm and Rust.

```sh
pnpm install
pnpm db:up            # Postgres for the machine, on 127.0.0.1:5433
pnpm --filter @hardness/machine runner:build   # the stage container image
pnpm dev              # the machine on http://127.0.0.1:4317, with hot reload
pnpm board:build      # the board; then `herdr plugin link ./board` once
```

Checks:

```sh
pnpm test             # machine and contracts
pnpm typecheck
pnpm board:test       # board
```

`pnpm db:down` stops Postgres and keeps its data.

## The golden task

`pnpm golden` drives a small fixture (`fixtures/golden-task/`, one seeded bug) through
every gate of the pipeline against a running machine, the same way the board would,
and checks the implementer's fix actually makes its tests pass. It's the regression
check for the whole graph — run it after any change to the engine, the API, or the
agents.

## Try the machine

```sh
curl -s -X POST 127.0.0.1:4317/tasks -H 'content-type: application/json' \
  -d '{"title":"Login page","criteria":["Bad password shows an error"]}'
curl -s -X POST 127.0.0.1:4317/tasks/<id>/start
curl -s -X POST 127.0.0.1:4317/tasks/<id>/decision -H 'content-type: application/json' \
  -d '{"decision":"approved"}'
curl -sN 127.0.0.1:4317/events      # live updates
```

Triage and Implementer run as real Claude agents in Docker when the machine finds a
credential in `~/.config/hardness/` (`claude-oauth-token` or `anthropic-api-key`) and
the runner image exists. Give the task a `"repoPath"` so they have a repo to work on.
The other stages are stubs that pass, unless you queue a result with `POST /dev/stubs`.
The routes are listed in `docs/plans/0001-machine-dev.md`.

## The board

The board (see `board/README.md`) is a client of the machine: it has no tickets of
its own, reads and writes through the API above, and follows `/events` for live
updates. Run the machine first; the board still starts without it, shows "machine
offline" in the header, and reconnects on its own once the machine is up.
