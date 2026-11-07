# Luna TUI (herdr plugin)

The plugin tile is `icon.png`. `pnpm icons` generates it from `scripts/mark.mjs` (study page: `design/icons/luna-tui.html`).

This is a lazygit-style view of the machine's tickets, for [herdr](https://herdr.dev/). It has eight
columns: the diagram's seven stages and Done. They are Intake, Triage, Plan, Build,
Verify, Evidence, Ship and Done. The board holds no state of its own. It reads and writes
through the machine's HTTP API at `../machine`. It follows the `/events` stream
for live updates.

Run the commands below from this `board/` folder. Or use the `pnpm board:*`
scripts from the repo root. Start the machine first (`pnpm dev` from the repo
root). The board still runs without the machine. It shows "machine offline" and retries
every 2s until it reconnects.

## Run it standalone

```sh
cargo run --release
```

The board connects to whichever machine is up: the one from `pnpm dev` on `http://127.0.0.1:4317` first, then
the container from `pnpm start` on `:4318`. It checks again on every reconnect, so switching between
the two needs no restart. `HARDNESS_MACHINE_URL` pins one address instead. `LUNA_APPROVER` names you on every approval and send-back. A plan of High risk needs two distinct names. So the first `a` keeps your name on the gate (`Approvals  1 of 2 (ana)`), and a second person's `a` closes it.

## Install as a herdr plugin (local link)

```sh
pnpm board:link      # from the repo root: builds, then `herdr plugin link ./board`
herdr plugin action invoke hardness.board.open
```

Linking is a one-time step. herdr runs `target/release/hardness-board` from this folder. So the
pane picks up a later `pnpm board:build` the next time it opens.

Optional keybinding in your herdr config:

```toml
[[keys.command]]
key = "prefix+shift+b"
type = "plugin_action"
command = "hardness.board.open"
description = "open board"
```

## First launch: importing the old local board

The board looks for a `board.json` from an earlier version of this board. It looks in the herdr
plugin state directory, or in the current directory when you run it standalone. If it finds one, it
creates its tickets on the machine once. Then it renames the file to
`board.json.imported`, so the import never runs twice.

## Keys

Press `?` anywhere for the keys of what has the keyboard. That is the board, the ticket popup, the
Inbox, the Digest, the Floor, Pulls, Slack or its Watches. One registry
(`src/keys.rs`) feeds the sheet. The `x` menus, the `:` completion and the tables in this file
derive from it too, so they cannot disagree. The sheet knows the ticket under the cursor. The title names
the ticket and its state. A key that works right now shows bright, with what it does (`a  approve the plan`
at the plan gate, `a  start` on a draft). A key that does not work shows dim, with the reason (`r  (only
a setup, plan or tests go back)`), and a meaning that cannot apply is left out. It opens with every group as rows; `?` again folds the dense groups
(Move, Filter, Views, App) to one line of keys.
Inside the sheet, `j`/`k` and `ctrl+d`/`ctrl+u` move the cursor. `enter` runs the row.
Press a bright key to close the sheet and run it. A dim key only says why it does not work.
`/` searches every view's keys by key or label. `merge` finds `m` and says `in Pulls`.
`enter` on it says to open Pulls first. `esc` or `q` closes the sheet.
Under a popup, the layer beneath folds to one line at the bottom
(`▸ board keys: …`). The sheet has two columns from 100 columns wide, and one below.

The footer is a few short words per view (`? help  n new  a advance  enter open  x actions …`).
`?` has the rest. After `g` or `z` with no second
key for 400 ms, the board lists the second keys (`g ▸  g first ticket …  s order columns by stage …`).
Inside an editor `?` types a character. So the editor's title carries its keys and follows the
vim mode (`normal · i a o insert · dd x delete · u ^r undo · ctrl+s save · esc q cancel`, then
`insert · esc normal · ctrl+s save`). At the `:` prompt, the commands that start with the text show
above it, with what they do. `tab` cycles them. `enter` runs the picked one, or the only one left
(`:fo` runs `fold`), else the text as typed.

`R` opens the repo search only on a ticket with no repo, the one time it matters. With a repo set,
it says to use `:repo <name>` or the `x` menu's "set the repo". So a stray `R` never re-points a
ticket. `:repo <name>` sets the one repo under the repos root whose path holds the name. It takes a path
as given when the path starts with `/`, `~` or `.`. `:filter` covers filtering by repo.

