# Contributing

Issues and pull requests are welcome.

Before sending a change, run:

```sh
pnpm test             # machine and contracts
pnpm typecheck
pnpm board:test       # board (Rust)
pnpm golden           # end-to-end, needs a running machine (see docs/install.md)
```

This repository does not yet include a license file; the maintainers have to choose one.
