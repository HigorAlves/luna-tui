<div align="center">
<img src="board/icon.png" width="112" alt="Luna TUI's icon">

# Luna TUI

**A board in your terminal that runs orc as a software factory. You keep the final say.**

</div>

Luna waits on Claude in your [notch](https://github.com/HigorAlves/luna-notch); Luna TUI runs the factory in your terminal; [orc](https://github.com/HigorAlves/orc) is the engine both drive.

Luna TUI is a local dev harness for working with AI coding agents. You plan
tickets on a board inside [herdr](https://herdr.dev/); a machine then moves each
ticket through a fixed pipeline, running Claude agents in throwaway Docker
containers, and stops at approval gates so you stay in control.

## Pipeline

Every ticket moves Intake → Triage → Build → Verify → E2E/Evidence → Deliver → CI watch → Ship → Done, with an approval gate at the big steps. Triage and Build run as [orc](https://github.com/HigorAlves/orc) stage packs in a throwaway Docker container; Deliver, Ship and CI watch are plain `git`/`gh` host commands. Full stage-by-stage detail: [docs/architecture.md](docs/architecture.md).

## Install

```bash
pnpm install
docker compose up -d --wait   # Postgres on 127.0.0.1:5433
pnpm --filter @hardness/machine runner:build   # the stage container image
pnpm dev                                        # the machine on http://127.0.0.1:4317
```

For the board, Rust prerequisites and the full checks: [docs/install.md](docs/install.md).

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