`pnpm board:keys` (`hardness-board --keys-md board/README.md`)
generates the tables below. A test fails when they drift from the registry.

<!-- keys:start board -->
**Gate**

| Key | Does |
|---|---|
| `a` | start; approve the setup; answer triage's questions; approve the plan; approve the split; archive the ticket (one click); post the reply and close the ticket; approve the tests; ship: publish, watch the PR; ship: approve the release; retry the escalation, with guidance; resume after the usage limit; approve the memory review; advance |
| `T` | correct the triage record |
| `p` | post these questions at the source |
| `A` | memory review: approve, skip the rules |
| `N` | reject the plan, with a comment; reject the split, with a comment; reject the release, archive the card |
| `r` | send back with a reason |
| `x` then `S` | ship: approve and open the PR |

**Ticket**

| Key | Does |
|---|---|
| `X` | abort the running stage (asks first) |
| `w` | kill its worktree (asks first) |
| `Z` | archive, with a reason |
| `C` | correct the escalation reason |
| `d` | delete (asks first) |
| `f` | open or focus the agent's watch tab |
| `J` | link a Jira issue (search or create); unlink the Jira issue (asks first) |
| `R` | set the repo (search) |
| `e` | edit the plan and the ticket; edit title, description and criteria |
| `o` | open the linked issue in the browser |

**Move**

| Key | Does |
|---|---|
| `h / l` | previous / next column |
| `j / k` | previous / next ticket |
| `gg` | first ticket in the column |
| `G` | last ticket in the column |
| `1-8` | jump to that column |
| `] / [` | next / previous ticket that needs you |
| `enter` | open the ticket's workspace |

**Filter & order**

| Key | Does |
|---|---|
| `/` | filter by title, #id or repo |
| `!` | only the tickets that need you |
| `@` | only this repo's tickets |
| `zc` | fold the focused column |
| `zo` | unfold the focused column |
| `zz` | fold every column but the focused one |
| `gs` | order columns by stage |
| `gr` | order columns by repo |
| `ga` | order columns by age |
| `=` | card density: 3 lines, 4, 1 |

**Views**

| Key | Does |
|---|---|
| `F` | Floor: 7d and 30d metrics |
| `I` | Inbox: what needs you, by why |
| `D` | Digest: what changed since last time |
| `P` | Pulls: every open PR involving you |
| `B` | Backlog: candidates, not tickets yet |
| `K` | Tickets: held, assessed, waiting on you |
| `S` | Slack: mentions, DMs and watches |

**Marks & bulk**

| Key | Does |
|---|---|
| `v` | mark the ticket; a X d w act on marks |
| `V` | mark the whole column |

**App**

| Key | Does |
|---|---|
| `x` then `P` | resume every ticket paused on the limit |
| `x` then `D` | drain / carry on taking new work |
| `x` then `+` | one more slot |
| `x` then `-` | one slot fewer |
| `n` | new ticket, then edit it in place |
| `x` | actions menu for the ticket |
| `:` | command palette |
| `esc` | clear the filter and the marks |
| `?` | keys |
| `q` | quit |

**Commands (type after :)**

| Key | Does |
|---|---|
| `:q` | quit |
| `:new <title>` | new ticket, then edit it in place |
| `:filter <text>` | filter: title, #id or repo (bare clears) |
| `:repo <name>` | set the ticket's repo (bare: search) |
| `:open <#id>` | open a ticket by id prefix |
| `:group stage\|repo\|age` | order columns |
| `:fold` | fold the focused column |
| `:unfold` | unfold the focused column |
| `:setup <repo>` | propose the repo's luna.yaml |
| `:whole` | keep a split card whole (recorded) |
| `:dismiss <finding id> [reason]` | dismiss a finding Verify reported |
| `:finding <blocker\|should_fix\|nit> <title>` | add a finding Verify missed |
| `:slots <n>` | resize the pool |
| `:drain` | take no new work |
| `:resume` | carry on taking new work |
| `:start` | start the selected ticket (a) |
| `:floor` | open the Floor |
| `:inbox` | open the Inbox |
| `:digest` | open the Digest |
| `:prs` | open Pulls |
| `:backlog` | open the Backlog |
| `:tickets` | open the Tickets view |
| `:ticket-edit <text>` | post your text, not the draft's |
| `:dedup duplicate <n> \| related <ns> \| neither` | answer the duplicate question |
| `:dup <id>` | close as a duplicate of that ticket |
| `:undup` | bring a closed duplicate back |
| `:context repo\|project\|text <value>` | answer Intake: repo, project or text |
| `:slack` | open Slack |
| `:jira <KEY>` | link that Jira issue (bare: the search) |
| `:help` | this sheet |

