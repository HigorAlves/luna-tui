# Plan Self-Review Checklist

Apply this checklist to your own brief before answering. In factory mode (LUNA_FACTORY=1) there is no separate plan reviewer: the triage stage is both planner and reviewer, and answers only once the brief passes.

**Purpose:** Verify the brief is complete, matches the ticket, and has proper slice decomposition.

**Run after:** The complete brief is drafted, before the stage answers.

## What to Check

| Category | What to Look For |
|----------|------------------|
| Completeness | TODOs, placeholders, incomplete slices, acceptance without an observable result |
| Ticket Alignment | `criteria[]` covers every ticket criterion; `slices[]` covers every criterion; no major scope creep |
| Slice Decomposition | Slices have clear boundaries (disjoint or explicitly ordered `touchpoints`), each is a vertical change that commits on its own |
| Buildability | Could an engineer follow this brief without getting stuck? Every default you took is in `assumptions[]` |
| Honesty | `confidence` and `risk` match what you actually read — `high` confidence only when you opened the files the slices touch |

## Calibration

**Only fix issues that would cause real problems during implementation.**
An implementer building the wrong thing or getting stuck is an issue.
Minor wording, stylistic preferences, and "nice to have" suggestions are not.

Answer unless there are serious gaps — missing requirements from the ticket,
contradictory slices, placeholder content, or slices so vague they can't be acted on.
Those you fix inline, then answer.

## Output

The outcome of the review is the brief itself: fixed in place, no review report. When a gap cannot be closed with a reasonable default, it is not a review finding — it becomes a `kind: "questions"` answer (at most 3, each with a `recommended` default).
