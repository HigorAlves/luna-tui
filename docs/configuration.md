# Configuration

## Credentials

Put `claude-oauth-token` or `anthropic-api-key` in `~/.config/hardness/`. Without one, the agent stages do not run for real.

## Environment

See `machine/.env.example`. The defaults match `compose.yaml`, so a `.env` is only needed to change them; `pnpm dev` and `pnpm start` both load it automatically if it exists.

| Variable | Default | What it does |
|---|---|---|
| `DATABASE_URL` | `postgres://hardness:hardness@127.0.0.1:5433/hardness` | Postgres connection string |
| `MACHINE_PORT` | `4317` | HTTP port the machine listens on |
| `MACHINE_HOST` | `127.0.0.1` | interface the API binds to (`0.0.0.0` inside the compose container) |
| `MACHINE_MAX_CONCURRENT` | `4` | tasks driving a stage at once, across every repo |
| `MACHINE_MAX_PER_REPO` | unset | running tasks one repo may hold at once, so it cannot take every slot; unset means no cap. Claims go oldest-queued first, the repo with the fewest running tasks first. A repo's own `PIPELINE.md` (`max_concurrent`) overrides it for that repo |
| `MACHINE_MAX_PER_STAGE` | unset | `stage=n` pairs, e.g. `implementing=2,e2e=1`: tasks that may drive one stage at once. A task whose next stage is at cap waits in the queue, state kept (`stage.held`). `ci_watch` never holds a slot: it polls GitHub outside the pool and takes a slot again (or queues) for the stage after |
| `MACHINE_AGENTS` | on | set to `off` to make every stage a stub (no credential or Docker needed) |
| `MACHINE_GITHUB_POLL` | empty, off | comma-separated `owner/name` repos whose open issues labelled `MACHINE_GITHUB_LABEL` land in Intake as tasks; needs `GITHUB_TOKEN` |
| `MACHINE_GITHUB_POLL_INTERVAL` | `300` | seconds between GitHub polls |
| `MACHINE_GITHUB_LABEL` | `ready-for-agent` | the issue label GitHub intake looks for |
| `MACHINE_GITHUB_PRS` | on | `off` stops the PR inbox from polling GitHub; the board's `P` view then shows nothing |
| `MACHINE_GITHUB_PRS_INTERVAL` | `60` | seconds between PR inbox polls; a rate-limited answer backs the next poll off to five minutes |
| `MACHINE_REPO_MAP` | unset | `owner/name=/abs/path` pairs: the checkout an imported issue's task works in. Without a match, the checkouts one level under `MACHINE_REPOS_DIR` are matched by their `origin` remote |
| `MACHINE_REPOS_DIR` | `~/Developer` | where `MACHINE_REPO_MAP`'s fallback scan looks |
| `MACHINE_THREAD_REPLIES` | on | set to `off` to stop the machine replying in the thread a task came from (a comment on its GitHub issue; a Slack thread when the pair below is set) when it is picked up, needs you, escalates, pauses, gets its PR and closes |
| `MACHINE_SLACK_TOKEN` / `MACHINE_SLACK_CHANNEL` | unset | a bot token (`chat:write`) and a channel id: one Slack thread per task is opened there and every reply above lands in it. Both or neither |
| `RUNNER_IMAGE` | `hardness-runner:dev` | the stage container image |
| `RUNNER_QA_IMAGE` | `hardness-runner-qa:dev` | the QA stage image; without it e2e is skipped |
| `WORKTREES_DIR` | `~/Developer/worktrees` | where task worktrees are created, as `<worktreesDir>/<repo>/<branch>` |
| `MACHINE_STATE_DIR` | `~/.local/state/hardness` | where run artifacts, transcripts and ingested output live |
| `MACHINE_RETENTION_DAYS` | `90` | days to keep a closed task's events/stage-runs before pruning (`0` disables pruning) |
| `MACHINE_WORKTREE_RETENTION_DAYS` | `7` | days after a task closes before the nightly sweep removes its worktree and deletes its branch if merged (`0` disables). The same sweep removes run folders no stage run owns and untags superseded `hardness-runner*:<sha>` images |
| `MACHINE_RESTART_POLICY` | `requeue` | what happens to a task mid-stage when the machine stops: `requeue` parks it (its stage re-runs on the next boot, no approval), `escalate` leaves it for you to resume. A stage container still running when the machine comes back (a crash, not a shutdown) is re-attached instead: the machine waits on it and ingests its result (`stage.reattached`) |
| `MACHINE_TASK_BUDGET_USD` | unset, no ceiling | a task that has spent this much escalates before its next stage, with the amounts as the reason |
| `MACHINE_DAILY_BUDGET_USD` | unset, no ceiling | once the trailing 24 hours have cost this much, nothing new is claimed and running tasks park in the queue between stages; `/metrics` shows `budget.remainingTodayUsd` |