<!-- keys:end -->

## Tickets

`enter` opens a ticket in a popup over the board. Inside it, a rail of nine sections sits on the
left. On a terminal under 100 columns, a tab strip replaces the rail. One pane sits on the right.
`h`/`l` or `1`…`9` switch sections.
`j`/`k` scroll the pane or pick a row where the section lists some.
`J`/`K` scroll a line there. `ctrl+d`/`ctrl+u` and PgDn/PgUp scroll half a page anywhere.
Picking a row brings it into view.
`+` toggles the popup between most of the screen and all of it.
A ticket that Luna Notch sent wears `notch LUNA-14` (its work order's ref), dim, on its card and in the popup's title.
An issue's `#42` or a Jira issue's `PLAT-123` appears the same way on the card.
Every section draws from everything the machine knows
about the ticket, whether or not someone decided a gate. The approved plan stays readable after `a`.
While a gate is open, its strip sits on top of every section with the keys that answer it.

| Section | Shows | Keys inside |
|---|---|---|
| Overview | the status. One row per acceptance criterion: its state in the plan, how many cases prove it, what verifying found. Repo, branch, issue, the Jira link, the SLA clocks, why, spend. The ticket's description and criteria. A setup gate's `luna.yaml` and proof, triage's questions, the memory review's rules | `e` edits the ticket's text, `J` links or unlinks the Jira issue |
| Plan | triage's latest plan (brief, criteria, assumptions, slices) and its history: send-backs with their reason, your edits, the approval | `e` edits brief, criteria and assumptions until Build starts; `a` / `r` at the gate |
| Tests | test_design's cases under the criterion each proves, with ✓ ✗ – from verifying | `e` edits the cases while they wait for your check (`## criterion`, `- case`, the approach under it) |
| Runs | every stage run with how long it took, its cost and turns. The selected run's error, per-case verdicts and files. It opens on the latest run | `j`/`k` pick a run, `J`/`K` scroll |
| Diff | the branch against its base: files with +/−, the selected file's patch. The machine sends at most 512 KB of it. The pane says when it cut | `j`/`k` pick a file, `J`/`K` scroll the patch, `o` opens the file from the worktree |
| Evidence | the QA verdict and every artifact the stages produced, by kind; opens on the latest | `j`/`k` pick a file, `J`/`K` scroll, `o` opens it |
| PR | the branch's pull request as the Pulls inbox sees it: checks by name, review state, threads, the task in flight. Or the URL the ship gate reported | `o` opens it, `S` ships at the gate |
| Activity | every event | |
| Engines | each stage the ticket runs (from `GET /packs`), the engine it is set to (yours, else `default: <engine>`) and the one it ran on. The bottom line names the running stage's (`implementing on codex:sol`). A machine from before engines says it offers none | `j`/`k` pick a stage. `E` picks its engine: the default, or one the stage allows. An engine with no credential on this machine is dim and shows what is missing. You cannot pick it. A stage that already ran keeps its engine |

These are the popup's keys. `?` inside it lists them with the ticket's state.
`J` scrolls here, so the Jira link is the board's `J`:

<!-- keys:start detail -->
**Gate**

| Key | Does |
|---|---|
| `a` | start; approve the setup; answer triage's questions; approve the plan; approve the split; archive the ticket (one click); post the reply and close the ticket; approve the tests; ship: publish, watch the PR; ship: approve the release; retry the escalation, with guidance; resume after the usage limit; approve the memory review; advance |
| `T` | correct the triage record |
| `p` | post these questions at the source |
| `A` | memory review: approve, skip the rules |
| `N` | reject the plan, with a comment; reject the split, with a comment; reject the release, archive the card |
| `r` | send back with a reason |
| `S` | ship: approve and open the PR |

**Ticket**

| Key | Does |
|---|---|
| `X` | abort the running stage (asks first) |
| `w` | kill its worktree (asks first) |
| `Z` | archive, with a reason |
| `C` | correct the escalation reason |
| `d` | delete (asks first) |
| `f` | open or focus the agent's watch tab |
| `R` | set the repo (search) |
| `e` | edit: the plan, the cases or the ticket |
| `o` | open: the file, the PR or the issue |
| `y` | Evidence Pack was useful |
| `n` | Evidence Pack was not useful (note) |
| `E` | pick the selected stage's engine |
| `M` | close as a duplicate of another |
| `U` | bring a closed duplicate back |

**Move**

| Key | Does |
|---|---|
| `h / l` | previous / next section |
| `1-9` | jump to that section |
| `j / k` | scroll, or pick a run / file |
| `J / K` | scroll a line where j / k pick |
| `ctrl+d / ctrl+u` | half a page |
| `+` | popup: most of the screen, or all |
| `esc / q / enter` | close |

**App**

| Key | Does |
|---|---|
| `?` | keys |

<!-- keys:end -->

The popup opens on the section that the open gate concerns. At `approve plan` it opens the Plan.
At `check tests` it opens the Tests. When escalated, it opens the Runs. `e` on the board (outside the popup) keeps its old
meaning. At the plan gate it opens the two-pane plan editor. Otherwise it opens the ticket's text.

The plan editor splits into two columns. Triage's plan is on the left (brief, criteria to build,
assumptions). Slices stay as triage wrote them. The ticket's own description and criteria are on the
right. `tab` moves between the two while you edit. `ctrl+s` saves whichever side changed. You can
edit the plan through the test check too, since no build has started yet. The editor keeps each edit as a
revision that the Plan section's history shows. On a terminal narrower than 110 columns, the two columns stack
instead, plan first. `n` fills in a new ticket as the same markdown that `e` edits:

