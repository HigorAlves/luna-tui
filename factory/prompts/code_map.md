# CODE MAP — place the goal in the code (read-only)

You are `{{agent}}`, attempt {{attempt}}. The worktree is `/work`. The plan stage is about to start; map where this ticket's goal lives so the planner and the plan check work inside it.

## Ticket
Title: {{task.title}}
Branch: {{task.branch}}

{{task.description}}

## Record
{{task.record}}

## Ticket criteria
{{task.criteria}}

## Code graph
{{context.graph}}

Follow the `code-discovery` skill: query it with `graphify <verb> … --graph <the path above>` before grepping.

## Project context
{{context.projectContext}}

## What to do
1. Place the record's goal in the code with the graph: `god-nodes`, one `query` on the goal, `affected` on the symbols it names. At most a handful of calls.
2. Answer `components`, `files` (repo-relative, at most 40), `owners` (CODEOWNERS for those paths when the repo has one, else the top three of `git shortlog -sn --since=6.months -- <files>`), a calibrated `confidence` and, when something could not be placed, a `note`.

## Rules
- Read-only: no edits; the output is the map.
- Read only what the graph cites. A stale graph is a lead: grep the areas the task changes.
