# Hardness Board (herdr plugin)

A lazygit-style view of the machine's tickets, for [herdr](https://herdr.dev/). Six
columns named after the harness stages: Triage, Approved, Build, Verify, Evidence,
Publish. The board holds no state of its own: it reads and writes through the
machine's HTTP API at `../machine`, and follows its `/events` stream for live
updates.

Run the commands below from this `board/` folder, or use the `pnpm board:*`
scripts from the repo root. Start the machine first (`pnpm dev` from the repo
root) — the board still runs without it, but shows "machine offline" and retries
every 2s until it reconnects.

## Run it standalone

```sh
cargo run --release
```

`HARDNESS_MACHINE_URL` overrides the default `http://127.0.0.1:4317`.

## Install as a herdr plugin (local link)

```sh
cargo build --release
herdr plugin link .
herdr plugin action invoke hardness.board.open
```

Optional keybinding in your herdr config:

```toml
[[keys.command]]
key = "prefix+shift+b"
type = "plugin_action"
command = "hardness.board.open"
description = "open board"
```

## First launch: importing the old local board

If a `board.json` from an earlier version of this board is found (in the herdr
plugin state directory, or the current directory when run standalone), its
tickets are created on the machine once, then the file is renamed to
`board.json.imported` so the import never runs twice.

## Keys

Press `?` in the board for the full list. The main ones:

| Key | Action |
|---|---|
| `h` / `l`, `j` / `k` | move between columns and tickets |
| `enter` | open details |
| `n` / `e` / `d` | new ticket, edit in `$EDITOR`, delete (asks first) |
| `a` | advance: start a draft, approve a plan or tests, answer triage's questions, add guidance to an escalation, resume after a usage limit |
| `r` | send the plan or tests back, with a required reason |
| `X` | abort the running or paused stage (asks first) |
| `f` | focus the agent's watch tab in herdr |
| `/` / `!` | filter by title or `#id`; show only tickets that need you |
| `x` | actions menu for the selected ticket |
| `q` | quit |

## Tickets

`e` opens `$EDITOR` (falls back to `vi`) on a markdown file:

```markdown
# Login page

## Description

Users can sign in with email and password.

## Acceptance criteria

- Invalid password shows an error
- Successful login redirects to /home

## Repo

/path/to/the/repo
```

A ticket needs a repo to run real agent stages; without one, triage escalates
with a clear error. Triage's questions (`a` on a ticket awaiting answers) open
the same way, pre-filled with its recommended answers.

## Tests

```sh
cargo test
```

Most of the board's logic only shows up when it is actually talking to a
running machine, so unit tests here are light (markdown parsing, timestamp
math). The real check is running it against the machine — see the repo root
`README.md`.
