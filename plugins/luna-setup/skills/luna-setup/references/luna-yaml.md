# luna.yaml: the keys a setup touches

The full reference is `docs/configuration.md` in the Luna repository (https://github.com/HigorAlves/luna-tui/blob/main/docs/configuration.md).
The machine's `POST /repos/config/check` is the authority: when this page and the check disagree, the check wins.

Every key is optional. Durations are `30m`, `4h`, `3d` or `off`.

## What the tree decides

```yaml
checks:                        # what a maintainer runs before merging; fast to slow
  - name: unit                 # the label the board shows
    run: pnpm test             # one shell line (sh -c), the non-watch form
    cwd: web                   # omit for the repo root
    paths: ["web/**"]          # run only for a change under these; omit to always run
    coverage: coverage/lcov.info   # optional: an lcov report the run writes, relative to cwd
    minutes: 4                 # optional: how long it takes
services:                      # what the checks need beside them; the key is the hostname
  postgres:
    image: postgres:16
    env: { POSTGRES_USER: app, POSTGRES_PASSWORD: app, POSTGRES_DB: app }   # throwaway local values only
    ready: pg_isready -U app
    exports: { DATABASE_URL: "postgres://app:app@postgres:5432/app" }
toolchains: { node: "24", rust: "1.99" }
verify:
  e2e:
    start:                     # how the browser check starts the app from a card's branch (repos with pages only)
      command: "pnpm --filter web dev --hostname 0.0.0.0 --port 3000"
      port: 3000               # default 3000
      ready: /                 # default /
      ready_timeout_s: 180     # default 120
      secrets: []              # names of secrets the app needs, read from the machine's secrets folder
sandbox:
  egress:
    allow: [fonts.googleapis.com]   # hosts beyond the lockfiles' registries and GitHub; `host`, `host:port` or `*.suffix`
  cpu: 2                       # per stage container; default 2
  memory_gb: 4                 # default 4
```

Names the machine keeps for itself: no service and no check may be called `luna-app`.

## What the person decides

```yaml
policy:
  qa: web                      # web: the browser check runs when a change renders; none: never
  monthly_budget_usd: 40       # this repo's tasks park once the month has cost this much
  auto_approve_plan_minutes: 15   # a low-risk plan whose checks all passed is approved by itself after this long
  max_concurrent: 1            # tasks this repo may run at once
  holdout_cases: false         # true keeps the scenarios away from the implementer
plan:
  approvers: { low: 1, medium: 1, high: 1, outside_owning_team: true }
ship:
  auto_merge: medium_when_review_required   # off | low | medium | medium_when_review_required (the default)
  preview: off
sla:
  gate: 2d                     # a gate waiting on a person
  cycle: 3d                    # created to closed
engines:                       # a pack's engine in this repo, over its default (GET /packs lists what each allows)
  verifying: codex:sol
qa_targets:                    # where the browser check may drive a deployed app; the credential is a reference, never a value
  - { name: staging, url: https://stg.example.com, credential: env:QA_PASSWORD, reentrant: false }
freeze:
  - { from: "2026-12-20", to: "2027-01-03", reason: "holiday freeze" }
```

`jira`, `conversation`, `tickets`, `triage`, `scoring`, `fast_lane`, `size`, `build`, `evidence` and the rest keep their defaults
unless the person asks for them: read `docs/configuration.md` before writing one.
