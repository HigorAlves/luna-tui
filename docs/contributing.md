# Contributing

We welcome issues and pull requests.

Run these checks before you send a change:

```sh
pnpm test             # machine, contracts, factory and the evals' grading (the evals tests also check every decision case's reading against the pack's own criteria: see evals/README.md)
pnpm typecheck
pnpm board:test       # board (Rust)
cd board && cargo clippy --all-targets -- -D warnings -A clippy::large_enum_variant   # the board's lint: CI fails on any Rust warning
pnpm golden           # end-to-end, needs a running machine (see docs/install.md)
```

A change of engine or model needs an eval scorecard in its description. These changes count:

- A new catalog entry in `contracts/src/models.ts`.
- An engine that points at another model.
- A new default engine for a pack.
- A runtime SDK bump.

Run `pnpm eval --pack <pack> --engine <new> --against <old>` for every pack that the change touches. See [evals/README.md](../evals/README.md). Evals need a model credential. They run on your machine, not in CI.

These are the runtime SDKs: `@anthropic-ai/claude-agent-sdk`, `eve`, `@typesafe-ai/sdk` and the Codex CLI in `machine/runner/Dockerfile`. A runtime SDK bump goes alone. Pin an exact version. The bump must pass the conformance table in `factory/src/runtimes/conformance/`. The table runs in `pnpm --filter @hardness/factory test`. It uses each runtime's fake and needs no credential. Find the steps in [runbooks/upgrade-a-model.md](runbooks/upgrade-a-model.md).

A change to the questions, criteria or bars of a decision pack re-runs its baselines. Run `pnpm eval --pack <pack> --engine <engine> --save-baseline` on each engine in `contracts/src/decision-defaults.json`. Then run `pnpm eval scorecard`. Put the scorecard's row in the description. See [runbooks/calibrate-decisions.md](runbooks/calibrate-decisions.md).

Change the board's keys in `board/src/keys.rs` alone. Then `pnpm board:keys` regenerates the key tables in `board/README.md`. `pnpm board:test` checks those tables.

Run anything that needs a model as a pack through the harness. A pack is a role in `factory/roles/`, a prompt in `factory/prompts/`, an entry in `contracts/src/packs.ts`, or typed questions for a decision pack. Use an engine from `contracts/src/engines.ts` and that engine's runtime. Never call a provider's API directly. The whole point is that everything runs locally on the user's own Claude subscription or Codex login. Metered keys are opt-in. `CLAUDE.md` at the root tells the agents the same.

Keep a PR under about 300 changed lines where you can. Copied prompts and skills do not count. A bigger change says why in its description.

**Docs follow ASD-STE100.** Write all docs in Simplified Technical English (ASD-STE100). Follow these rules:

- Keep every prose sentence to 25 words or fewer.
- Keep every procedural sentence to 20 words or fewer.
- Give each step one instruction.
- Write in the active voice. Name who does the action.
- Do not change a heading, a fenced block, a link target or a table's column count in a rewrite.

This repository has no license file yet. The maintainers must choose one.