```markdown
# Login page

## Description

Users can sign in with email and password.

## Acceptance criteria

- Invalid password shows an error
- Successful login redirects to /home
```

Editing is vim-style modal, not a plain text box. It opens in normal mode
(`hjkl` to move, `dd`/`x` to delete, `u`/`ctrl+r` undo/redo).
`i`/`a`/`o`/… enter insert mode. `esc` goes back to normal. `ctrl+s` saves from either
mode. `esc` or `q` in normal mode cancels. Nothing opens outside the board
for this anymore. There is no `$EDITOR` and no second window to switch to.

The repo is not part of this text. You never type it freely. You only set it through
the repo search, so a stray edit cannot silently blank it or point it somewhere
wrong. A new ticket's repo defaults to herdr's workspace, or to the board's own
working directory when it runs standalone. Either way, it is the nearest repo
root above that directory.
`a` on a backlog or intake ticket with no repo set opens the
repo search instead of advancing. So you fix the repo before a stage runs.
`R` opens the same search on a ticket without a repo.
On a ticket with a repo, it points
you to `:repo <name>` or the `x` menu's "set the repo". So a stray `R` never
re-points a ticket. Type to filter. Press enter to set the repo. There is no path to type or get
wrong. The search lists every repo under `HARDNESS_REPOS_DIR` (default `~/Developer`).
It finds a repo that sits directly under that folder,
or that sits with others under a
project folder (`~/Developer/some-project/backend`, `.../frontend`, both
found).
`a` on a ticket that awaits answers opens triage's questions in place
too. The board fills in the recommended answers. `ctrl+s` sends them.

A new ticket starts in Backlog. `a` moves it to Intake.
No stage runs: it is just a deliberate "I'm shaping this one up" step. `a` again starts triage.

Press `f` on a ticket with a running stage to open a herdr tab.
The tab follows its
agent (`docker logs -f` on its container). This works whether the machine runs in Docker or
on your host. `f` again focuses that tab. Nothing opens by itself.
Once the tab exists, later stages of the ticket re-point it.
The board closes it when the ticket closes.
When you approve the Ship gate (`a` on `awaiting_ship`), the machine
pushes the task's branch and opens a real PR through the GitHub API.
See the [architecture doc](../docs/architecture.md)'s "Shipping" section for what that needs.

## Tests

```sh
cargo test
```

Most of the board's logic only shows up when it talks to a
running machine, so unit tests here are light (markdown parsing, timestamp
math). The real check is to run the board against the machine.
See the [root README](../.github/README.md).

## Pulls

`P` opens the PR inbox. It shows every open pull request on GitHub where someone requests your review or that you authored. The machine polls GitHub every minute (`:prs` opens the inbox too). The inbox has six splits. Use `h`/`l` or `1`–`6` to move between the splits. Use `j`/`k` to go down the rows, oldest first:

