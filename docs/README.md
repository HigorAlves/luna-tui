# Docs

| Page | What it answers |
|---|---|
| [install.md](./install.md) | Prerequisites, quick start, checks |
| [architecture.md](./architecture.md) | The pipeline stages, the hexagonal layout, factory mode |
| [configuration.md](./configuration.md) | Every environment variable, credentials, images |
| [api.md](./api.md) | HTTP routes and an example session |
| [contributing.md](./contributing.md) | Running the checks, opening a PR |

For the board (the Rust TUI): [`board/README.md`](../board/README.md).

## Runbooks

| Runbook | When |
|---|---|
| [upgrade-a-model.md](./runbooks/upgrade-a-model.md) | A new Claude, OpenAI or Jev model, or a runtime SDK bump |
| [token-economy.md](./runbooks/token-economy.md) | See what the token economy learned, drop a fact, approve a tool mask, import old runs, or read a loop guard stop |

## RFCs

Design proposals. The numbers follow the order in which the authors wrote them. Each one says its status at the top. 0002 to 0004 and 0007 end with notes on what the team built and how it differs.

| RFC | What it proposes |
|---|---|
| [0001](./rfcs/0001-own-the-factory.md) | Run every stage through the Agent SDK from this repo, with no orc dependency |
| [0002](./rfcs/0002-native-agent-runtimes.md) | Three native runtimes: Claude through its SDK, Codex through eve, Jev through TypeSafe's SDK |
| [0003](./rfcs/0003-upgradable-harness.md) | Pinned models, conformance, replay evals and staged rollout, so upgrades are routine |
| [0004](./rfcs/0004-harness-for-luna-notch.md) | luna-tui as the harness for Luna Notch: the notch owns the ticket, the machine owns the run |
| [0005](./rfcs/0005-software-factory-v1-5.md) | Software Factory v1.5: typed decisions at every gate, a Plan stage, a video Evidence Pack and a maintenance loop in Ship |
| [0007](./rfcs/0007-token-economy.md) | Token economy: a loop guard, learned repo facts and tool pruning, ported from TokenEconomizer |
