# Install

## Prerequisites

- Docker (for Postgres and the stage containers)
- Node 24+ and pnpm
- Rust (to build the board)
- Nothing else. `pnpm start` and `pnpm dev` first build both stage images from this checkout (`pnpm images`). The runner image holds Node, `gh`, Go and Rust toolchains, and the Codex CLI. It also holds the factory, with the SDKs of its three runtimes and the prebuilt eve agents. It takes about 3.2 GB on disk. The QA image builds on top of it. It adds Playwright with Chromium, ffmpeg and agent-browser. It takes about 2 GB more: 5.2 GB. The first build takes a while. Later builds reuse the Docker cache.
- [herdr](https://herdr.dev/), to run the board as a plugin

## Guided setup

```sh
make setup
```

It walks a fresh Mac through everything below, one step at a time. Every step is also its own target. You can run each target again safely:

| Target | Does |
|---|---|
| `make tools` | installs what is missing with Homebrew after one confirmation (Docker Desktop, Node, pnpm, Rust, gh, herdr; gum, Codex and Claude Code if you want them) |
| `make credentials` | each engine's credential into `~/.config/hardness/` (0600): Claude through `claude setup-token`, the Codex login, an OpenAI key and a Jev key (Vercel AI Gateway or TypeSafe) if you use them; the machine's API token; `gh auth login` |
| `make integrations` | Jira, the Slack inbox and machine settings (where your repos live, engine budgets) into the root `.env` (0600), each tried against its service; `machine/.env` is linked to it for `pnpm dev` |
| `make up`, `make down` | `pnpm start`, `pnpm stop` |
| `make board` | `pnpm board:link` |
| `make luna-yaml REPO=<path>` | a repo's `luna.yaml`: Jira (the statuses listed from your project when the Jira keys are set), engines, policy, budgets and SLAs; an existing file keeps its comments, the change is shown as a diff, and nothing is written that the machine would refuse. Checks and services come from the board's `:setup <repo>`, which proves them |
| `make doctor` | what is installed, set and running, and what is missing; never prints a secret |

**In Claude Code**, the `luna-setup` plugin sets up a repo with you. It writes the checks, the services, the app start for the browser check, and the hosts that the sandbox can reach. It proves each check in the machine's sandbox. Then it opens the file as a PR. Install the plugin once. Then ask Claude in any repo to set up Luna:

```sh
claude plugin marketplace add HigorAlves/luna-tui      # or the path of your Luna checkout
claude plugin install luna-setup@luna-tui
```

`make luna-yaml` asks only about preferences (Jira, engines, budgets, SLAs). `:setup <repo>` proves only checks and services. The skill does both. It also finds the app start and the egress hosts.

No key ever goes into `luna.yaml`. That file lives in the repo, and you usually commit it. The scripts are in `scripts/setup/`. They use gum for the prompts when you have gum, and plain prompts otherwise. Each script opens with Luna's mark in the terminal. The mark moves on a real terminal. `LUNA_NO_ANIMATION=1` keeps it still. `NO_COLOR=1` drops the colours.

## Quick start (by hand)

```sh
pnpm install
pnpm start            # builds the stage images, then Postgres + the machine on http://127.0.0.1:4318, in Docker
pnpm board:link       # builds the board and links it into herdr once; `pnpm board:build` alone rebuilds it after that
```

## Two ways to run

- **`pnpm start`**: Postgres and the machine both run in Docker. You keep no server open in a terminal. It passes your `gh auth token` to the machine as `GH_TOKEN`. This is the one credential that the machine's GitHub calls use. It also passes your git identity. A bare `docker compose up` passes neither, so the machine answers `/health` with 503 and the reason (`docker compose up --wait` fails, and `make doctor` prints it) instead of failing each card at its first push. `pnpm stop` stops both and keeps the data. Stage containers still run on your Docker. So the machine mounts repos, worktrees and run folders at the same paths as on your host. See [configuration.md](./configuration.md#compose).
- **`pnpm dev`**: use it to work on the harness itself. It stops the machine container. It starts only Postgres (`docker compose up postgres`). It runs the machine on your host at http://127.0.0.1:4317 with hot reload. It loads `machine/.env` if one exists. `pnpm db:down` stops Postgres and keeps its data.

Both use the same database. Tasks carry over when you switch. For board usage and keys, see [`board/README.md`](../board/README.md).

## Slack inbox

`S` on the board is your Slack Activity tab, triaged. It needs a small Slack app of your own. Install the app only in your workspace. You create it once from the manifest in this repo.

To create the app:

1. Open <https://api.slack.com/apps>.
2. Click **Create New App**.
3. Click **From a manifest**.
4. Pick your workspace.
5. Paste [`slack/manifest.json`](../slack/manifest.json).
6. Click **Create**.

To get the user token:

1. Click **Install to Workspace**.
2. Allow the install.
3. Open the app's **OAuth & Permissions** page.
4. Copy the **User OAuth Token** (`xoxp-…`).

To get the app token:

1. Open **Basic Information → App-Level Tokens**.
2. Generate a token with the `connections:write` scope.
3. Copy the token (`xapp-…`).

The app token feeds the live socket. The socket brings in reactions and replies as they happen. Without it, the inbox polls once a minute and shows no reactions.

To connect the machine:

1. Put both tokens where the machine reads them: `machine/.env` for `pnpm dev`, or a root `.env` (or the shell) for `pnpm start`:

   ```sh
   MACHINE_SLACK_USER_TOKEN=xoxp-...
   MACHINE_SLACK_APP_TOKEN=xapp-...
   ```

2. Start the machine.
3. Press `S` on the board.
4. Press `W` to add the team handles (`@platform-team`), keywords or channels that the machine treats as addressed to you.

The token is yours, so replies from the board post as you. The board posts nothing until you press `ctrl+s` in the reply editor. `d` clears an item on the board only. `MACHINE_SLACK_MARK_READ=on` also marks it read in Slack. Priorities and drafts come from the `slack_triage` pack. The pack is a harness agent. Its default engine is `claude:haiku`, at low effort, with no tools. It runs in the stage container with your Claude credential, the same way every stage does. It makes one short run for each batch of new messages after the poll publishes. Without Docker or a credential (or with `MACHINE_AGENTS=off`), the inbox still fills. It sorts items by time and shows no priorities. The triage follows rules about VIPs, muted channels, quiet hours, always-P0 keywords and your notes. These rules live in `~/.local/state/hardness/slack-triage.md` (`MACHINE_STATE_DIR`). On first run, the machine writes this file from the template in [`docs/agents/slack-triage.md`](./agents/slack-triage.md). `MACHINE_SLACK_RULES` moves it. The `## SLA` section sets how long you give yourself to reply, by priority. The defaults are 10m for P0, 30m for P1, and 1h for P2 and P3, unless you change them. An item past its target turns red on the board. Inside the `## Quiet hours` window, the board raises notices for P0 only. The inbox learns from what you clear and answer. It keeps this next to the rules file, in `slack-triage.learned.md`. Every variable is in [configuration.md](./configuration.md).

## Jira

Tickets stay on the board. A linked Jira issue follows them. You need one token and one block for each repo.

To make the token:

1. Open <https://id.atlassian.com/manage-profile/security/api-tokens>.
2. Click **Create API token**.
3. Make the token unscoped, with an expiry of up to a year.
4. Copy the token.

To connect the machine:

1. Put the site, your Atlassian email and the token where the machine reads them: `machine/.env` for `pnpm dev`, or a root `.env` or the shell for `pnpm start`:

   ```sh
   MACHINE_JIRA_SITE=https://acme.atlassian.net
   MACHINE_JIRA_EMAIL=you@acme.com
   MACHINE_JIRA_TOKEN=...
   ```

2. In each repo's `luna.yaml`, say what the machine does in Jira:

   ```yaml
   jira:
     project: PLAT
     on:
       implementing: In Progress
       awaiting_ship: In Review
       closed: Done
       escalated: Blocked
     intake:
       jql: 'project = PLAT AND labels = luna AND status = Ready'
   ```

The block needs at least `on:` with the statuses you care about. Spell the names as your project's workflow spells them.

Press `J` on a ticket to link an issue by key or by text search. `J` can also create an issue from the ticket. A `PLAT-123` in the title or description of a new ticket links by itself. To send an issue to intake, label it `luna`. Intake picks it up after the `jira_intake` agent reads it.

The issue moves when the task enters a mapped state. It gets a comment when the machine picks up the task, when the task opens its PR, and when the task closes. The ticket shows the issue's status, priority and due date. A transition that Jira will not allow shows on the ticket as blocked. The machine tries it again every few minutes while the issue answers. Jira never holds up the pipeline. The token expires after at most a year. Jira does not say when it expires ahead of time. Set `MACHINE_JIRA_TOKEN_EXPIRES` to the date you chose when you made the token. Then the machine warns you once a day in the last two weeks. A scoped token also works through `MACHINE_JIRA_CLOUD_ID`. See [configuration.md](./configuration.md).

## Checks

```sh
pnpm test             # machine, contracts, factory and the evals' grading
pnpm typecheck
pnpm board:test       # board
pnpm golden           # end-to-end, needs a running machine
```

- `pnpm golden`: one ticket through every gate. It needs a running machine. Real agent stages need a credential and docker. Otherwise it uses stubs.
- `pnpm golden --matrix`: the grader over every fixture ticket. It needs a running machine, a credential and docker.
- `pnpm golden:live`: abort, retry and concurrency paths in sequence. It needs a running machine with a credential and docker. For concurrency, start the machine with `MACHINE_MAX_CONCURRENT=1`.
- `pnpm --filter @hardness/machine smoke:sandbox`: it runs the `evidence` pack and a dry-run `implementing` pack in the hardened container. It needs docker and `runner:build`. It needs no machine or credential.
- `pnpm golden --selftest`: fixtures only. No machine, credential or docker.
- `pnpm --filter @hardness/factory test`: the runner's own tests. They cover the guards and roots, the prompt renderer, the ledger tools and the result writer. They also run a dry run of every pack and the conformance table on each runtime's fake (Claude, eve, Jev). They need no credential.
- `pnpm eval`: replay evals of a pack on an engine, in the stage image. It needs a credential and docker. It runs locally only. See [evals/README.md](../evals/README.md).

`pnpm golden --matrix` runs every ticket of `fixtures/golden-task`, `golden-web` and `golden-cli`. Each fixture holds a bug and a feature. The command grades the suite, stages, stubs, evidence verdict, cost and diff size. It exits 1 under an 80% pass rate. It writes `golden-result.json`. `--only <fixture>`, `--ceiling-usd` and `--threshold` tune it. The nightly `golden` workflow runs it. `node machine/scripts/golden-task.mjs --selftest` checks the fixtures without a machine.

`pnpm golden` drives `fixtures/golden-task/` through every gate of the pipeline against a running machine. It works the same way the board does. It checks that the implementer's fix makes its tests pass. Run it after any change to the engine, the API, or the agents.
