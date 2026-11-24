# `steps.md` template (e2e stage, Driver A)

Written to `/out/files/qa/steps.md`. Image paths are relative to that directory.

```
# QA — <feature name> — <ISO date>

App: <URL> (target: <name>)
Build: <commit-sha-short>
agent-browser: <agent-browser --version output>
Auth: <signed in as <user> (target <name>) | unauthenticated run>

## Golden path

1. **Open <page>** — expected: <…> — actual: <…> — ![](screenshot-01-open.png)
2. **Fill form with valid data** — expected: <…> — actual: <…> — ![](screenshot-02-filled.png)
3. **Submit** — expected: redirect to /dashboard — actual: <…> — ![](screenshot-03-success.png)

## Acceptance criteria

| Criterion | Result | Evidence |
|---|---|---|
| ac-1 — POST /export returns 202 + Location header | pass | ac-1-export-202.png |
| ac-2 — Toast reads "Export queued" | fail | ac-2-toast.png (toast never renders) |
| ac-3 — Retry after 24h resets quota | partial | not reachable in a browser session — needs a clock-shift harness |

## Edge cases

### Validation errors
1. **Submit empty required field** — expected: inline error "Email is required" — actual: <…> — ![](screenshot-04-validation.png)

### Empty state
1. **First-time user, no data** — expected: empty-state CTA visible — actual: <…> — ![](screenshot-05-empty.png)

### Failure state (API 500)
1. **Block /api/billing** — expected: error toast "Could not load billing" — actual: <…> — ![](screenshot-06-error.png)

## Console
- <error count> errors / <warning count> warnings
- Notable line(s): "Uncaught TypeError ..." (console.log:42)

## Network (from HAR)
- Requests: <count>
- 4xx/5xx: <count>
- Notable: <e.g. "POST /api/refund returned 200 with body {ok: true}">

## Verdict

✅ Golden path passes; edge cases pass; no console errors.

or

❌ Golden path fails at step 3 — Submit silently no-ops. Console shows `Uncaught TypeError: cannot read property 'token' of undefined` (console.log:14). See screenshot-03-submit-failure.png.
```

The verdict line here is narrative; the stage verdict is computed mechanically from the `qa-manifest.json` rows (any `fail` ⇒ `fail`; else any `partial` ⇒ `partial`; else `pass`). Every criterion in the table has a row in the manifest, and every `partial` states its reason in both.

Motion proof line, when ffmpeg is absent: `Motion proof: skipped — ffmpeg not installed`. When the change is not visual: `Motion proof: skipped — non-visual change`.
