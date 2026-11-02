# Docs

| Page | What it answers |
|---|---|
| [install.md](./install.md) | Prerequisites, quick start, checks |
| [architecture.md](./architecture.md) | The pipeline stages, the hexagonal layout, factory mode |
| [configuration.md](./configuration.md) | Every environment variable, credentials, images |
| [api.md](./api.md) | HTTP routes and an example session |
| [contributing.md](./contributing.md) | Running the checks, opening a PR |

For the board (the Rust TUI): [`board/README.md`](../board/README.md).

## RFCs

Design proposals, numbered in the order they were written. Each one says its status at the top.

| RFC | What it proposes |
|---|---|
| [0001](./rfcs/0001-own-the-factory.md) | Run every stage through the Agent SDK from this repo, with no orc dependency |
| [0002](./rfcs/0002-native-agent-runtimes.md) | Three native runtimes: Claude through its SDK, Codex through eve, Jev through TypeSafe's SDK |
| [0003](./rfcs/0003-upgradable-harness.md) | Pinned models, conformance, replay evals and staged rollout, so upgrades are routine |
| [0004](./rfcs/0004-harness-for-luna-notch.md) | luna-tui as the harness for Luna Notch: the notch owns the ticket, the machine owns the run |
