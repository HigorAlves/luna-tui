<div align="center">
<img src="../board/icon.png" width="112" alt="Luna TUI's icon">

# Luna TUI

**A board in your terminal that runs a software factory. You keep the final say.**

</div>

Luna waits on Claude in your [notch](https://github.com/HigorAlves/luna-notch); Luna TUI runs the factory in your terminal.

Luna TUI is a local dev harness for working with AI coding agents. You plan
tickets on a board inside [herdr](https://herdr.dev/); a machine then moves each
ticket through a fixed pipeline, running agents (Claude by default, Codex where
you pick it) in throwaway Docker containers, and stops at approval gates so you
stay in control. Stage-by-stage detail: [docs/architecture.md](../docs/architecture.md); the roles, prompts and guardrails live in [`factory/`](../factory/).

## Install

### 1. Install herdr (0.7.0 or newer)

```bash
make tools    # installs the tools Luna needs, herdr included (Homebrew)
```

Or install it yourself from [herdr.dev](https://herdr.dev/). Check with `herdr --version`: it must be 0.7.0 or newer.

### 2. Link the plugin

```bash
pnpm install
pnpm board:link    # builds the board, then runs `herdr plugin link ./board`
```

Linking is a one-time step. Rust prerequisites and the details: [board/README.md](../board/README.md).

### 3. Add the keybinding

Add this to your herdr config:

```toml
[[keys.command]]
key = "prefix+shift+b"
type = "plugin_action"
command = "hardness.board.open"
description = "open board"
```

Without a keybinding, `herdr plugin action invoke hardness.board.open` opens the board too.

### 4. Start the machine

```bash
make setup    # tools, credentials, integrations, starts the machine, links the board
make doctor   # what is set up and what is missing, any time
```

By hand it is `pnpm start` (the stage images, then Postgres + the machine on http://127.0.0.1:4318). Working on the harness itself? `pnpm dev` runs the machine on your host with hot reload. Then press your keybinding in herdr: the board opens. Prerequisites and checks: [docs/install.md](../docs/install.md).

## Docs

| Page | What it answers |
|---|---|
| [docs/README.md](../docs/README.md) | The index |
| [docs/install.md](../docs/install.md) | Prerequisites, quick start, checks |
| [docs/architecture.md](../docs/architecture.md) | Pipeline stages, the hexagonal layout, factory mode |
| [docs/configuration.md](../docs/configuration.md) | Every environment variable |
| [docs/api.md](../docs/api.md) | HTTP routes and an example session |
| [docs/contributing.md](../docs/contributing.md) | Running the checks, opening a PR |

Packages (`@hardness/*`), env vars (`HARDNESS_MACHINE_URL`) and `~/.config/hardness/` still say `hardness` — renaming them is a separate change; the product name is Luna TUI.

## Contributing

Issues and pull requests are welcome. See [docs/contributing.md](../docs/contributing.md).
