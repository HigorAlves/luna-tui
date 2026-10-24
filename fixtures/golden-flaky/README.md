# golden-flaky fixture

A fixture whose test fails until the Verifier stage specifically has run it
`FLAKY_PASSES_AFTER` times, then passes forever. Used by
`machine/scripts/golden-retry.mjs` to deterministically exercise the
Verifier's retry and escalation paths against a real pipeline run, without
needing to provoke a real agent into writing a wrong fix on purpose.

Only counts invocations with `HARDNESS_STAGE=verifying` set (set only by
`machine/src/stages/verify.ts`) — otherwise it always passes. Without that,
the implementer agent's own exploratory `npm test` runs while it's still
working would consume the counter before the pipeline's own Verifier stage
ever got a turn.

The counter file lives in the OS temp dir, not inside the worktree — a real
implementer agent, tidying up before reporting done, reasonably deleted an
untracked counter file it didn't recognize when it lived inside the repo.
