# Luna for the Herdr app

The factory's board as a pane in [Herdr](https://github.com/herdrdev/herdr-app), the desktop app for terminals and coding agents. It is a second client of the machine, beside the TUI board (`board/`). It reads the same API and the same event stream. It never decides anything the machine decides.

It draws with Herdr's own theme colors, so it follows the light or dark theme you pick in Herdr. The layout follows the Luna design canvas:

- A sidebar with the views (Everything, Waiting on you, Agents working, PR work), the projects and the machine's link.
- The columns in three groups (Plan, Make, Ship), with Done folded to a rail.
- An inspector beside the board. It shows the gate and its actions, then Details, Activity, Runs and Changes.

## Install

Install Herdr (`brew install --cask herdr-app` on Apple Silicon), then from this repository:

```sh
make herdr-app                                   # links herdr-app/luna into Herdr's mods and checks it
herdr-app do tab.new --mod luna --name Luna      # opens it as a tab (or split a pane: pane.split {mod: "luna"})
```

The link is a symlink, so a `git pull` updates the mod. A save reloads its code in place. Reopen the tab when `init` changed, because a reload keeps the running copy's state.

The mod finds the machine the way the TUI does:

- **Where:** `HARDNESS_MACHINE_URL`, else the dev machine on `:4317`, then the Docker one on `:4318`. Each is probed on `/health` for 800 ms; when none answers it stays on the first, as the TUI does. The live stream needs `http://` (over `https://` the board polls every 30 s and says so).
- **Token:** `MACHINE_API_TOKEN`, else `~/.config/hardness/machine-api-token`.
- **Approver:** `LUNA_APPROVER` is sent as the approver on every decision, as the TUI sends it.

It reads these through your login shell, once per pane. The token is never shown. The link says Live only while bytes flow: after 40 s with nothing (the machine pings every 15 s) the stream is closed and retried after 3 s, doubling to 60 s, and the board is read every 30 s while it is not live.

## What it does

