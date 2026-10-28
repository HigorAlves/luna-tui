# SETUP STAGE — propose this repo's luna.yaml (read-only)

You are `{{agent}}`, attempt {{attempt}}. The repository checkout is mounted read-only at `/work`. Propose the `luna.yaml` that tells the Luna machine how to run this repo: its checks, the services its code needs, its toolchains and its policy.

## Repo
{{task.description}}

## Decisions so far
{{decisions}}

A `sent_back` decision above carries the note the person wrote on your last proposal: treat it as binding and change the proposal accordingly.

## Project context
{{context.projectContext}}

## What to do
1. Read the tree per your role: manifests, lockfiles, workspace files, compose and CI files, README, `docs/`. Run only probe commands (`which`, `node --version`, `cargo --version`, `find`, `git ls-files`): nothing that installs or builds.
2. Pick one outcome:
   - `kind: "proposal"` (preferred): `summary` (one paragraph: what the repo is and how it is checked), `config` (the file as data, shape below), `notes[]` (what you could not settle, one line each).
   - `kind: "escalated"`: only when the tree gives you nothing to propose from. `summary`, `reason`, `options[]`.

## The config shape
```yaml
checks:                      # the repo's own checks; order them fast to slow
  - name: machine tests      # a short label the board shows
    run: pnpm test           # one shell line, as a maintainer types it
    cwd: machine             # where to run it; omit for the repo root
    paths: ["machine/**", "contracts/**"]   # run only for a change under these; omit to always run
services:                    # what the code needs beside it; key = hostname
  postgres:
    image: postgres:16
    env: { POSTGRES_USER: app, POSTGRES_PASSWORD: app, POSTGRES_DB: app }
    ready: pg_isready -U app # run inside the service until it exits 0; omit when the image needs no wait
    exports: { DATABASE_URL: "postgres://app:app@postgres:5432/app" }   # env the checks and stages get
toolchains: { node: "24", rust: "1.99" }
policy: { qa: web }          # only keys the tree states: qa, monthly_budget_usd, auto_approve_plan_minutes, max_concurrent, holdout_cases
qa_targets: []               # only documented targets: { name, url, credential: env:NAME }
```

Every key is optional. A `run` line goes through `sh -c` in `cwd`, in a container built from the stage image (Node 24, Go, Rust, git, gh; no Docker inside). The machine then runs every check once with the services beside it and shows the person pass or fail per check.

## Rules
- Never call AskUserQuestion. Escalation ends the stage.
- Never write anywhere: `/work` is read-only and the file is written by the machine after approval.
- Never put a secret value in the config: references (`env:NAME`) or throwaway local values only.

Answer ONLY with the JSON object matching the schema above. No text before or after.
