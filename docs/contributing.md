# Contributing

Issues and pull requests are welcome.

Before sending a change, run:

```sh
pnpm test             # machine, contracts, factory and the evals' grading
pnpm typecheck
pnpm board:test       # board (Rust)
cd board && cargo clippy --all-targets -- -D warnings -A clippy::large_enum_variant   # the board's lint: CI fails on any Rust warning
pnpm golden           # end-to-end, needs a running machine (see docs/install.md)
```

A change of engine or model (a new catalog entry in `contracts/src/models.ts`, an engine pointed at another model, a pack's default engine, or a runtime SDK bump) carries an eval scorecard in its description: `pnpm eval --pack <pack> --engine <new> --against <old>` for every pack it touches (see [evals/README.md](../evals/README.md)). Evals need a model credential, so they run on your machine, not in CI. A runtime SDK bump (`@anthropic-ai/claude-agent-sdk`, `eve`, `@typesafe-ai/sdk`, the Codex CLI in `machine/runner/Dockerfile`) goes alone, exact version, and passes the conformance table in `factory/src/runtimes/conformance/` (part of `pnpm --filter @hardness/factory test`, on each runtime's fake, no credential). The steps: [runbooks/upgrade-a-model.md](runbooks/upgrade-a-model.md). A change to a decision pack's questions, criteria or bars re-runs its baselines (`pnpm eval --pack <pack> --engine <engine> --save-baseline` on each engine in `contracts/src/decision-defaults.json`, then `pnpm eval scorecard`) and carries the scorecard's row in the description: [runbooks/calibrate-decisions.md](runbooks/calibrate-decisions.md).

A change to the board's keys goes in `board/src/keys.rs` alone; `pnpm board:keys` then regenerates the key tables in `board/README.md`, which `pnpm board:test` checks.

Anything that needs a model runs as a pack through the harness (a role in `factory/roles/`, a prompt in `factory/prompts/`, an entry in `contracts/src/packs.ts`, or typed questions for a decision pack), on an engine from `contracts/src/engines.ts` and that engine's runtime, never as a direct call to a provider's API: the whole point is that it all runs locally on the user's own Claude subscription or Codex login, with metered keys opt-in. `CLAUDE.md` at the root says the same to the agents.

Keep a PR under about 300 changed lines where you can; copied prompts and skills do not count. A bigger change says why in its description.

This repository does not yet include a license file; the maintainers have to choose one.