| Split | A PR lands here when |
|---|---|
| Review requested | a teammate's PR asks for your review |
| Ready to merge | yours, and GitHub says it can merge now. Its merge state is clean: reviews and required checks satisfied, no conflicts, not behind. Nothing runs and no thread is unresolved |
| CI failed | yours, a check failed |
| CI running | yours, a check still running |
| Changes requested | yours, changes requested or review threads still open |
| Mine | everything else you authored, drafts included |

Review requested, Ready to merge, CI failed and Changes requested count on the Board tab's badge. They also raise a herdr notice when a PR moves into them.

<!-- keys:start pulls -->
**Pull request**

| Key | Does |
|---|---|
| `m` | merge, delete the branch |
| `c` | CI fix: an agent repairs the red run |
| `v` | review: an agent posts line comments |
| `t` | threads: an agent answers every one |
| `X` | close the PR, unmerged (asks first) |

**Move**

| Key | Does |
|---|---|
| `j / k` | previous / next PR |
| `h / l` | previous / next split |
| `1-6` | jump to that split |
| `enter` | jump to its task, else open the PR |
| `o` | open the PR in the browser |
| `esc / P / q` | close |

**App**

| Key | Does |
|---|---|
| `R` | poll GitHub now |
| `x` | the same actions as a menu |
| `?` | keys |

<!-- keys:end -->

## Backlog

`B` (or `:backlog`) opens the shared backlog. It holds candidates that are not tickets yet, from every source. The machine ranks them by cost of delay over cost of doing, with ties by age. A row shows the score, size, demand, age and a stale mark. The selected item's text and sources sit beside the list. The board flattens text from outside before it draws it.

<!-- keys:start backlog -->
**Item**

| Key | Does |
|---|---|
| `p` | promote: make it a ticket |
| `b` | bump: one more report of it |
| `d` | decline: drop it from the backlog |

**Move**

| Key | Does |
|---|---|
| `j / k` | previous / next item |
| `esc / B / q` | close |

**App**

| Key | Does |
|---|---|
| `R` | fetch the backlog again |
| `?` | keys |

<!-- keys:end -->

`m` merges after one `y` (Ready to merge only), the way the repo allows (squash, else merge, else rebase). `X` closes your own PR without merging, after one `y` in a "Close PR?" modal. The branch stays. The key is off while a task runs for the PR. `c` dispatches an agent that diagnoses the red
run. The agent fixes a fixable one, checks it and pushes it to the PR's branch. `v` dispatches an agent that
reads the diff and posts line comments under your name right away. An approve or request-changes
verdict waits at the Ship gate for `a`. `t` dispatches an agent that answers every unresolved
review thread on your PR. It pushes, posts the replies and resolves the threads it settled. `enter`
jumps to the PR's task on the board when one is running, else opens the PR.

`R` polls GitHub now. A poll reads every PR, so it runs in the background. The header says `◐ polling GitHub…` until the answer lands. Then a toast says `polled GitHub`. A second `R` meanwhile only says it is already polling. Slack's `R` does the same.

From 100 columns the view is a list beside a detail pane. A row reads `✓ ▌repo  #n  title  age  tag` in fixed columns. The checks glyph comes first (`✓` green, `✗` red, `◐` running). The repo's colour bar and name come next (the name after the owner's `/`, in the same colour its cards wear). While a task runs for the PR, a spinner and the work follow (`◐ ci fix`, `◐ review`, `◐ threads`, in bold yellow). `⌂` shows when the machine has no clone of the repo. The board only ever cuts the title. The list scrolls to keep the selected row in view. The pane shows the selected PR. It lists the author and branches, every check by name, the review state and unresolved threads. It also lists the task in flight and the keys, with why each is off. Under 100 columns the pane hides, and `x` shows the same detail over the list. A dispatch on such a PR opens the clone prompt. It is the same filter-as-you-type search `R` uses, over the folders under `HARDNESS_REPOS_DIR`. `enter` clones into `<folder>/<name>` and runs the action once the clone lands. `esc` leaves the row read-only. `c` and `t` are off on a fork head (nothing can push to it). `v` is off on your own PRs. All three are off while a task already runs for the PR.

## Slack

