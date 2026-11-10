---
name: luna-setup
description: Set Luna up on the current repository, or fix the setup it has. Drafts the repo's luna.yaml (checks, services, toolchains, how the browser check starts the app, the sandbox's egress hosts) with the person, checks it against the machine, proves every check in the machine's sandbox, and opens it as a PR. Use when the person asks to set up, onboard, configure or connect Luna (or "the machine", "hardness") on a repo, to write or fix a luna.yaml, or when Luna's runs on a repo fail for setup reasons (a check that cannot run, a host the sandbox refused, an e2e app that never starts).
---

# Set Luna up on this repository

Luna runs a repository from one file at its root, `luna.yaml`: how to check it, what runs beside it, how to start its app for the
browser check, which hosts its sandbox may reach, and how the pipeline should behave. You write that file with the person, the machine
checks and proves it, and it lands as a PR. `references/luna-yaml.md` (next to this file) lists the keys; read it before you draft.

Work in this order and keep the person posted in one line per step. Never put a secret value in the file: it is committed. A credential
is a reference (`env:NAME`), a service's env holds throwaway local values.

## 1. Find the machine

The machine's API is `${LUNA_MACHINE_URL:-http://127.0.0.1:4318}`, its token in `~/.config/hardness/machine-api-token`:

```bash
LUNA="${LUNA_MACHINE_URL:-http://127.0.0.1:4318}"
AUTH="Authorization: Bearer $(tr -d '[:space:]' < ~/.config/hardness/machine-api-token)"
curl -sf -H "$AUTH" "$LUNA/health" >/dev/null && echo up || echo down
```

- Down or no token: say so, and offer to go on without it (draft and write the file; the check and the proof wait for the machine).
  The person starts it with `pnpm start` in the Luna checkout.
- The machine sees only repositories under `LUNA_REPOS_DIR` (`~/Developer` by default). If this repo is elsewhere, say so before step 5.

## 2. Read the repository

If a `luna.yaml` exists, check it first (step 4) and treat this run as fixing it: keep what works, ask before removing anything.

Read, do not build or install:
- Manifests and lockfiles, **at the root and in subfolders** (`find . -name package.json -o -name Cargo.lock -o -name go.mod -o -name pyproject.toml -o -name Gemfile.lock | grep -v node_modules`), workspace files.
- CI workflows (`.github/workflows/*`): the commands CI runs are the best list of checks, and its `services:` blocks the best list of services.
- `compose.yaml`/`docker-compose.yml`, `.env.example`, test setup files: databases, caches, brokers, and the env the code reads.
- The README's development section and `docs/`.
- Script bodies, not only names: `"test": "vitest"` is a watcher; the check is `vitest run`.

Draft from what you read:
- **checks**: one per command a maintainer runs before merging, in its folder, fast to slow, with `paths` when a check only matters for part of the tree.
- **services**: each one the tests need, with `ready` and the `exports` the code reads.
- **toolchains**: from `engines`, `.nvmrc`, `rust-toolchain`, `go.mod`, `.python-version`, CI matrices.
- **verify.e2e.start**, for a repo that renders pages: the serving package's `dev` or `start` script, bound to `0.0.0.0` with the framework's
  flag (`--hostname`, `--host`, `-H`), its port and a ready path. The browser runs in another container, so `localhost` binding never works.
  No pages (a library, a CLI, an API with no UI): leave it out and set `policy.qa: none`.
- **sandbox.egress.allow**: every check and the app run behind a proxy that lets out only GitHub and the package registries of the
  repo's lockfiles (a tracked lockfile in a subfolder counts too, for its ecosystem's public registry). Add what else the tree shows a
  need for, with a comment saying why: a custom registry a subfolder's lockfile names, a tool a script downloads (corepack fetches pnpm
  from `registry.npmjs.org`), fonts or assets fetched at build time (`fonts.googleapis.com`, `fonts.gstatic.com`), an API the tests call.

## 3. Ask the person what only they can decide