| Where | What |
|---|---|
| Board | Cards by column, the ones that need you first. A card that waits on you is framed in Herdr's `blocked` color, and a running one in `working`. The quick action on a card is Start, Approve, Retry or Resume. |
| Inspector | **The gate:** the plan (risk, brief, steps, coverage gaps, a split), the questions, the test cases, the release checklist, the review to post with its verdict and line comments, the escalation with its output, the context or duplicate check. **Actions**, each with the TUI's condition: approve, send back (a setup, plan, tests, the ship preview and an escalated feature card; never the release question, the retro, a review or an escalation off the feature route), reject (plan or split), **Reject the release** beside Release at the release question, keep whole, answer, give context, decide the duplicate, retry, resume, stop (also on a paused card), archive (any open card, a draft too), delete (any card, asking first). A closed card says Closed, or Shipped only when its events show a merge, or Reply posted, or Closed as a duplicate of #x. An approval refused for coverage gaps opens the dialog that excuses them (none ticked at first, at least one required; criteria already excused are not offered). |
| More menu | Each shows only where the TUI's key would work. **Decisions:** approving asks once, with the TUI's confirm text ("Ship #abcd1234?", "Approve the release of #abcd1234?"), and says what happens from the gate: how many names the repository's rule needs ("first of two approvers"), whether a split makes cards or tracker tickets, whether a setup closes the card or goes on to triage. Every approval, send back, rejection, keep whole and skip-the-rules captures the gate when its dialog opens and sends only if the card still waits there; a card that moved says so and nothing is sent. An approval that leaves the gate open says who approved and how many more are needed. Keep it whole and Post the questions ask first. Send back, reject and reject the release need a reason. An escalated card becomes Retry with guidance (optional note, only while still escalated), Stop asks first, Approve skipping the memory rules. The answer dialog starts from triage's recommended answers. **Edits:** the ticket, the plan (steps, rollback and risk only until it is approved; steps come from the plan's own steps and keep their files and sizes; a risk goes only with a reason), the test cases, the triage record, the escalation reason, the repository (known repos or the system folder picker). **Jira** (only when the machine has it configured): link, create, unlink. **Findings and evidence:** dismiss a finding Verify reported, add one it missed, mark the Evidence Pack useful or not. **Duplicates:** close as a duplicate of another card, bring it back. **Workspace:** remove the worktree (asks again before discarding unpushed commits), set a repo up (`setup` command too), open the issue, open the PR, and Watch the running stage in a Herdr tab that follows its container. |
| Inspector tabs | A ticket opens on the page of its state (the TUI's rule): **Now** for a running card (scenarios red and green, iterations/tokens/minutes against the limits, the last checkpoint, the latest activity), **Stopped** for a stopped one (the reason, how sure the machine is, what the agent said, a correction, the summary, the failing output, a kept sandbox), **Result** for a shipped one (the release question and checklist, the summary, open findings by level, the evidence count), the plan on a plan gate. Each of those shows only where it applies, and so does **Reports** (the Build Report: iterations, scenarios, tokens, minutes, diff, tests first, sweep, scope check, runs; the Verify Report: tests, review engine, rounds, browser run by scenario, findings with their resolution). **Overview:** each criterion with its state in the plan, its cases and what verifying found; repo, branch, issue, sources, reporter, followers, owners, merged into, related; split part, depends on, stacked on, risk floor and why it is held; Jira link, SLA clocks (late in red, close in yellow), why, spend, description, a setup gate's `luna.yaml` and proof, the memory review's rules. **Plan:** triage's plan read like the review page (brief, criteria, assumptions, steps with size and files, rollback, code map and how far behind it is) and, from the machine, the flags (plan issues, criteria with no scenario, ones excused as untestable, risk raised or overridden, a stale map, flagged checks), the checks, the coverage, and the approval rule with the names so far ("first/next/last of N approvers"); the same flags and rule show in the gate panel, where the gap count leaves out excused criteria. And its history (send-backs and why, edits, the approval and who). **Tests:** the cases under the criterion each proves (a long criterion ends in an ellipsis), with ✓ ✗ – from verifying. **Runs:** every stage run with time, cost, turns and engine; click one for its error, case verdicts and files. **Changes:** the files; click one to read its patch as diff rows (it says when the machine cut it at 512 KB); Open file. **Evidence:** the Evidence Pack and every artifact by run, with Open and Folder. **PR:** the ship checklist, merge and review rules, and the PR's checks, review and threads (Merged, with who and the sha, once it merged); open on GitHub. **Engines:** the stages this ticket's route runs, each with its engine (yours, else the default) and the one it ran on; Change opens a picker (an engine with no credential is dim and cannot be picked; a stage that ran keeps its engine), and a ticket that ended has no Change. **Activity:** every event. The tab bar wraps onto more rows, so every tab is in view at the inspector's narrowest. |
| PRs | The inbox (PRs involving you) and All repos, split as the machine splits them, with a repo filter. **Actions:** review, fix CI, address the threads, merge, open on GitHub. A PR you have not cloned offers Clone…, which opens the system folder picker. |
| Inbox | Every ticket that needs you, split by why (Approve, Review, Failed, Stale), the one waiting longest first. Each row has its gate question and gate actions; click it to open the ticket on the board. **Approve all** asks once, then approves every plan, split, ship and release in Approve, each only if its card is still at the gate it was listed at. |
| Digest | What changed since you last had the pane open (a first run shows everything with news), in four groups: Shipped, Escalated, Needs you, Closed. A row opens its ticket, or its PR or issue. |
| Floor | The factory's numbers over 7 and 30 days, per repository, per engine (with the month's spend against its cap) and per stage. The stage pool with **Drain / Carry on**, one more or fewer slot, and **resume every paused ticket**, each asking first. **Approve** a base image that waits for your yes. |
| Backlog | Candidates that are not tickets yet, ranked by the machine (score, size, demand, stale, sources, what each waits for). **Promote** makes a ticket, **Bump** counts one more report, **Decline** asks first. |
| Tickets | The ticket machine's tickets with status, scores and the drafts waiting on you. **Approve** (or approve the split), **Post my text**, **Ignore**, **Make a card**, **To the backlog**, offered where the TUI offers them. |
| Slack | The inbox the machine builds from your conversations, in six splits (Needs reply, Waiting on them, Decide, FYI, Snoozed, Done) with counts. Each thread shows who, where, the text, triage's verdict and why, the SLA, and the PR or ticket it relates to. **Actions:** reply (the draft is editable; it posts as you only when you press Post, and says so when the machine has no Slack user token), make a ticket, done (a waiting draft asks why), snooze, open in Slack, nudge, priority up or down, set the kind, link to the work it is about, poll now. The sidebar badge counts what needs a reply and turns red while any is overdue. **Watches:** the handles, usergroups, channels and keywords the inbox treats as addressed to you: add, switch on or off, set the priority floor, delete (built-ins only switch off). With Slack not set up it says what the machine says and points to `make integrations`. |
| Economy | One repository's token spend: the facts the machine learned (drop a wrong one), the tool mask per pack (approve a proposal, restore a tool), the loop guard's latest events and the cost split. Dropping, approving and importing past runs ask first. Says so when the machine runs with the economy off. |
| Jira | Whether the machine reaches Jira (site, token expiry, errors) and a search over its issues. Each result opens in the browser and links to the ticket selected on the board; that ticket can also be unlinked, or get an issue created from it. When Jira is not configured it says how (`make integrations`). |
| New task | Title, repository (the system folder picker, or one the board knows), description, criteria, and whether to start now. |
| Alerts | A Herdr notification when a card starts waiting on you. |

## Keys and commands

Click the pane to give it the keyboard, or move onto it with `pane.go`. The keys are the TUI's; `?` lists them in the pane. On the board:

| Key | Does |
|---|---|
| `h` / `l` | previous / next column |
| `j` / `k` (or the arrows) | previous / next ticket in the column |
| `gg` / `G` | first / last ticket in the column |
| `1`-`8` | jump to that column (`8` opens Done) |
| `Tab` / `Shift+Tab`, `]` / `[` | next / previous ticket that needs you |
| `Enter` | open the selected ticket (the inspector) |
| `a` | the selected card's main action: start, approve (asks first), answer, retry with guidance, resume. A held draft says why it waits instead |
| `r` | send back with a reason |
| `N` | reject the plan or split; reject the release |
| `u` | approve, excusing the plan's untestable criteria |
| `A` | memory review: approve, skip the rules |
| `T` / `p` / `C` | correct the triage record / post the questions at the source / correct the escalation reason |
| `e` | edit the plan, else the ticket |
| `f` | open or focus the agent's watch tab |
| `J` | link a Jira issue; unlink it (asks first) |
| `R` | set the repo |
| `o` / `O` | open the linked issue / the PR in the browser |
| `M` / `U` | close as a duplicate of another / bring it back |
| `x` then `S` / `P` / `D` / `+` / `-` / `x` | ship (approve and open the PR) / resume the paused / drain / one more slot / one fewer / the inspector's More menu |
| `F` `I` `D` `B` `$` `K` `S` `P` | Floor, Inbox, Digest, Backlog, Economy, Tickets, Slack, Pull requests |
| `/` | search by title, #id or repo |
| `!` | only the tickets that need you |
| `@` | only the selected ticket's repo (again: all repos) |
| `zc` / `zo` | fold / unfold the focused column (a folded column is a rail: click it to unfold) |
| `zz` | fold every column but the focused one (again: unfold) |
| `gs` / `gr` / `ga` | order the cards by stage, by repo (then stage) or by age (oldest first) |
| `=` | card density: 3 lines, 4 lines with chips, 1 line |
| `v` / `V` | mark the ticket / the whole column (cmd or shift click marks too) |
| `a` with marks | drafts start and paused cards resume at once; plans, splits, ships and releases wait for one yes that names them (`Approve 3 cards? 2 plans · 1 ship`). Replies, archives, setups, test checks, escalations, review posts and questions are left alone and counted. Each approval is sent only if the card is still at the gate the dialog asked about; cards that moved on are skipped and named |
| `X` `d` `w` `Z` | with marks (or on the selected card): stop / delete / remove workspaces / archive. Each asks first, listing the tickets, then runs them one by one and says how many went through |
| `Esc` | clear the search, the filters and the marks, else close the inspector |
| `:` | command palette |
| `?` | the keys sheet |
| `n` | new task |
| `ctrl+r` | read the board again (`r` is send back, as in the TUI) |
| `P` | pull requests (`b` goes back to the board from any other page) |

Folds, the order and the density are kept per pane. `g`, `z` and `x` wait about a second for a second key (and drop it if the page changes); the header lists them.

A card shows what the TUI's does: `‼` and a red title when any SLA clock is past, a yellow age while the running stage is past 80% of its target, `⎇` for a workspace, `×N` for retries, `part n/of`, the `#42` / `⌁` / Jira key / `notch` prefix, `$` above the p90 of spend, and `no repo` on a draft with none. The header says `‼ N overdue`, and a gate past its SLA leads its column in every order.

The palette (`:`) filters as you type: `Tab` completes and cycles, the arrows pick, `Enter` runs the picked entry, or the only one left, or the text as typed. It runs the TUI's `new <title>`, `filter <text>`, `repo <name>`, `open <#id>`, `group stage|repo|age`, `fold`, `unfold`, `start`, `whole`, `dismiss <finding id> [reason]`, `finding <blocker|should_fix|nit> <title>`, `ticket-edit <text>`, `dedup duplicate <n> | related <ns> | neither`, `dup <id>`, `undup`, `context repo|project|text <value>`, `jira <KEY>`, `slots <n>`, `drain` and `resume`, plus `refresh` and every verb a feature registers. An unknown verb says `unknown command: x`.

On the PR page:

| Key | Does |
|---|---|
| `j` / `k` | previous / next PR |
| `h` / `l` | previous / next split |
| `1`-`7` | jump to that split, in the TUI's order: review requested, ready to merge, CI failed, CI running, changes requested, mine; `7` all repos. A split lists the oldest PR first, All repos the newest |
| `m` | merge (asks first) |
| `c` / `v` / `t` | fix CI / review / answer the threads; an off key says why. On a PR that is not cloned they ask for the folder, clone, wait for the clone and then run |
| `X` | close your own PR without merging (asks first; refused for other people's PRs and while a task runs for it) |
| `C` | clone the repository |
| `f` / `F` | show one repo / every repo |
| `o` | open on GitHub |
| `Space` / `x` | show every check by name, with its state and link, and the open threads |
| `Enter` | jump to the PR's task, else open it on GitHub |
| `R` | poll GitHub now |
| `Esc`, `P`, `q` | back to the board |

The same commands can be bound in Herdr's `keys.json` under `"mod:luna"` (for example `"alt-l": "luna.next"`).

A script or an agent can drive the pane through files. Write a file with one command per line into `~/.config/herdr-app/luna-inbox/`. Each file is read once and then removed. The commands:

- the keys' commands: `next`, `prev`, `close`, `refresh`, `new`, `board`, `prs`, `approve`
- `select <task id or its start>`
- `tab details|activity|runs|changes`
- `list inbox|all`
- `act <action>` (an action from the inspector)
- `done on|off`

```sh
echo "select 30f4574d" > ~/.config/herdr-app/luna-inbox/open
```

## How it is built

Herdr mods are JavaScript that describe native GPUI elements. There is no DOM, no npm and no `setTimeout` (see `~/.config/herdr-app/AGENTS.md`).

| File | Holds |
|---|---|
| `luna/main.js` | the state, the stream loop, the actions, the keys and the inbox |
| `luna/model.js` | pure rules: columns, card looks, gate questions, actions per state, PR status and actions, stream updates |
| `luna/wire.js` | the HTTP head, chunked framing and SSE parsing. Herdr's `fetch` answers whole bodies only, so `/events` is read off a `net` socket. |
| `luna/api.js` | the machine client |
| `luna/board.js`, `inspector.js`, `prs.js`, `dialogs.js`, `ui.js` | the drawing |
| `luna/page-slack.js`, `page-economy.js`, `page-jira.js` | the Slack (with its watches), Economy and Jira pages, each registered in `features.js`; `page-kit.js` holds what they share and `integrations-model.js` their pure rules |
| `luna/icons/` | line icons, tinted with the text color |

A dialog is the same mod opened as a Herdr overlay with `props().dialog`. It makes its call to the machine and closes. The board sees the result on the stream. A task to select, a palette command, a repo to filter by or a bulk result comes back through Herdr's shared state (`app.handBack(kind, value)`); the board reads it on a 250 ms timer, outside render, and ignores a value older than the pane.

## Tests

```sh
pnpm app:test
```

The tests cover:

- `model.js` and `wire.js`, as plain functions
- every page and every gate, drawn under Node with Herdr's host modules replaced by `test/host/` (a stand-in that chains every element call), so a field the machine leaves out crashes there and not in your pane

`herdr-app check ~/.config/herdr-app/mods/luna` loads the mod in Herdr itself. It renders the first frame only.
