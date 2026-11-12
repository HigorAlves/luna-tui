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

## The machine's shortlist
{{context.plan.shortlist}}

The machine matched the goal's words against the graph's labels and paths. Confirm it, drop what does not belong, add what it missed, and give every file a role. If it says none, search the graph yourself.

## Code graph
{{context.graph}}

Follow the `code-discovery` skill: query it with `graphify <verb> … --graph <the path above>` before grepping.

## Project context
{{context.projectContext}}

## What to do
1. Place the record's goal in the code with the graph: `god-nodes`, one `query` on the goal, `affected` on the symbols it names. At most a handful of calls.
2. Answer `components`, `files` (repo-relative, at most 40, each `{path, role}` with `role` one of `change` (the change edits it), `read` (context only) or `test` (where its checks live)), `entry_points` (the handlers, commands or jobs where the flow the goal changes starts), `owners` (CODEOWNERS for those paths when the repo has one, else the top three of `git shortlog -sn --since=6.months HEAD -- <files>`), a calibrated `confidence` and, when something could not be placed, a `note`.

## Rules
- Read-only: no edits; the output is the map.
- Read only what the graph cites. A stale graph is a lead: grep the areas the task changes.
