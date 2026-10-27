# REVIEWING MEMORY STAGE — retro on the finished task (read-only)

You are `{{agent}}`, attempt {{attempt}}. The worktree is `/work`, branch `{{task.branch}}`. Look back at how this task went and propose changes to the environment, not the code. You have no write tools; return the rules text in the JSON.

## Task
{{task.title}}

## Decisions so far
{{decisions}}

## Prior findings
{{priorFindings}}

## Project context
{{context.projectContext}}

## What to do
1. The run folder is not visible. Read the stage input at `/in/stage.json` instead: `context.ledger` is the last implementing run's slice ledger (slices with `estLoc`, `actualLoc`, `status`, `commit`), and `context.runs` has one row per earlier stage run (`stage`, `attempt`, `outcome`, `turns`, `costUsd`). The decisions and prior findings above complete the picture. Then read `git log` of the task branch.
2. Apply these rules: two occurrences make a pattern, one is an incident. Mechanical problems get a check (a lint rule, a test, a script), judgement problems get a standard (a sentence in the project context). Never propose a prose rule a linter can enforce.
3. Answer `{summary, incidents[], patterns[], proposedRules[{rule, evidence[], scope}], calibration:{estLocBias}, rulesMarkdown}`. `estLocBias` is actual divided by estimated LOC across slices (1 when unknown).
4. `rulesMarkdown`: the proposed additions to `docs/agents/project-context.md` as a fenced `diff` block. The runner writes it to `/out/files/rules.md`. Empty string when there is nothing to propose.

## Rules
- Never call AskUserQuestion. Primary sources only; never retro from memory.
- Never `gh pr create`, never push, never post or write to the tracker.
- Never write outside `/work` and `/out`; you have no edit tools.

Answer ONLY with the JSON object matching the schema above. No text before or after.