Every ceiling (a task's, a repo's month's from its `PIPELINE.md`, the day's) raises a `budget.alert` on `/events` the first time a run takes the spend past 80, 90 and 100% of it; the board shows each as a notice. Nothing runs while a task waits on you, so idle time costs nothing: a stage container lives only for its stage.

## Per-repo config: `luna.yaml`

Everything the machine needs to run one repo lives in a `luna.yaml` at that repo's root: how to check it, what runs beside it, and how the pipeline should behave. The board's `:setup <repo>` command has an agent read the repo and propose the file, proves every proposed check once and writes the file after you approve it; you can also write it by hand. The machine reads it from the checkout (not the task worktree) at every stage, so an edit takes effect without a restart and an uncommitted file already counts; a version that does not parse is reported once and the last good one stays in force.

```yaml
checks:                                   # the repo's own checks; without this key they are detected from the tree
  - name: board tests
    run: cargo test                       # a shell line, run in cwd (default: the worktree root)
    cwd: board
    paths: ["board/**"]                   # only for a change touching one of these; no paths means always
  - name: machine tests
    run: pnpm test
    cwd: machine
    paths: ["machine/**", "contracts/**"]
services:                                 # run beside every stage and check container, reachable by key as hostname
  postgres:
    image: postgres:16
    env: { POSTGRES_USER: app, POSTGRES_PASSWORD: app, POSTGRES_DB: app }
    ready: pg_isready -U app              # run inside the service until it exits 0
    exports: { DATABASE_URL: "postgres://app:app@postgres:5432/app" }   # env the repo's code gets
toolchains: { node: "24", rust: "1.99" }  # what the repo builds with; recorded by setup
policy:
  qa: web                                 # web (default) runs e2e when the change renders; none never does
  monthly_budget_usd: 40                  # this repo's tasks park once the calendar month has cost this much
  auto_approve_plan_minutes: 15           # a plan triage marked high confidence / low risk is approved by itself after this long
  max_concurrent: 1                       # running tasks this repo may hold at once (over MACHINE_MAX_PER_REPO)
  holdout_cases: false                    # true keeps test_design's cases away from the implementer; verifying still judges by them
qa_targets:                               # where e2e may drive the app; the credential is a reference, never a value
  - { name: staging, url: https://stg.example.com, credential: env:QA_PASSWORD }
```

Every key is optional and unknown keys are ignored. `auto_approve_plan_minutes` needs triage to report `confidence: high` and `risk: low` and to have asked nothing; anything less waits for you as always, and the approval it does make is logged as `plan.auto_approved` with the reason on the approval.

Each `services` entry runs as its own container beside every stage that runs the repo's code (implementing, verifying, e2e) and every check run, on a private docker network for that run, reachable by its key as hostname; the `exports` become env in the stage or check container. They are torn down with it, so two tasks of one repo never share a database. A service whose `ready` line does not exit 0 within a minute escalates the stage with the service's log tail.

`PIPELINE.md` (the earlier per-repo file, front matter with the `policy` keys and `qa_target` lines) still works when there is no `luna.yaml`, with a deprecation notice once per repo; `luna.yaml` wins when both exist.

## GitHub gates

