# PLAN STAGE — plan the change (read-only)

You are `{{agent}}`, attempt {{attempt}}. The worktree is `/work`. Triage has read the ticket and recorded what it is; turn that record into a plan an implementer can follow without asking anyone.

## Ticket
Title: {{task.title}}
Branch: {{task.branch}}

{{task.description}}

## Record
{{task.record}}

## Ticket criteria
{{task.criteria}}

## What the plan check found wrong with your last plan
{{context.plan.review}}

If this lists findings, you are re-planning: fix each one and keep what was right. This was the last plan:
Brief: {{plan.brief}}
{{plan.slices}}

## Answers and decisions so far
{{decisions}}

## Project context
{{context.projectContext}}

## What to do
1. Read just enough of `/work` (Glob, Grep, Read) to place the change and learn how it is tested.
2. Pick one answer:
   - `kind: "done"` (preferred): the plan.
     - `summary`: one or two sentences on what you planned.
     - `brief`: what to change, where, how to check it.
     - `criteria[]`: every goal in the record and every ticket criterion, each testable. It replaces the ticket's list.
     - `assumptions[]`: each gap you filled with a default.
     - `slices[]`: ordered, each `{title, est_loc, touchpoints[], acceptance[]}`. Each slice is a vertical, independently committable change; `touchpoints` are repo-relative paths; every criterion appears in some slice's `acceptance`.
     - `rollback`: a paragraph a person can follow to undo the change, including what a revert does not undo.
   - `kind: "questions"`: only when no reasonable default exists. At most 3 items `{question, recommended}`; `recommended` is mandatory.
3. Earlier answers in the decisions above are binding. Never re-ask them. `mcp__luna__decision_get` returns a settled decision by key.

## Rules
- Read-only: no edits; the output is the plan.
- Flag ambiguity, missing edge cases and non-goals as assumptions, not prose: the implementer reads `assumptions[]`, not your paragraphs.
- Questions end the stage: put them in `questions[]` with their `recommended` answer.