Since wave 17 the machine reads only the conversations you opted in. That is a channel you watch with `W`, or one listed in `conversation.channels` of a repository's `luna.yaml`. Until you opt something in, the view says so. Each thread shows what the machine made of it. It shows the thread's kind and how sure the machine is. It shows the five scores and the total, and the knock-out when one hit. It shows "asks you" when the machine is not sure. It shows the card or backlog item the thread relates to (for a ticket-sourced card, `about a card from <kind> <key>` on its own line). It shows how many secrets the machine cut. It shows the draft that waits, with how long until it expires. `c` sets the kind, and `L` sets the card or backlog item the thread is about (the picker lists only the candidates the machine listed). Both store an answer and teach the machine. Neither posts. The board posts nothing until you tap. `r` sends or edits the draft. `d` ignores a waiting draft and asks why. The answers are `n` (the thread needed no reply), `b` (the draft was bad) and `s` (skip). The answer teaches the machine, and nothing posts. `t` makes the card.

`S` opens the Slack inbox (`:slack` too). It shows everything your Activity tab shows, plus the handles you watch. The machine polls it every minute, and a triage pass sorts it. The inbox has six splits. Use `h`/`l` or `1`–`6` to move between the splits. Use `j`/`k` to go down the rows. Needs reply and Decide go P0 first, then oldest. The other splits go newest first.

| Split | An item lands here when |
|---|---|
| Needs reply | triage expects a reply and you did not reply |
| Waiting on them | you asked something in a thread and nobody answered |
| Decide | a decision or a blocker without an explicit question |
| FYI | everything P2/P3 that is not automated |
| Snoozed | you pressed `s`; it returns to its split when the timer ends |
| Done | you replied, pressed `d`, or made it a ticket |

A P0 or P1 entering Needs reply or Decide counts on the Board tab's badge and raises a herdr notice. So does any item whose thread moved after you cleared it (`Reopened`). Lower priorities and the other splits are quiet.

<!-- keys:start slack -->
**Message**

| Key | Does |
|---|---|
| `r` | reply: edit the draft, ctrl+s posts |
| `t` | ticket: a Backlog task from the thread |
| `d` | done: clear it; a draft asks why |
| `s` | snooze: 1h, 3h, tomorrow or Monday |
| `o` | open the message in Slack |
| `N` | nudge: a one-line reminder |
| `!` | priority up one step |
| `-` | priority down one step |
| `c` | kind: what the thread is |
| `L` | link: the work it is about |

**Move**

| Key | Does |
|---|---|
| `j / k` | previous / next message |
| `h / l` | previous / next split |
| `1-6` | jump to that split |
| `enter` | jump to its ticket, else open in Slack |
| `esc / S / q` | close |

**App**

| Key | Does |
|---|---|
| `W` | Watches: handles, keywords, channels |
| `R` | poll Slack now |
| `x` | the same actions as a menu |
| `?` | keys |

<!-- keys:end -->

`r` opens the editor with triage's draft (vim keys, like every editor). `ctrl+s` posts it as you
in the thread, and `esc` backs out. The board never sends anything without the key. `t` makes a Backlog task
from the message and its thread. The task title is the summary. The task goes in the repo that the channel name matches.
It asks for one `y` first, and the repo picker follows when the board guessed none. `d` clears the item here at
once. The board does not touch Slack itself. If the thread moves afterwards, the item comes back,
re-triaged, with `new since you cleared it` in the pane. `s` snoozes for 1h, 3h, tomorrow 9:00 or
next Monday 9:00 (your local 9:00). `N` (Waiting on them only) opens the reply editor with a
one-line reminder. `!` / `-` move the priority one step. Re-triage keeps your value. `enter`
jumps to the item's ticket on the board when it has one, else opens the message in Slack.

From 100 columns the view is a list beside a detail pane. A row reads `P0 ▌#channel  @author  summary  age  tag` in fixed columns. The priority comes first (`P0` red, `P1` yellow, `P3` muted). The channel's colour bar comes next (the same hue a repo of that name wears on the board). Then come the author and triage's one-line summary. The summary is the only column the board ever cuts, and `×N` shows when a thread's mentions collapsed into one row. The age follows. The tag comes after the age. It shows `⎇` for a thread and `⚙` once it is a ticket. It shows `↺` when it came back after you cleared it. The pane shows where and who, the thread's last messages and the message itself. It shows triage's verdict (`P0 · blocker · reply expected`) and why. It shows the links it found, with the linked PR's split from your Pulls inbox. It shows the draft and every key, with why it is off. Under 100 columns the strip shortens its labels (`Reply`, `Wait`, `Snz`…). The pane hides, and `x` shows the same detail over the list. The strip also says when the machine last polled Slack and, with an app token, whether the Socket Mode websocket is `live` or down.