`pnpm --filter @hardness/machine gates owner/name [--checks board,machine] [--dry-run]` applies a repository ruleset named `hardness gates` to the default branch: one approving review from someone other than the last pusher, reviews dismissed when the branch moves, no deletion, no force-push, and the named checks green. GitHub enforces it whatever an agent does; the pipeline cannot approve its own PR. The machine's side of the same gate: a writable stage refuses any branch outside `task/`.

## Environment cache

Every stage and check container mounts a docker volume named `hardness-cache-<repo>` at `/cache`, with npm, pnpm, yarn, Go, cargo, pip and uv pointed at it. A retry, or the next task of the same repo, installs from that warm cache instead of the network. `docker volume rm hardness-cache-<repo>` starts a repo over.

## Compose

`docker compose up` (and `pnpm start`) runs the machine in a container that drives your host's Docker through its socket. Every path the machine hands to `docker run` must exist at the same path on the host, so the compose file mounts these at identical paths:

| Variable | Default | What it does |
|---|---|---|
| `MACHINE_DOCKER_PORT` | `4318` | host port for the machine container (`pnpm dev` keeps `4317`) |
| `LUNA_REPOS_DIR` | `~/Developer` | where your repos live; task repo paths must be inside it, and so must `WORKTREES_DIR` |
| `MACHINE_STATE_DIR` | `~/.local/state/hardness` | run folders, mounted into stage containers |
| `GITHUB_TOKEN` / `GH_TOKEN` | unset (`pnpm start` passes `gh auth token` as `GH_TOKEN`) | the token every GitHub API call uses (PRs, checks, reviews, the PR inbox); `GITHUB_TOKEN` wins when both are set. In the container it also lets `git push` reach GitHub over https; `git@github.com:` and `ssh://` remotes are rewritten to https there |
| `LUNA_GIT_NAME`, `LUNA_GIT_EMAIL` | your `git config` (via `pnpm start`) | identity for commits the machine makes itself (the approved memory rules) |

`~/.config/hardness` is mounted read-only for the Claude credential. The other variables in the table above pass through to the container as well.

## Runner image

The image carries Node 24, Go and a pinned Rust toolchain (`RUST_VERSION` in `machine/runner/Dockerfile`, with clippy and rustfmt), so a repo whose suite is `cargo test` runs as is. Every check container also gets your git identity, the `user.name` and `user.email` git resolves for the repo, so a suite that commits in a scratch repo runs as you; a repo with no identity escalates the verifying stage instead of committing as nobody.

`pnpm --filter @hardness/machine runner:build` runs `machine/runner/build.sh`, which builds the image from this checkout with the repository root as the build context: `factory/` and `contracts/` are copied in and installed with the workspace lockfile, so the image runs exactly what the checkout tests. Each image is labelled with a key over those files and the Dockerfile and skipped when that key is current, so `pnpm images` (run by `pnpm start` and `pnpm dev`) is instant when nothing changed; `REBUILD=1 pnpm images` builds anyway. The image is tagged `hardness-runner:dev` and `hardness-runner:<key>`. `runner-qa:build` runs the same script with `--qa`, then builds `hardness-runner-qa:dev` from `machine/runner-qa/Dockerfile` on top of it.

Inside a stage container the runner sees `/in/stage.json`, `/out`, `/work` (the worktree) and `/session` (the task's SDK session dir, `CLAUDE_CONFIG_DIR`). `LUNA_FACTORY=1` marks the run; `LUNA_STAGE_DRY_RUN=1` renders the prompt and the SDK options without a model call (the sandbox smoke uses it). A repo may keep binding rules for every stage in `docs/agents/project-context.md`; the memory review proposes additions to it.

## Board

The board uses whichever machine answers: `http://127.0.0.1:4317` (`pnpm dev`) first, then `http://127.0.0.1:4318` (`pnpm start`), checked again on every reconnect. `HARDNESS_MACHINE_URL` pins one address instead. `HARDNESS_REPOS_DIR` is where the board's repo search (`R`) looks for repos (default `~/Developer`).
