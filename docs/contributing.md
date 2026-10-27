# Contributing

Issues and pull requests are welcome.

Before sending a change, run:

```sh
pnpm test             # machine, contracts and factory
pnpm typecheck
pnpm board:test       # board (Rust)
pnpm golden           # end-to-end, needs a running machine (see docs/install.md)
```

Keep a PR under about 300 changed lines where you can; copied prompts and skills do not count. A bigger change says why in its description.

This repository does not yet include a license file; the maintainers have to choose one.
