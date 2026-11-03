<div align="center">
<img src="board/icon.png" width="112" alt="Luna TUI's icon">

# Luna TUI

**A board in your terminal that runs a software factory. You keep the final say.**

</div>

Luna waits on Claude in your [notch](https://github.com/HigorAlves/luna-notch); Luna TUI runs the factory in your terminal.

Luna TUI is a local dev harness for working with AI coding agents. You plan
tickets on a board inside [herdr](https://herdr.dev/); a machine then moves each
ticket through a fixed pipeline, running agents (Claude by default, Codex where
you pick it) in throwaway Docker containers, and stops at approval gates so you
stay in control.

## Pipeline

Every ticket moves Intake → Triage → Build → Verify → E2E/Evidence → Deliver → CI watch → Ship → Done, with an approval gate at the big steps. The agent stages run as stage packs in a throwaway Docker container, each on the engine its pack, the repo or the task picks: Claude models through the Claude Agent SDK on your subscription, Codex models through Vercel's eve on your Codex login; the roles, prompts, skills and guardrails live in [`factory/`](factory/). Deliver, Ship and CI watch run on the host: git for the pushes, the GitHub API for the rest. Everything needed is in this repository: clone it, run it. Full stage-by-stage detail: [docs/architecture.md](docs/architecture.md).

## Install

```bash
make setup    # installs the tools, asks for your credentials and integrations, starts the machine, links the board
make doctor   # what is set up and what is missing, any time
```

`make` lists every step (`make credentials`, `make integrations`, `make luna-yaml REPO=<path>`, `make up`, …); each one is safe to run again. By hand it is `pnpm install` and `pnpm start` (the stage images, then Postgres + the machine on http://127.0.0.1:4318). Working on the harness itself? `pnpm dev` runs only Postgres in Docker and the machine on your host, with hot reload. For the board, Rust prerequisites and the full checks: [docs/install.md](docs/install.md).

## Docs

| Page | What it answers |
|---|---|
| [docs/README.md](docs/README.md) | The index |
| [docs/install.md](docs/install.md) | Prerequisites, quick start, checks |
| [docs/architecture.md](docs/architecture.md) | Pipeline stages, the hexagonal layout, factory mode |
| [docs/configuration.md](docs/configuration.md) | Every environment variable |
| [docs/api.md](docs/api.md) | HTTP routes and an example session |
| [docs/contributing.md](docs/contributing.md) | Running the checks, opening a PR |

Packages (`@hardness/*`), env vars (`HARDNESS_MACHINE_URL`) and `~/.config/hardness/` still say `hardness` — renaming them is a separate change; the product name is Luna TUI.

## Contributing

Issues and pull requests are welcome. See [docs/contributing.md](docs/contributing.md).
