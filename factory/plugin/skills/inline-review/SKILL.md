---
name: inline-review
description: How a GitHub PR review with line-anchored inline comments is shaped — the anchor rule, the suggestion-block gate, the comment cap, the body cap — so the reviewing stage's comments post cleanly; the host does the posting.
when_to_use: Use in the reviewing stage when turning findings into the `comments[]` the host posts as one review.
---

# Inline GitHub PR Review

Turn structured findings (from `pr-reviewer` and `security-reviewer`) into the shape of a real GitHub PR review: inline comments anchored to specific files and lines, optional one-click suggestion blocks, and a review event (APPROVE / COMMENT / REQUEST_CHANGES) computed mechanically from the severities. The reviewed author opens the PR and sees comments pinned next to the code, not a markdown wall.

In factory mode the stage never posts: it answers `comments[]`, `findings[]`, `verdict` and `summary`, and the host posts one COMMENT review at once; an `approve` or `request_changes` verdict waits for the user, who posts it with a key. The rules below are what makes that post land.

## When NOT to use

- A reply in an existing thread is the addressing stage's job (`receiving-code-review`), not a review.

## The contract (schema, severities, event rule)

The finding schema, severity enum, severity→event mapping, event-computation
algorithm, confidence ≥0.8 rule, and self-contradiction detection are defined
**once**, in `review-contract`. Read that skill first; this one owns only the shape of what gets posted.

Duties from the contract, restated:

- Compute the verdict mechanically from the severity set; a narrative verdict that contradicts the findings is wrong.
- Every comment's `path` and `line` follow the contract's line-number semantics: a line of the new file the diff touches (`side: "RIGHT"`), or a removed line (`side: "LEFT"`). GitHub rejects a comment on an untouched line and, with it, the whole review.

The host posts with one `gh api repos/…/pulls/…/reviews` call; [BACKENDS.md](references/BACKENDS.md) shows the payload the host builds from your `comments[]`.

## Suggestion block rules

GitHub renders a triple-backtick `suggestion` block inside a comment body as a one-click "Apply suggestion" button. Use sparingly:

- **Length:** ≤ 6 lines of code. Longer suggestions are usually refactors disguised as fixes — describe in prose instead.
- **Completeness:** Committing the suggestion must FULLY resolve the issue. No partial fixes that leave the author guessing.
- **Mental compile:** The suggested code must be syntactically valid in the target language and reference only symbols visible at the comment's line. No imports the author has to add separately.
- **No refactor smuggling:** Don't suggest renames, file moves, or stylistic rewrites as committable suggestions. Those go in prose.

Format and per-kind templates: [COMMENT-TEMPLATES.md](references/COMMENT-TEMPLATES.md) — read when writing a comment body.

If `suggestion_code` is set on a finding but doesn't meet the rules above, drop it from the suggestion block and keep the prose only.

## The gate that remains

Comment reviews go out as soon as the stage answers: the user chose that. What still waits for them is the verdict: `approve` and `request_changes` are shown on the board and posted with one key, or dropped. So the comments you return are final; the verdict is a proposal.

## Iron rules

1. **The verdict is computed mechanically.** `request_changes` on any `bug` or `security` finding at confidence 0.8 or more; `approve` when the whole diff was read and nothing of severity `bug`, `security` or `test` was found; else `comment`.
2. **At most 15 inline comments per review.** Over-commenting erodes signal. Keep the highest severities; the rest ride in `findings[]` only.
3. **Suggestion blocks only when they meet all three rules** (length, completeness, mental compile). Do not smuggle refactors.
4. **Comments sit on lines the author modified in this PR.** Pre-existing bugs the diff did not touch are not findings (the caveman rule); a comment on an untouched line loses the whole review.
5. **No AI attribution in the review body or comments.** The comments speak for themselves.

## Tone

The comment body follows `caveman-review` discipline — terse, actionable, signal-only. The overall review body is hard-capped at **2 sentences (~40 words)**: one clause framing the PR + finding counts by severity (e.g. "CSV export for /reports. 2 bugs, 1 untested branch, 2 nits."). It never restates inline comments, never praises, never hedges — the inline comments carry all detail. No throat-clearing, no praise per finding. One line per problem in the comment body, suggestion block underneath if applicable.
