# Phase 0 results: Agent SDK in a container

Run on 2026-10-22 with `@anthropic-ai/claude-agent-sdk` 0.3.309 (Claude Code 2.1.309),
Node 24, Docker Desktop 29.9. Reproduce with `./run.sh` (see its header for credentials).

## Verdict: go, on the subscription token

A read-only stage ran inside a throwaway container against the repo mounted at `/work`,
authenticated with a subscription token from `claude setup-token`, and returned a correct
answer. The API key path stays as the fallback.

| Measure | Value |
|---|---|
| Result | correct listing and one-line summary of this repo |
| Turns | 2 |
| Model (default) | `claude-sonnet-5-5` |
| Time | 3.8 s agent, 5.4 s wall (container start included) |
| Tokens | 4 input, 255 output, 16,143 cache read, 16,482 cache write |
| Reported cost | $0.07 (API-equivalent; not billed on a subscription) |

## Findings that change the machine's design

1. **Check `is_error`, not `subtype`.** With no credential or a bad token, the SDK still
   ends with `subtype: "success"` and puts the error in `result`. The runner must treat
   `is_error` and thrown errors as failure.
2. **`allowedTools` does not restrict tools.** It only pre-approves them. The session still
   loaded Bash, Edit, Write and every other tool. Read-only stages must restrict the tool
   set itself (the SDK's `tools` / `disallowedTools` options) and the plan's "tools per
   stage" must be enforced that way, not with `allowedTools`.
3. **Usage limits are visible before they hit.** Each run emits a `rate_limit_event` with
   `five_hour` and `seven_day` utilisation and `resetsAt`. The engine can enter
   `paused_rate_limit` from this signal and resume at `resetsAt`, instead of waiting for a
   failed run. At the time of the run: five-hour window 11% used, seven-day window 39%.
   Overage is disabled on this account, so a limit stops work rather than costing money.
4. **Tokens can arrive wrapped.** A token copied from a terminal had a line break in it.
   The runner strips whitespace when reading credentials.
5. **Pin settings in the runner.** The container starts with no user or project settings,
   which is what the harness wants. The runner should keep passing settings explicitly so a
   repo's `.claude/` is never loaded.

## Not tested

- Behaviour when a limit is actually reached. Only the warning signal was observed.
- Write stages (Implementer) and commits from inside the container. That is Phase 4.
- Terms: the docs allow "ordinary, individual usage" of the Agent SDK on Pro and Max plans,
  and ask developers building products to use API keys. This harness is personal; heavy
  automated use may not count as ordinary. Accepted risk, decided by the account owner.