Use the AskUserQuestion tool, at most two rounds of up to four questions, each option with what it does; put your suggestion first.
Ask only what the tree cannot answer:
- **Spend and pace**: `policy.monthly_budget_usd`, `policy.max_concurrent`.
- **How much the machine does alone**: `policy.auto_approve_plan_minutes` (off, or minutes), `ship.auto_merge` (`off`, `low`,
  `medium_when_review_required`, `medium`), `plan.approvers`.
- **The browser check**: confirm the start command and port you found, or `policy.qa: none`; a deployed target (`qa_targets`) only if
  the person names one.
- **Anything you could not settle** from the tree (a check you are unsure runs, a service whose image you guessed).

Leave every other section at its default unless the person asks for it.

## 4. Write the file and check it

Write `luna.yaml` at the repository root: the sections in the reference's order, a comment on every entry that is not obvious (why a
host is allowed, why a check is scoped). Then check it:

```bash
jq -Rs '{text: .}' luna.yaml | curl -sf -X POST -H "$AUTH" -H 'content-type: application/json' --data @- "$LUNA/repos/config/check"
```

The answer is `{ok, problems[], warnings[], unknownKeys[]}`. Fix every problem. An unknown key is ignored by the machine, so it is almost
always a typo: fix it or remove it. Read the warnings to the person. Check again until `ok` is true and `unknownKeys` is empty.

## 5. Prove it in the sandbox

The proof runs in a throwaway clone of the repository, made as a card's workspace is (never in this checkout): every check once in the
machine's sandbox, with the file's services beside it and its egress list, exactly as a card's checks run; then, when the file has
`verify.e2e.start`, the app is started the way the browser check starts it and must answer its ready path. It reads the file from disk,
so write it first. It is a job:

```bash
JOB=$(curl -sf -X POST -H "$AUTH" -H 'content-type: application/json' -d "{\"repoPath\":\"$(pwd -P)\"}" "$LUNA/repos/config/prove" | jq -r .id)
until [ "$(curl -sf -H "$AUTH" "$LUNA/repos/config/prove/$JOB" | jq -r .state)" != running ]; do sleep 15; done
curl -sf -H "$AUTH" "$LUNA/repos/config/prove/$JOB" | jq '{state, error, check, proof: (.proof | {proof: [.proof[] | {name, ok, tail}], app, refused}), suggestedAllow}'
```

A proof installs the dependencies in the clone and runs every check, so it can take a while (up to 30 minutes, plus the app's
`ready_timeout_s`); poll in the background and tell the person it is running. Then, for each result:
- **A check failed**: read its `tail`. A wrong command or folder is yours to fix. A missing service or env is yours to add. A host in
  `refused` explains most "fetch failed" and "could not resolve" errors.
- **`suggestedAllow`** names the hosts a check was refused, as entries for `sandbox.egress.allow`. Do not add them silently: show each with
  the check that wanted it, and add the ones the person agrees a check needs. A host nobody expected is worth a question, not an entry.
- A check that cannot pass in a sandbox (it needs a real cloud account, a GPU, Docker inside) comes out of `checks`, with a comment.
- **`app`** is the app start: `ok` with the `seconds` it took to answer, or the `reason` it did not and its `logTail`. Not answering is
  usually a `localhost` binding (bind `0.0.0.0`), the wrong port or ready path, a `ready_timeout_s` too short for a first build, an env
  var the app reads (a service's `exports`, or a secret in `verify.e2e.start.secrets`), or a host in `refused` (fonts, an API).

Prove again after every change, until every check passes and the app answers, or the person accepts what still fails.

## 6. Open it as a PR

Ask before pushing. Then:

```bash
git switch -c luna/setup
git add luna.yaml
git commit -m "chore: set Luna up on this repository"
git push -u origin luna/setup
gh pr create --fill
```

Follow the repository's own PR template when it has one (`.github/pull_request_template.md` and the other places GitHub reads). Otherwise
keep the body short: what the file sets up, which checks passed in the sandbox, which hosts it allows and why, and anything still open.
Credit no AI in the commit or the PR.

End with one line for the person: the PR link, how many checks passed, and what to do next (merge it, then create the first card).

## Without the machine

Everything but steps 4 and 5 still works. Write the file, tell the person the check and the proof are still owed, and give them the two
calls to run once the machine is up.
