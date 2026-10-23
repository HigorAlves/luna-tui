# Hardness Board (herdr plugin)

A lazygit-style view of the machine's tickets, for [herdr](https://herdr.dev/). Nine
columns named after the harness stages: Backlog, Intake, Triage, Approved, Build,
Verify, Evidence, Ship, Done. The board holds no state of its own: it reads and writes
through the machine's HTTP API at `../machine`, and follows its `/events` stream
for live updates.

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
| `enter` | open the ticket in a popup over the board |
| `n` / `e` / `d` | new ticket, edit in place with vim-style keys (`i`/`a`/`o`… insert, `esc`/`q` back to normal, `ctrl+s` saves), delete (asks first) |
| `a` | advance: move a backlog ticket to intake, start it, approve a plan or tests, answer triage's questions, add guidance to an escalation, resume after a usage limit |
| `r` | send the plan or tests back, with a required reason |
| `X` | abort the running or paused stage (asks first) |
| `w` | kill the ticket's worktree once you are done with it (asks first); its branch and commits stay |
| `R` | search for a repo to set on the ticket, instead of typing a path |
| `f` | focus the agent's watch tab in herdr |
| `/` / `!` / `@` | filter by title or `#id`; show only tickets that need you; show only this repo's tickets |
| `F` | fold: show every column at once, collapsing all but the focused one to its header bar |
| `x` | actions menu for the selected ticket |
| `q` | quit (closes a popup instead, if one is open) |

## Tickets

`enter` opens a ticket in a popup over the board: its status, the open gate's
content (a plan to read, tests to check, the PR once it's shipped), stage
runs and recent activity. `e` edits the same ticket in place, right there in
the board, as the same markdown `n` fills in for a new one:

```markdown
# Login page

## Description

Users can sign in with email and password.

## Acceptance criteria

- Invalid password shows an error
- Successful login redirects to /home
```

Editing is vim-style modal, not a plain text box: it opens in normal mode
(`hjkl` to move, `dd`/`x` to delete, `u`/`ctrl+r` undo/redo), `i`/`a`/`o`/…
enter insert mode, `esc` goes back to normal. `ctrl+s` saves from either
mode; `esc` or `q` in normal mode cancels. Nothing opens outside the board
for this anymore — no `$EDITOR`, no second window to switch to.

The repo isn't part of this text — it's never typed freely, only set through
`R`'s search, so a stray edit can't silently blank it or point it somewhere
wrong. A new ticket's repo defaults to herdr's workspace, or the board's own
working directory when it runs standalone — either way, the nearest repo
root above it. `a` on a backlog or intake ticket with no repo set opens the
repo search instead of advancing, so you fix it before a stage runs. `R`
opens the same search anytime: type to filter, enter to set it — no path to
type or get wrong. It lists every repo under `HARDNESS_REPOS_DIR` (default
`~/Developer`), whether a repo sits directly under it or is grouped with
others under a project folder (`~/Developer/some-project/backend`,
`.../frontend`, both found). Triage's questions (`a` on a ticket awaiting
answers) still open in `$EDITOR`, pre-filled with its recommended answers —
that flow didn't move in place yet.

A new ticket starts in Backlog. `a` moves it to Intake (no stage runs, it's
just a deliberate "I'm shaping this one up" step); `a` again starts triage.

The machine opens a herdr tab following each stage's agent, and closes it
itself once the ticket is closed. Approving the Ship gate (`a` on `awaiting_ship`)
pushes the task's branch and opens a real PR with `gh` — see the root
`README.md`'s "Shipping" section for what that needs.

## Tests

```sh
cargo test
```

Most of the board's logic only shows up when it is actually talking to a
running machine, so unit tests here are light (markdown parsing, timestamp
math). The real check is running it against the machine — see the repo root
`README.md`.