Every item that expects a reply carries a due time under the reply SLA for its priority. The targets come from the rules file's `## SLA` section (defaults: P0 10m, P1 30m, P2 and P3 1h). The machine computes them, and the board only shows them. The pane says `due      in 12m (P1 · 30m SLA)`. Within five minutes of that time, the row's age turns yellow. Past it the item is overdue. The row's summary and age go red, and the tag leads with `‼`. The item sorts to the top of Needs reply and Decide (the longest overdue first, ahead of P0). The strip counts the overdue items as `‼ N overdue`. The Board badge counts each one once, whatever its priority. A notice fires the moment the item tips over (once). Coming back inside the SLA is not news.

### Watches

A watch is anything beyond your own handle that the inbox should treat as addressed to you. It can be a user group (`@platform-team`), a broadcast, a keyword, or a whole channel. The broadcasts are `@here`, `@channel` and `@everyone`. They ship on, and you can switch them off but not delete them. `W` opens the watches. `e` cycles the priority floor through none, P0, P1, P2 (an item that matches the watch is at least that). After `n`, type `@` to complete a user group, and `#` to complete a channel. Anything else is a keyword. `enter` saves it. Watches live in the machine, so every board shares them and triage reads them.

<!-- keys:start watches -->
**Watch**

| Key | Does |
|---|---|
| `n` | add: @handle, #channel or a word |
| `d` | delete the watch |
| `space` | switch it on / off |
| `e` | cycle its priority floor |

**Move**

| Key | Does |
|---|---|
| `j / k` | previous / next watch |
| `esc / W / q` | close |

**App**

| Key | Does |
|---|---|
| `?` | keys |

<!-- keys:end -->

## Jira

A ticket carries at most one Jira issue. The machine syncs it, and the board shows the link. The repo's `luna.yaml` says which Jira status each task state moves it to. `J` on a ticket with no issue opens a prompt like `R`'s repo search. Type a key or a few words. The machine searches from the third character on (`GET /jira/search`, your open issues first). Rows read `PLAT-123  In Progress  summary`. `enter` links the row (`POST /tasks/:id/jira`). `ctrl+n` (or `enter` on the first row, `+ create an issue from this ticket`) creates one in the repo's project and links it (`POST /tasks/:id/jira/create`). `esc` backs out. A typed key such as `PLAT-7` links as is without picking a row. `:jira PLAT-7` does the same from the palette (`:jira` alone is `J`). On a linked ticket, `J` asks `unlink PLAT-123? y/n`. `y` drops the link and leaves the issue alone. On a machine without Jira configured, the prompt refuses with the reason in the footer. `x` lists the key with the other actions.

What the ticket shows:

- Overview: `Jira       PLAT-123 · In Progress · due Fri · High` (muted `—  J links an issue` until linked). A red `⚠ blocked: no transition to "In Review" from "Blocked"` line shows under it while the machine refuses the last declared transition. An `SLA` row shows the clocks the ticket has. It shows `gate 12m of 1h` (red `overdue 40m` once past). It shows `stage implementing 42m of 4h` (yellow from 80% of the target, red past it). It shows `cycle 1d 3h of 3d`. It shows `jira due Fri` (red when the issue's due date passed). The row leaves out clocks the machine does not report. A machine without them has no row.
- Cards: the second line ends in ` · PLAT-123` when linked. A ticket past any clock leads with `‼`, and its head line goes red, like an overdue Slack row. A stage past 80% turns the age yellow. A ticket made from a Jira issue wears the key in front of its title where a GitHub one wears `#42`.
- Activity: `jira → In Progress`, `jira blocked: no transition to "In Review" from "Blocked" — why`, `jira moved to Done`.
- Within a column a ticket past its gate SLA sorts first, whatever the order. The `!` filter keeps that.
- Notices: `Gate overdue` the moment the gate clock tips over (once), and `Stage over SLA` when the stage clock does. `Jira` when someone moves the linked issue in Jira while the ticket runs (`PLAT-123 moved to Done while #abcdef12 runs`). The header counts the tickets past a clock as `‼ N overdue`. The Board tab's badge reads `Board !2 ‼1`: the needs-you count as before, then the overdue count. An overdue gate already waits on you, so the badge does not count it twice.

## Floor

`F` opens the Floor: one full-screen table with a 7d and a 30d column. It reads from the machine's `GET /metrics?since=7d|30d`. The table shows tasks closed, created and open, what needs you, and running and queued now. It shows cycle time (median and p90). It shows the gates answered and the share answered within their SLA, with the median wait per gate state (`wait approval median`, from `metrics.gates`). It shows first-pass rate for verifying, ci_watch and implementing. It shows escalation rate with the top reasons, retries per task, and cost. It shows queue depth, slot use and utilisation. A per-stage table (runs, median, p90, cost) sits below it, or beside it on terminals 110 columns or wider. With the Slack inbox on, a Slack block sits under the stage table. It shows items and replies by priority over 7d / 30d. It shows how many of the 7d replies came inside their SLA (count and share). It shows the median and p90 time to reply, and the share answered within an hour. It shows the SLA targets in force as `10m/30m/1h/1h` (`GET /slack/metrics?since=7d|30d`). A machine without the inbox simply leaves the block out. Above the per-repo table, an engine table shows each engine over 7d (`GET /metrics?groupBy=engine`, for the focused repo when one is). It shows the stage runs, first-pass rate, escalations, runs that hit a usage limit, mean turns and cost. It shows `(none)` for host-only stages and runs from before engines. Then it shows this month's spend against the cap that binds it (`$16.00 / $20.00`, `$3.10 / no cap`, from `GET /engines`). An engine with a cap or a spend but no runs this week still gets its row. One at or past its cap reads red. A machine from before engines gets one line, `the machine does not report engines`. An engine cap crossing 80, 90 or 100% (`budget.alert`, scope `engine`) raises a notice naming the engine. The view loads numbers when you open it and again on `R`. Refresh is `R` in every view, as Pulls and Slack poll with it. If the machine is unreachable, the error shows in the footer and the last numbers stay. Fold moved from `F` to `z` to make room.

<!-- keys:start floor -->
**Move**

| Key | Does |
|---|---|
| `tab / shift+tab` | focus the next / previous repo |
| `esc / F / q` | close |

**App**

| Key | Does |
|---|---|
| `R` | refresh the numbers |
| `A` | approve a waiting base image |
| `?` | keys |

<!-- keys:end -->

## Inbox and Digest

`I` opens the Inbox. It shows every ticket that waits on you, split by why (Approve, Answer, Retry, …).
`a`, `r` and `e` act on the row in place. `A` approves every ticket in the Approve split after one
`y`. `enter` opens the ticket.

<!-- keys:start inbox -->
**Gate**

| Key | Does |
|---|---|
| `a` | start; approve the setup; answer triage's questions; approve the plan; approve the split; archive the ticket (one click); post the reply and close the ticket; approve the tests; ship: publish, watch the PR; ship: approve the release; retry the escalation, with guidance; resume after the usage limit; approve the memory review; advance |
| `T` | correct the triage record |
| `p` | post these questions at the source |
| `N` | reject the plan, with a comment; reject the split, with a comment; reject the release, archive the card |
| `r` | send back with a reason |
| `S` | ship: approve and open the PR |

**Ticket**

| Key | Does |
|---|---|
| `X` | abort the running stage (asks first) |
| `w` | kill its worktree (asks first) |
| `Z` | archive, with a reason |
| `C` | correct the escalation reason |
| `d` | delete (asks first) |
| `f` | open or focus the agent's watch tab |
| `J` | link a Jira issue (search or create); unlink the Jira issue (asks first) |
| `R` | set the repo (search) |
| `e` | edit the ticket in place |
| `o` | open the linked issue in the browser |

**Move**

| Key | Does |
|---|---|
| `j / k` | previous / next ticket |
| `h / l` | previous / next split |
| `1-5` | jump to that split |
| `enter` | open the ticket |
| `esc / I / q` | close |

**Marks & bulk**

| Key | Does |
|---|---|
| `A` | approve every ticket in Approve |

**App**

| Key | Does |
|---|---|
| `?` | keys |

<!-- keys:end -->

`D` opens the Digest. It shows what changed since you last had the board open. `enter` jumps to the
ticket. `o` opens its PR or issue.

<!-- keys:start digest -->
**Ticket**

| Key | Does |
|---|---|
| `o` | open its PR or issue in the browser |

**Move**

| Key | Does |
|---|---|
| `j / k` | previous / next entry |
| `enter` | jump to the ticket |
| `esc / D / q` | close |

**App**

| Key | Does |
|---|---|
| `?` | keys |

<!-- keys:end -->
