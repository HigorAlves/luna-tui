---
name: inline-review
description: How a GitHub PR review with line-anchored inline comments is shaped — the anchor rule, the suggestion-block gate, the comment cap, the body cap — so the reviewing stage's comments post cleanly; the host does the posting.
when_to_use: Use in the reviewing stage when turning findings into the `comments[]` the host posts as one review.
---

# Inline GitHub PR Review

Turn structured findings (from `pr-reviewer` and `security-reviewer`) into the shape of a real GitHub PR review: inline comments anchored to specific files and lines, optional one-click suggestion blocks, and a review event (APPROVE / COMMENT / REQUEST_CHANGES) computed mechanically from the severities. The reviewed author opens the PR and sees comments pinned next to the code, not a markdown wall.

In factory mode the stage never posts: it answers `comments[]`, `findings[]`, `verdict` and `summary`. The machine computes the event from the severities, and the whole review (event, body, every comment) waits on the board until the user posts it with a key, edits it or drops it. The rules below are what makes that post land.

## When NOT to use

- A reply in an existing thread is the addressing stage's job (`receiving-code-review`), not a review.

## The contract (schema, severities, event rule)

The finding schema, severity enum, severity→event mapping, event-computation
algorithm, confidence ≥0.8 rule, and self-contradiction detection are defined
**once**, in `review-contract`. Read that skill first; this one owns only the shape of what gets posted.

Duties from the contract, restated:

- The event is computed mechanically from the severity set, per `review-contract`; a narrative verdict that contradicts the findings is recomputed and noted.
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

## The preview gate

Nothing goes out until the user has seen it. The board shows the computed event, the body, and every comment with its file, line and severity; the user posts it with one key, edits it, or drops it. Auto-posting a review under someone's name erodes trust; the gate is cheap and catches mistakes at no cost.

## Iron rules

1. **The verdict is computed mechanically**, per `review-contract`: no finding is `approve`; any `bug`, `security`, `api-surface` or `test` finding is `request_changes`; anything else (`suggestion`, `question`, `nit`) is `comment`.
2. **At most 15 inline comments per review.** Over-commenting erodes signal. Keep the highest severities; the rest ride in `findings[]` only.
3. **Suggestion blocks only when they meet all three rules** (length, completeness, mental compile). Do not smuggle refactors.
4. **Comments sit on lines the author modified in this PR.** Pre-existing bugs the diff did not touch are not findings (the caveman rule); a comment on an untouched line loses the whole review.
5. **No AI attribution in the review body or comments.** The comments speak for themselves.

## Tone

The comment body follows `caveman-review` discipline — terse, actionable, signal-only. The overall review body is hard-capped at **2 sentences (~40 words)**: one clause framing the PR + finding counts by severity (e.g. "CSV export for /reports. 2 bugs, 1 untested branch, 2 nits."). It never restates inline comments, never praises, never hedges — the inline comments carry all detail. No throat-clearing, no praise per finding. One line per problem in the comment body, suggestion block underneath if applicable.
