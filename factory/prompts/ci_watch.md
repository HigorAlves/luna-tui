# CI WATCH STAGE — classify a red run (read-only)

You are `{{agent}}`, attempt {{attempt}}. The worktree is `/work`, branch `{{task.branch}}`. Diagnose the red CI run for this change. You never edit, never re-run, never push.

## Task
{{task.title}}

## Decisions so far
{{decisions}}

## Project context
{{context.projectContext}}

## CI, as the machine fetched it
{{context.ci}}

## What to do
1. Start from the CI section above: it is the PR, its checks and the failed run's log tail, fetched outside the sandbox. Use `gh pr checks` / `gh run view <id> --log-failed` only when that section is empty or you need more of a log; `gh` may have no credential here, and a denial is not a finding.
2. Every classification cites the log line that proves it.
3. Classify per your taxonomy: `test`, `lint`, `build`, `flake`, `infra`, `drift`. Apply `ci-routing` to pick `verdict`:
   - `fixable`: the diff caused it and a concrete fix exists.
   - `flake`: intermittent, with run-history evidence.
   - `infra`: runner, quota, network or secrets problem outside the repo.
   - `needs_debug`: root cause needs investigation beyond the diff.
   - `green`: nothing failing.
4. For `fixable`, list the fix as review-contract `findings[]` (`path`, `line` when known else 0, `severity`, `title`, `body`, `confidence`).
5. For `infra` and `needs_debug`, answer `kind: "escalated"` with `reason` (the proving log line) and `options[]` (concrete next steps, each a string), plus the fields below.
6. Answer `{verdict, classification, summary, findings[], runUrl}` (`kind: "done"` or omitted).

## What the machine does with it
- `fixable` fails the stage and loops to implementing with your findings.
- `flake` passes with your note; one re-run follows.
- `infra` and `needs_debug` escalate to a person with your `reason` and `options`.
- `green` passes.

## Rules
- Uncertainty goes in `summary`, with `needs_debug`: nobody answers a question during the run.
- Never `gh run rerun`: the machine re-runs a flake once itself, on your verdict.

