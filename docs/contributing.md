# Contributing

Issues and pull requests are welcome.

Before sending a change, run:

```sh
pnpm test             # machine, contracts and factory
pnpm typecheck
pnpm board:test       # board (Rust)
pnpm golden           # end-to-end, needs a running machine (see docs/install.md)
```

Anything that needs a model runs as a pack through the harness (a role in `factory/agents/`, a prompt in `factory/prompts/`, an entry in `contracts/src/packs.ts`), never as a direct call to the Anthropic API: the whole point is that it all runs locally on the user's subscription. `CLAUDE.md` at the root says the same to the agents.

Keep a PR under about 300 changed lines where you can; copied prompts and skills do not count. A bigger change says why in its description.

This repository does not yet include a license file; the maintainers have to choose one.
