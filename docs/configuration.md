# Configuration

## Credentials

Put `claude-oauth-token` or `anthropic-api-key` in `~/.config/hardness/`. Without one, the agent stages do not run for real.

## Environment

See `machine/.env.example`. The defaults match `compose.yaml`, so a `.env` is only needed to change them; `pnpm dev` and `pnpm start` both load it automatically if it exists.

| Variable | Default | What it does |
|---|---|---|
| `DATABASE_URL` | `postgres://hardness:hardness@127.0.0.1:5433/hardness` | Postgres connection string |
| `MACHINE_PORT` | `4317` | HTTP port the machine listens on |
| `MACHINE_MAX_CONCURRENT` | `4` | tasks driving a stage at once, across every repo |
| `MACHINE_AGENTS` | on | set to `off` to make every stage a stub (no credential or Docker needed) |
| `MACHINE_GITHUB_POLL` | empty, off | comma-separated `owner/name` repos whose open issues labelled `MACHINE_GITHUB_LABEL` become backlog tasks; needs the `gh` CLI signed in |
| `MACHINE_GITHUB_POLL_INTERVAL` | `300` | seconds between GitHub polls |
| `MACHINE_GITHUB_LABEL` | `ready-for-agent` | the issue label GitHub intake looks for |
| `RUNNER_IMAGE` | `hardness-runner:dev` | the stage container image |
| `RUNNER_QA_IMAGE` | `hardness-runner-qa:dev` | the QA stage image; without it e2e is skipped |
| `WORKTREES_DIR` | `~/Developer/worktrees` | where task worktrees are created, as `<worktreesDir>/<repo>/<branch>` |
| `MACHINE_STATE_DIR` | `~/.local/state/hardness` | where run artifacts, transcripts and ingested output live |
| `HERDR_BIN` | `herdr` | path to the herdr binary, for live-following a running stage container |
| `MACHINE_RETENTION_DAYS` | `90` | days to keep a closed task's events/stage-runs before pruning (`0` disables pruning) |

## Runner image

`pnpm --filter @hardness/machine runner:build` runs `machine/runner/build.sh`, which bakes orc into the image at `/orc`. By default it archives the committed HEAD of `ORC_PATH` (`ORC_SOURCE=path`, default `~/Developer/system/orc` — override with `ORC_PATH=/your/path` if orc lives elsewhere); `ORC_SOURCE=git ORC_REF=<tag|branch>` clones `HigorAlves/orc` instead. The image is tagged `hardness-runner:dev` and `hardness-runner:<orc sha>`. `runner-qa:build` runs the same script with `--qa`, then builds `hardness-runner-qa:dev` from `machine/runner-qa/Dockerfile` on top of it.

## Board

`HARDNESS_MACHINE_URL` overrides the machine address (default `http://127.0.0.1:4317`). `HARDNESS_REPOS_DIR` is where the board's repo search (`R`) looks for repos (default `~/Developer`).
