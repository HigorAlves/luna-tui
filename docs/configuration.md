# Configuration

## Credentials

Put `claude-oauth-token` or `anthropic-api-key` in `~/.config/hardness/`. Without one, nothing runs for real: every task stage's default engine is a Claude one (the Slack inbox's triage and Jira intake's too), so the machine makes every stage a stub. `POST /runs` is the exception: it runs a pack on any engine whose credential is there.

Each engine runs on its own credential, and a stage gets only its own engine's: a Claude stage never sees the Codex login or an API key, a `codex:*` stage never the Claude token. The one exception is a pack whose helper runs on another engine (`verifying`'s `second-opinion` on `codex:sol`): the helper runs inside the stage's container (`delegate`, see [architecture](architecture.md#factory-mode)), so the stage also gets that helper's credential, each credential once. The Codex login is then taken for the whole stage, one Codex run at a time as below; a helper's credential that is missing, held back (`MACHINE_DISABLE_RUNTIMES`, a monthly cap) or held by another run past two minutes is left out with a `stage.note`, and the stage runs without the helper. The machine reads them when a stage starts, so a login or key added later counts without a restart. `GET /engines` says which engines this machine can run and, for the others, what is missing.

| Engines | Credential | Read from | Reaches the stage as |
|---|---|---|---|
| `claude:*` | the subscription token, else an API key | `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, then `claude-oauth-token`, `anthropic-api-key` in `~/.config/hardness/` | that one variable |
| `codex:*` | the Codex (ChatGPT) login | `$CODEX_HOME/auth.json`, else `~/.codex/auth.json`, as `codex login` writes it | a per-run copy (below), `CODEX_HOME=/tmp/.codex` |
| `openai:*` | an OpenAI API key, opt-in and metered | `OPENAI_API_KEY`, then `~/.config/hardness/openai-api-key` | `OPENAI_API_KEY` |
| `jev` | a Vercel AI Gateway key or a TypeSafe API key, opt-in and metered | `AI_GATEWAY_API_KEY`, then `~/.config/hardness/ai-gateway-api-key`, then `TYPESAFE_API_KEY`, then `~/.config/hardness/typesafe-api-key`: the first found | that one variable |

An engine a task or a repo's `luna.yaml` picked for a stage whose credential this machine lacks gives way to the pack's default, and the task logs `stage.engine` with the reason; the default itself without its credential fails the stage with the reason.

The Codex CLI owns its login and rewrites `auth.json` when it refreshes the token, so no stage shares the host's file. Each `codex:*` run gets its own copy, `auth.json` (0600) in a `codex/` folder (0700) under the run's folder in the state dir, mounted writable at `/tmp/.codex`. Once the container is gone, a copy the run changed (Codex refreshed the token) is written back to the host file, atomically (a temporary file, then a rename, 0600), but only while the host file still holds what was copied; if it changed meanwhile (you logged in again, or another run wrote back first) the host's is kept and the machine logs it. A copy that is not a Codex login like the host's (not JSON, other top-level keys, or over 64 KB) is never written back; a write-back that fails removes its temporary file, and the machine removes any `auth.json.*.tmp` left in the Codex home when it starts. The copy is deleted either way.

A refresh rotates the token, so two runs on one copy could revoke the login: `codex:*` runs take turns, one at a time on the machine (stages and context-only packs alike). A run takes the login before it copies it and hands it on after its write-back, so the next run starts from the refreshed token. A stage waiting its turn says so on the task's activity (`stage.note`), and one that does not get the login within its own timeout fails with that reason. Under compose (`pnpm start`) your Codex home (`$CODEX_HOME`, else `~/.codex`) is mounted read-write into the machine container, which sets `CODEX_HOME` to it; see [Compose](#compose).

Jev, the decision model behind `triage_signals`, is opt-in and metered: each call is billed per input token ($0.042 per million, the price in `contracts/src/models.ts`, from which a run's `costUsd` is computed), unlike the Claude subscription. It is reached two ways, and the key the machine finds first decides which: the Vercel AI Gateway (model `typesafe-ai/jev`, through the AI SDK's `experimental_decide`) with a Gateway key, else TypeSafe's own API with a TypeSafe key. With either, intake classifies each new GitHub or Jira issue before it becomes a task (see [architecture](architecture.md#jira)), and `POST /runs` runs `triage_signals` for clients; without one, intake behaves exactly as before and nothing else changes. Keep the key in the file (`umask 077`), never in a shell history or a command line.

| Variable | Default | What it does |
|---|---|---|
| `OPENAI_API_KEY` | unset, `openai:*` off | the key an `openai:*` stage runs on; also read from `~/.config/hardness/openai-api-key`. The `codex:*` engines run the same models on the Codex login instead |
| `CODEX_HOME` | `~/.codex` | where the machine finds the Codex login (`auth.json`) to copy into a `codex:*` stage |
| `AI_GATEWAY_API_KEY` | unset | the Vercel AI Gateway key the Jev runtime calls `experimental_decide` with (model `typesafe-ai/jev`); also read from `~/.config/hardness/ai-gateway-api-key`, preferred over the TypeSafe key when both are there, and passed by name only to a `jev` stage |
| `TYPESAFE_API_KEY` | unset | the key the Jev runtime (`@typesafe-ai/sdk`) calls `systemOne` with when there is no Gateway key; also read from `~/.config/hardness/typesafe-api-key`, and passed only to a `jev` stage. With neither key, Jev is off: `GET /engines` shows `jev` unavailable, `POST /runs` answers 409 `no_credential` for `triage_signals`, and intake classifies nothing |
| `TYPESAFE_BASE_URL` | `https://api.typesafe.ai` | the TypeSafe API root, for a proxy or a test server |

## Environment

See `machine/.env.example`. The defaults match `compose.yaml`, so a `.env` is only needed to change them; `pnpm dev` and `pnpm start` both load it automatically if it exists.

| Variable | Default | What it does |
|---|---|---|
| `DATABASE_URL` | `postgres://hardness:hardness@127.0.0.1:5433/hardness` | Postgres connection string |
| `MACHINE_PORT` | `4317` | HTTP port the machine listens on |
| `MACHINE_HOST` | `127.0.0.1` | interface the API binds to (`0.0.0.0` inside the compose container) |
| `MACHINE_API_TOKEN` | unset; required beyond loopback | the bearer token every API call must carry (`Authorization: Bearer <token>`); also read from `~/.config/hardness/machine-api-token`, which `pnpm start` creates when missing (`pnpm api-token`). With `MACHINE_HOST` beyond loopback and no token the machine refuses to start. The board reads the same variable and file. Never logged. See [api.md](api.md#who-may-call) |
| `MACHINE_MAX_CONCURRENT` | `4` | tasks driving a stage at once, across every repo |
| `MACHINE_MAX_PER_REPO` | unset | running tasks one repo may hold at once, so it cannot take every slot; unset means no cap. Claims go oldest-queued first, the repo with the fewest running tasks first. A repo's own `PIPELINE.md` (`max_concurrent`) overrides it for that repo |
| `MACHINE_MAX_PER_STAGE` | unset | `stage=n` pairs, e.g. `implementing=2,e2e=1,evidence=1`: tasks that may drive one stage at once. Set `evidence=1` where the video image is built: a film runs the voice and cards models and a browser, on top of what e2e used. A task whose next stage is at cap waits in the queue, state kept (`stage.held`). `ci_watch` never holds a slot: it polls GitHub outside the pool and takes a slot again (or queues) for the stage after |
| `MACHINE_AGENTS` | on | set to `off` to make every stage a stub (no credential or Docker needed); the Slack inbox's triage is a pack too (`slack_triage`), so it is off with them and items show no priority; so is `POST /runs` (503 `agents_off`) |
| `MACHINE_GITHUB_POLL` | empty, off | comma-separated `owner/name` repos whose open issues labelled `MACHINE_GITHUB_LABEL` land in Intake as tasks; needs `GITHUB_TOKEN` |
| `MACHINE_GITHUB_POLL_INTERVAL` | `300` | seconds between GitHub polls |
| `MACHINE_GITHUB_LABEL` | `ready-for-agent` | the issue label GitHub intake looks for |
| `MACHINE_GITHUB_PRS` | on | `off` stops the PR inbox from polling GitHub; the board's `P` view then shows nothing |
| `MACHINE_GITHUB_PRS_INTERVAL` | `60` | seconds between PR inbox polls; a rate-limited answer backs the next poll off to five minutes |
| `MACHINE_SHIP_POLL_INTERVAL` | `60` | seconds between the ship monitor's polls of a shipped PR (merge readiness, review activity, CI, conflicts) |
| `MACHINE_SHIP_MAX_WAIT_DAYS` | `14` | days the monitor waits for a merge before a person is asked |
| `MACHINE_REPO_MAP` | unset | `owner/name=/abs/path` pairs: the checkout an imported issue's task works in. Without a match, the checkouts up to two folders under `MACHINE_REPOS_DIR` (`~/Developer/orc` and `~/Developer/projects/orc`) are matched by their `origin` remote. A folder you pick in the board's clone prompt that already is a checkout is linked instead of cloned, and the link is kept in `<state dir>/repo-links.json`, so a renamed remote needs no setting |
| `MACHINE_REPOS_DIR` | `~/Developer` | where `MACHINE_REPO_MAP`'s fallback scan looks |
| `MACHINE_THREAD_REPLIES` | on | set to `off` to stop the machine replying in the thread a task came from (a comment on its GitHub issue; a Slack thread when the pair below is set) when it is picked up, needs you, escalates, pauses, gets its PR and closes |
| `MACHINE_GRAPH_INTERVAL` | `600` | seconds between checks of each known repo's default branch; when it moved, the machine rebuilds that repo's code graph (Graphify, in the runner image) under `<MACHINE_STATE_DIR>/graphs/<repo>/<commit>/`, and builds one for a repo that has none. `off` stops the watch. Beside the graphs, `graphs/<repo>/misses.jsonl` records the files Build changed outside the code map (one JSON line per accepted scope check); a rebuild counts it into the stamp's `misses` |
| `MACHINE_DECISIONS` | on | set to `off` to stop the machine keeping a record of every decision pack call the pipeline makes (the context it judged, the validated answer, each question's verdict under the pack's own bars, the engine and model, the span's trace id) as `<MACHINE_STATE_DIR>/decisions/<pack>/<day>/<id>.json` (mode 0600). When a later fact settles what the right answer was (a flake re-run's result, the format a pack finally shipped with, your plan or retro decision, a resolved review thread) the machine writes it onto the record as `truth`. `pnpm eval harvest` turns records into eval cases; see [evals/README.md](../evals/README.md) and [runbooks/calibrate-decisions.md](runbooks/calibrate-decisions.md) |
| `MACHINE_DECISIONS_RETENTION_DAYS` | 90 | a decision record older than this is removed at start-up |
| `MACHINE_GROUND_TRUTH` | on | set to `off` to stop the machine keeping each approved plan, with what the proposal said and what was edited before approval (and who approved), as `<MACHINE_STATE_DIR>/ground-truth/plan/<taskId>-<approvalId>.json`; the files stay on your machine, never in a repo, and feed later evals |
| `MACHINE_SLACK_TOKEN` / `MACHINE_SLACK_CHANNEL` | unset | a bot token (`chat:write`) and a channel id: one Slack thread per task is opened there and every reply above lands in it. Both or neither |
| `MACHINE_SLACK_USER_TOKEN` | unset | your User OAuth Token (`xoxp-…`) from the internal app in `slack/manifest.json`: the inbox reads what you see and replies as you. Unset: the inbox is off and every Slack call says so |
| `MACHINE_SLACK_APP_TOKEN` | unset | the app-level token (`xapp-…`, `connections:write`) for Socket Mode: reactions and new messages arrive as they happen. Unset: the snapshot's `socket` is `off`; polling still covers everything but reactions |
| `MACHINE_SLACK_INBOX` | on | `off` stops the scheduled polls, Socket Mode and the digest; the `/slack/*` routes stay up with an empty snapshot, so the board's `S` view shows nothing until you press `R`, which still polls once on demand |
| `MACHINE_SLACK_INBOX_INTERVAL` | `60` | seconds between inbox polls; a rate-limited answer backs the next poll off to five minutes |
| `MACHINE_SLACK_MARK_READ` | off | `on` makes `d` (done) also move your read cursor in Slack (`conversations.mark`, needs the `channels:write`, `groups:write`, `im:write`, `mpim:write` user scopes) |
| `MACHINE_SLACK_RULES` | `MACHINE_STATE_DIR/slack-triage.md` | the triage rules file you edit (VIPs, muted channels, always-P0 keywords, quiet hours, the reply SLA, notes for the model). A missing file is written from the template, [`docs/agents/slack-triage.md`](./agents/slack-triage.md), which is only that: a template. A relative path is taken from the repo root. What the inbox learns from you goes to the machine-owned sibling `<rules>.learned.md`, so its writes never collide with your edits. Triage itself runs as the `slack_triage` pack in the stage container, with the same credential and Docker image as the stages; nothing else to set |
| `MACHINE_SLACK_DIGEST_AT` | unset | `HH:MM` local time: the machine DMs you a ten-line digest (open P0/P1, what waits on others, yesterday's response time) every day at that time |
| `MACHINE_JIRA_SITE` / `MACHINE_JIRA_EMAIL` / `MACHINE_JIRA_TOKEN` | unset | Jira Cloud: the site (`https://acme.atlassian.net`), your Atlassian account's email and an API token from [id.atlassian.com](https://id.atlassian.com/manage-profile/security/api-tokens) (basic auth, up to a year). All three or none. Set, tickets link to issues (a `PLAT-123` in a new ticket's text, `J` on the board, intake), the linked issue follows the task per the repo's `luna.yaml` `jira` block, and the `/jira/*` routes exist. Unset: every Jira call says so and repos with a `jira` block still run |
| `MACHINE_JIRA_TOKEN_EXPIRES` | unset | when the API token expires, as an ISO date (`2027-01-31`), copied from id.atlassian.com when you make it: Jira never tells the machine ahead of time, so this is what drives the once-a-day warning in the last two weeks and `tokenExpiresAt` in `GET /jira/status`. A 401 that names a date overrides it once the token has gone |
| `MACHINE_JIRA_CLOUD_ID` | unset | for a *scoped* API token only: calls go through `https://api.atlassian.com/ex/jira/<cloud id>` instead of the site (the site is still where issue urls point). Find the id at `https://<site>/_edge/tenant_info`. An unscoped token needs nothing here |
| `MACHINE_JIRA` | on | `off` turns everything Jira off even when the three variables are set |
| `MACHINE_SLA_GATE` | `2d` (was `1h` before wave 9) | how long a task may wait on you at a gate (plan, test check, answers, ship, memory review, escalated) before its clock turns red, where the repo's `luna.yaml` `sla.gate` says nothing. `30m`, `4h`, `3d` or `off`. A Jira priority of Highest or High halves it, Lowest doubles it |
| `MACHINE_SLA_CYCLE` | unset | created-to-closed target for every ticket, where the repo's `sla.cycle` says nothing; same durations |
| `RUNNER_IMAGE` | `hardness-runner:dev` | the stage container image |
| `RUNNER_QA_IMAGE` | `hardness-runner-qa:dev` | the QA stage image; without it e2e is skipped |
| `RUNNER_VIDEO_IMAGE` | `hardness-runner-video:dev` | the video image (narration, cards, compose, measure); without it Evidence's video format degrades to captures |
| `WORKTREES_DIR` | `~/Developer/worktrees` | where task worktrees are created, as `<worktreesDir>/<repo>/<branch>` |
| `MACHINE_STATE_DIR` | `~/.local/state/hardness` | where run artifacts, transcripts and ingested output live |
| `MACHINE_RETENTION_DAYS` | `90` | days to keep a closed task's events/stage-runs before pruning (`0` disables pruning); also how long a failed Slack triage or Jira intake run keeps its folder, and a `POST /runs` call its `pack_runs` row |
| `MACHINE_WORKTREE_RETENTION_DAYS` | `7` | days after a task closes before the nightly sweep removes its worktree and deletes its branch if merged (`0` disables). The same sweep removes run folders no stage run owns and untags superseded `hardness-runner*:<sha>` images |
| `MACHINE_RESTART_POLICY` | `requeue` | what happens to a task mid-stage when the machine stops: `requeue` parks it (its stage re-runs on the next boot, no approval), `escalate` leaves it for you to resume. A stage container still running when the machine comes back (a crash, not a shutdown) is re-attached instead: the machine waits on it and ingests its result (`stage.reattached`) |
| `MACHINE_TASK_BUDGET_USD` | unset, no ceiling | a task that has spent this much escalates before its next stage, with the amounts as the reason |
| `MACHINE_DISABLE_RUNTIMES` | unset, every runtime on | a comma list of runtimes to turn off, `eve` and/or `jev` (e.g. `eve`): every engine on them (`eve`: `codex:*` and `openai:*`; `jev`: `jev`) is unavailable as if its credential were missing. A task or `luna.yaml` asking for one runs the pack's default with a `stage.note` saying `… is disabled by MACHINE_DISABLE_RUNTIMES`, a usage limit never falls back to one, `GET /engines` shows it `available: false` with that reason, and `POST /runs` naming it answers 409 `runtime_disabled`. A decision pack the caller names no engine for (`triage_signals`) runs on its fallback, `claude:haiku`, when `jev` is disabled or has no key; with no engine able to run it, the error names each one tried. `claude` is refused at boot: every pack's default runs on it. Read at boot: a restart applies a change |
| `MACHINE_ENGINE_BUDGETS` | unset, no caps | monthly caps in USD per engine or credential, as `<key>=<usd>` pairs: `codex=0,openai=20,jev=5`. A key is an engine (`openai:sol`, `jev`) or a credential (`codex`, `openai`, `typesafe`), whose engines it counts together; an engine under both is held by whichever is reached first. The spend is this calendar month's (local time) recorded cost on that engine: stage runs, `POST /runs` calls and the Slack inbox's triage runs (Jira intake keeps no run record, so it is not counted). At the cap the engine is unavailable like a missing credential until the month turns: a task or `luna.yaml` asking for it runs the pack's default with a `stage.note` saying `… is over its monthly budget ($20.00 of $20.00 on openai)`, a usage limit never falls back to it, and `POST /runs` answers 409 `budget`. Runs on the Codex login (`codex:*`) record no cost, so a `codex` cap never trips; `codex=0` documents that Codex is not metered rather than turning it off (`MACHINE_DISABLE_RUNTIMES=eve` does that, for OpenAI too). A cap of 0 on a metered engine holds it once anything has been spent. Claude is refused at boot, as a key or an engine: every pack's default runs on it, so the day's and the repo's ceilings are its caps. Read at boot |
| `MACHINE_DAILY_BUDGET_USD` | unset, no ceiling | once the trailing 24 hours have cost this much, nothing new is claimed and running tasks park in the queue between stages, and `POST /runs` answers 429 `budget`; the spend counts stage runs and `POST /runs` calls (`pack_runs`); `/metrics` shows `budget.remainingTodayUsd` |
| `MACHINE_TRACES` | `metadata` with a Laminar key, else off | what each run reports to the local Laminar (below): `off` nothing; `metadata` one trace per stage run, `POST /runs` call and eval case, from the machine alone: a root span with the run row's facts (pack, engine, model, turns, cost, duration, outcome, fingerprint) and what happened on the way (the container starting, an engine fallback, a usage limit, an escalation) as events; the key stays on the host. `full` the same plus the transcript the host kept (its last 200k characters) on the root span, and the stage container is handed the key and the span, so under it come the container's own spans, every model turn and tool call with prompts and completions, through Laminar's Claude Agent SDK and AI SDK integrations (an eve agent's spans are their own traces, tied to the run by the eve session id). A project key reads every trace of the project, so `full` trusts the repos whose stages run: their tests and the agent's shell have the key. The machine's span never carries a client's context nor a pack's answer, with one exception: in `full` mode a decision the pipeline itself asked (`plan`, `verify`, `evidence`, `ship`, `build`) carries its context and answer as the span's input and output, so a trace can be sent to a labeling queue and a dataset from the Laminar UI; a `POST /runs` client's call never does. `metadata` or `full` without a key refuses to start |
| `LMNR_PROJECT_API_KEY` | unset, traces off | a project API key from your Laminar (project settings in the UI at `http://localhost:5667`); also read from `~/.config/hardness/lmnr-project-api-key`. In `full` mode each stage container receives it too, with Laminar's address and the machine's span for the run (`LMNR_SPAN_CONTEXT`), so its spans nest under the machine's; in `metadata` mode it never leaves the host |
| `LMNR_BASE_URL` | `http://localhost` (`http://lmnr-app` under compose) | Laminar's scheme and host as the machine reaches it, no port |
| `LMNR_STAGE_BASE_URL` | `http://host.docker.internal` | Laminar as a stage container reaches it: the host's gateway, where compose publishes Laminar's ports on localhost (Docker Desktop resolves the name and forwards to the host's localhost; on Linux the sandbox adds `--add-host host.docker.internal:host-gateway`, which cannot reach a port bound to 127.0.0.1: publish Laminar's 8000 and 8001 on the bridge address, or name another host here). Used only in `full` mode |
| `LMNR_HTTP_PORT` / `LMNR_GRPC_PORT` | `8000` / `8001` | Laminar's REST (evaluations) and gRPC (spans) ports, the same from the host and from a container |

Every ceiling (a task's, a repo's month's from its `PIPELINE.md`, the day's, and each engine cap of `MACHINE_ENGINE_BUDGETS` or a repo's `budget.engines`) raises a `budget.alert` on `/events` the first time a run takes the spend past 80, 90 and 100% of it; an engine cap's alert has `scope: "engine"` and names the cap's `engine` (and its `repo` for a luna.yaml cap; `taskId` is null when a `POST /runs` call crossed it). The board shows each as a notice. Nothing runs while a task waits on you, so idle time costs nothing: a stage container lives only for its stage.

## Per-repo config: `luna.yaml`

Everything the machine needs to run one repo lives in a `luna.yaml` at that repo's root: how to check it, what runs beside it, and how the pipeline should behave. The board's `:setup <repo>` command has an agent read the repo and propose the file, proves every proposed check once and writes the file after you approve it; you can also write it by hand. The machine reads it from the checkout (not the task worktree) at every stage, so an edit takes effect without a restart and an uncommitted file already counts; a version that does not parse is reported once and the last good one stays in force.

```yaml
checks:                                   # the repo's own checks; without this key they are detected from the tree
  - name: board tests
    run: cargo test                       # a shell line, run in cwd (default: the worktree root)
    cwd: board
    paths: ["board/**"]                   # only for a change touching one of these; no paths means always
  - name: machine tests
    run: pnpm test
    cwd: machine
    paths: ["machine/**", "contracts/**"]
    coverage: coverage/lcov.info          # an lcov report the run writes, relative to cwd; Verify measures the change's added lines against it
services:                                 # run beside every stage and check container, reachable by key as hostname
  postgres:
    image: postgres:16
    env: { POSTGRES_USER: app, POSTGRES_PASSWORD: app, POSTGRES_DB: app }
    ready: pg_isready -U app              # run inside the service until it exits 0
    exports: { DATABASE_URL: "postgres://app:app@postgres:5432/app" }   # env the repo's code gets
toolchains: { node: "24", rust: "1.99" }  # what the repo builds with; recorded by setup
policy:
  qa: web                                 # web (default) runs e2e when the change renders; none never does
  monthly_budget_usd: 40                  # this repo's tasks park once the calendar month has cost this much
  auto_approve_plan_minutes: 15           # a plan whose risk is low and whose checks (coverage, plan, risk) all proceeded is approved by itself after this long
  max_concurrent: 1                       # running tasks this repo may hold at once (over MACHINE_MAX_PER_REPO)
  holdout_cases: false                    # true keeps test_design's cases away from the implementer; verifying still judges by them
  graph: on                               # off keeps the machine from building a code graph of this repo (default on; see MACHINE_GRAPH_INTERVAL)
  auto_merge: off                         # what the machine may merge by itself once a shipped PR is ready: off (default: never), low, or medium (low and medium); a high-risk PR is merged only when this is not off and a ship approver, who is none of the plan's approvers, approved the preview
  decisions:                              # per decision pack, per question: when an answer is acted on (proceed) and when a person decides (below flag)
    triage_signals:                       # also risk_score, coverage_check, plan_check, red_check, scope_check, finding_classify, e2e_failure_cause, evidence_format, event_class, comment_intent, fix_scope, evidence_valid and worth_learning; a question left out keeps the pack's bar
      kind: { proceed: 0.8, flag: 0.5 }
      archive: { proceed: 0.95 }          # archiving by machine wants a higher bar than labelling (the pack's own: 0.9 / 0.7)
freeze:                                   # windows in which the machine merges nothing, whatever auto_merge says
  - { from: "2026-12-20", to: "2027-01-03", reason: "holiday freeze" }
qa_targets:                               # where e2e may drive the app; the credential is a reference, never a value
  - { name: staging, url: https://stg.example.com, credential: env:QA_PASSWORD, reentrant: false }   # reentrant: false = never drive it twice; the video recording is skipped there (default true)
jira:                                     # how this repo's tasks talk to Jira (needs MACHINE_JIRA_SITE/EMAIL/TOKEN)
  project: PLAT                           # where `J` creates issues; also the default for intake
  intake:
    jql: 'project = PLAT AND labels = luna AND status = Ready'
    every: 5m                             # the poll; each new issue goes through the jira_intake pack first
  on:                                     # task state → Jira status name, resolved to a transition when the task enters it
    triage:        In Refinement
    implementing:  In Progress
    awaiting_ship: In Review
    closed:        Done
    escalated:     Blocked                # optional; states left out are never touched
  comments: milestones                    # none | milestones (picked up, PR opened, closed) | gates (every "needs you" too)
  branch: "{type}/{key}"                  # a linked task's branch; {type} is the issue type lowercased: bug/PLAT-123, story/PLAT-124
  fields:                                 # optional: Jira fields set with the transition into a state
    awaiting_ship:
      customfield_10045: "{pr_url}"       # also {task_id}, {branch}, {board_url}
sla:                                      # ticket clocks; the machine's env defaults apply where a key is missing
  gate: 2d                                # any gate waiting on you (MACHINE_SLA_GATE; the setup and questions gates also follow `triage.sla.reminder_days`)
  stage:                                  # per running stage; yellow from 80%, red past it; the stage is not aborted
    implementing: 4h
    verifying: 1h
  cycle: 3d                               # created → closed (MACHINE_SLA_CYCLE)
  archive: 5d                             # auto-archive a ticket left at Intake or Triage (setup, questions) this long (reason `no_setup` or `no_answer`); five days when this key is missing, `off` keeps it waiting; an answer restarts the clock, and a card is never archived before a reminder at least a day old, so `gate: off` keeps it waiting too. A gate past its clock gets one reminder per visit (a `sla.reminder` event, a Jira comment with `comments: gates`, a line in the task's thread)
engines:                                  # the engine a pack runs on in this repo, over its default
  triage: claude:opus                     # must be one of the pack's engines.allowed (GET /packs)
budget:
  engines: { openai:sol: 10, codex: 0 }   # monthly caps in USD on this repo's stage runs, by engine or credential (never Claude)
evidence:
  retention_days: 30                     # how long the machine keeps this repo's local Evidence Pack copies (<state>/evidence/<task>/<sha>/); 0 keeps them for good, absent uses MACHINE_RETENTION_DAYS
                                         # at Ship the pack's media (screenshots, the recording, the QA manifest; never the HAR) go to a draft pre-release named luna-evidence (no tag, no release event, visible to collaborators) when the machine has a GitHub token; the PR body gets a marked section and the token's own comment carries the pack
```

Every key is optional and unknown keys are ignored. Under `jira.on`, `jira.fields` and `sla.stage` the keys must be task states (`sla.stage`: running ones); an unknown one is dropped with one warning per version of the file, the rest applies. Durations are `30m`, `4h`, `3d` or `off`. `jira.on` works by status *name*, matched without regard to case against the transitions Jira offers from the issue's current status: already there, nothing happens; no transition leads there, the task gets a `jira.blocked` event (with Jira's own words when it refused), the board shows it, and the pipeline goes on. Comments and created issues are posted as Atlassian Document Format built from markdown (paragraphs, `#` headings, `- ` bullets, `- [ ]`/`- [x]` task lists, `1.` ordered lists, `**bold**`, `` `code` ``, bare urls as links), so a ticket's criteria arrive as checkboxes. `branch` also takes `{slug}`, `{route}` and `{id}`, and must contain `{key}` or `{id}` (a pattern without either is dropped with a warning and the default used, so two tasks never share a branch and no render is ever `main`); when the repo already has the branch the pattern names (an older task on the same issue), `-<id8>` is appended for patterns without `{id}` or `{slug}`. Once a task works on its branch that branch stays, whatever the issue's type becomes, and its link cannot be changed or removed until it closes. An unknown issue type renders `{type}` as `task`; unlinked tasks keep `task/<id>-<slug>`; a writable stage never runs on `main`, `master`, `develop` or the repo's default branch. `auto_approve_plan_minutes` needs triage to report `confidence: high` and `risk: low` and to have asked nothing; anything less waits for you as always, a Luna Notch task (`source.kind: notch`) always waits (the notch approves its own plans), and the approval it does make is logged as `plan.auto_approved` with the reason on the approval.

`engines` maps a pack to the engine it runs on in this repo. An engine outside the pack's `engines.allowed` makes the file invalid, reported like any other bad value (the last good version stays in force; a setup proposal with one fails the stage, like any proposal the machine cannot read). A task's own choice (`stages` on `POST /tasks`, `PATCH /tasks/:id/stages`) wins over the file, and the file over the pack's default. A pack's engine is read when its stage starts, so an edit counts from the next stage on; a stage already running keeps its engine, also across a restart.

`budget.engines` caps an engine in this repo the way `MACHINE_ENGINE_BUDGETS` caps it on the machine, with the same keys and rules, counting only this repo's stage runs this month; a key that names no engine or credential, or names Claude, makes the file invalid. At the cap the repo's tasks run that pack's default with a note, and the machine's caps still apply on top.

A check with `coverage` names an lcov report its run writes (vitest, jest, pytest-cov, cargo-llvm-cov and go via gcov2lcov all emit one), relative to the check's `cwd`. After the check passes, Verify reads it and measures *patch coverage*: of the lines the branch added, how many the report saw run. A file with uncovered added lines becomes a `test` finding (confidence 0.9) that the verifier weighs and never fails the stage by itself; the numbers are in the stage's `detail.coverage` and in the verifier's input. A missing or unreadable report is noted and never fails the stage; a path that climbs out of the worktree is ignored.

Each `services` entry runs as its own container beside every stage that runs the repo's code (implementing, verifying, e2e) and every check run, on a private docker network for that run, reachable by its key as hostname; the `exports` become env in the stage or check container. They are torn down with it, so two tasks of one repo never share a database. A service whose `ready` line does not exit 0 within a minute escalates the stage with the service's log tail.

`PIPELINE.md` (the earlier per-repo file, front matter with the `policy` keys and `qa_target` lines) still works when there is no `luna.yaml`, with a deprecation notice once per repo; `luna.yaml` wins when both exist.

### The v2.2 diagram's sections

`luna.yaml` also takes the sections of the v2.2 flow diagram (RFC 0006). Each has the default shown; a key you write is merged over it into `Policy.factory`. A wrong type, a number out of range or an unknown key inside one of these sections makes the file invalid, naming the key (the `evidence` section keeps ignoring unknown keys, as it always did). The last column is the wave that reads the key: `8` and `9` mean it already changes behaviour; every other key is defined now and does nothing until that wave, so setting it has no effect yet. The existing keys keep their meaning and win when both forms are set: `policy.auto_merge`, `freeze`, `evidence.retention_days` and the top-level `sla`.

| Section | Keys and defaults | Read from wave |
|---|---|---|
| `dedup` | `duplicate: 0.90`, `related: 0.70`, `ask_below: 0.7`, `lookback_days: 90` | 14 |
| `triage` | `confidence {kind 0.80, size 0.60, urgency 0.70, risk 0.85, archive 0.90}`, `flag_band: 0.15`, `hint_weight: 0.5`, `max_questions: 3`, `max_rounds: 2`, `sla {reminder_days 2, archive_days 5}` | 9 |
| `graph` | `stale_commits: 50` | 9 |
| `scoring` | `weights {who 3, what 3, impact 2, time 2, demand 1}`, `bands {P0 28, P1 22, P2 16}` | 9 |
| `fast_lane` | `max_risk: low`, `max_size: S`, `excluded_types: [infra, data]`, `cross_team: false` | 9 |
| `plan` | `coverage_score_min: 0.85`, `coverage_rounds: 3`, `plan_check_retries: 2`, `approvers {low 1, medium 1, high 2, outside_owning_team true}`, `sla {reminder_days 2, escalate_days 5}` | `coverage_rounds` and `plan_check_retries` 8, the rest 9 |
| `size` | `target_loc: [1000, 2000]`, `hard_limit_loc: 2500`, `max_children: 8`, `max_rounds: 3`, `depth: 2` | 15 |
| `build` | `max_iterations: 15`, `max_tokens: 2000000`, `max_minutes: 90`, `backoff_minutes: [1, 30]`, `regression_full_suite_minutes: 10` | 10 |
| `sandbox` | `cpu: 4`, `memory_gb: 8`, `egress: [registries, github]` | 11 |
| `verify` | `coverage_drop_max: 0.5`, `mutation {command null, min_score 0.6}`, `build_rounds: 1`, `env_flake_retries: 1`, `ci_flaky_reruns: 1`, `auto_rebase: 1`, `e2e {deploy {command null}, start {command null}}` | `env_flake_retries`, `ci_flaky_reruns` and `auto_rebase` 8, the rest 12 |
| `evidence` | `video_budget_s: 240`, `regenerate: 1`, `tts {voice null, language null}`, `storage: release_asset`, `retention_days: 180` | `retention_days` keeps its meaning (a repo's value, else `MACHINE_RETENTION_DAYS`); the rest 12 |
| `ship` | `preview: off`, `auto_merge: medium_when_review_required`, `merge {method squash, queue true, delete_branch true, commit_template null}`, `release_owners: []`, `stale_days: 14`, `sla {reminder_days 2, escalate_days 5}`, `poll_minutes: 5` | `stale_days` 8, the rest 13 |

Wave 8 reads `plan.coverage_rounds` (the test designer's rounds), `plan.plan_check_retries` (the planner's re-runs after a plan check), `verify.env_flake_retries` (browser re-runs on an environment flake), `verify.ci_flaky_reruns` and `verify.auto_rebase` (the ship monitor's CI re-runs and rebases) and `ship.stale_days` (how old a PR head may be before it blocks a merge). `evidence.video_budget_s` stays 240 in the film prompts and is wired in wave 12. `ship.auto_merge` is not read: today's `policy.auto_merge` (default `off`) decides what the machine merges. `verify.mutation.command`, `verify.e2e.deploy.command`, `verify.e2e.start.command` and `ship.merge.commit_template` are stored as written and are never run or rendered by this wave.

## GitHub gates

`pnpm --filter @hardness/machine gates owner/name [--checks board,machine] [--dry-run]` applies a repository ruleset named `hardness gates` to the default branch: one approving review from someone other than the last pusher, reviews dismissed when the branch moves, no deletion, no force-push, and the named checks green. GitHub enforces it whatever an agent does; the pipeline cannot approve its own PR. The machine's side of the same gate: a writable stage refuses any branch outside `task/`.

## Environment cache

Every stage and check container mounts a docker volume named `hardness-cache-<repo>` at `/cache`, with npm, pnpm, yarn, Go, cargo, pip and uv pointed at it. A retry, or the next task of the same repo, installs from that warm cache instead of the network. `docker volume rm hardness-cache-<repo>` starts a repo over.

## Compose

`docker compose up` (and `pnpm start`) runs the machine in a container that drives your host's Docker through its socket. Every path the machine hands to `docker run` must exist at the same path on the host, so the compose file mounts these at identical paths:

| Variable | Default | What it does |
|---|---|---|
| `MACHINE_DOCKER_PORT` | `4318` | host port for the machine container (`pnpm dev` keeps `4317`) |
| `LUNA_CHECK_WAIT_MS` | `90000` (`0` on a dry run) | how long the implementer waits in a stage container for the machine's `red_check` or `scope_check` answer (files under `/out/checks/`) before going on as `skipped` |
| `LUNA_REPOS_DIR` | `~/Developer` | where your repos live; task repo paths must be inside it, and so must `WORKTREES_DIR` |
| `MACHINE_STATE_DIR` | `~/.local/state/hardness` | run folders, mounted into stage containers |
| `GITHUB_TOKEN` / `GH_TOKEN` | unset (`pnpm start` passes `gh auth token` as `GH_TOKEN`) | the token every GitHub API call uses (PRs, checks, reviews, the PR inbox); `GITHUB_TOKEN` wins when both are set. In the container it also lets `git push` reach GitHub over https; `git@github.com:` and `ssh://` remotes are rewritten to https there |
| `LUNA_GIT_NAME`, `LUNA_GIT_EMAIL` | your `git config` (via `pnpm start`) | identity for commits the machine makes itself (the approved memory rules) |
| `LMNR_*`, `MACHINE_TRACES` | unset | passed through to the machine container; `LMNR_BASE_URL` defaults to `http://lmnr-app` there. The `observe` profile's own secrets (`LMNR_POSTGRES_*`, `LMNR_CLICKHOUSE_*`, `LMNR_SHARED_SECRET_TOKEN`, `LMNR_AEAD_SECRET_KEY`, `LMNR_NEXTAUTH_SECRET`, `LMNR_FRONTEND_PORT`) have local defaults in `compose.yaml`; `make integrations` writes random ones into `.env`, which is what anything beyond one person's laptop should use |

`~/.config/hardness` is mounted read-only for the Claude credential and the API token: the container binds `0.0.0.0`, so the machine there asks every call for `machine-api-token`, which `pnpm start` writes once (`openssl rand -hex 32`, mode 0600) and the board reads. The other variables in the table above pass through to the container as well.

Your Codex home (`$CODEX_HOME`, else `~/.codex`) is mounted read-write at `/root/.codex-host`, with `CODEX_HOME` pointing there, for the `codex:*` engines: the machine copies `auth.json` into each run's folder and writes a refreshed token back, keeping the file's owner, so a stage container never sees the folder. Without a `codex login` on the host the folder is empty and `codex:*` picks run on the pack's default, with a line on the task saying so. The other variables in the table above pass through to the container as well.

## Observability (Laminar)

Luna keeps every run's facts in Postgres (`stage_runs`, `pack_runs`) and the transcripts on disk; Laminar ([laminar.sh](https://laminar.sh), Apache 2.0, self-hosted) gives them a UI: one trace per stage run, `POST /runs` call and eval case, a session per task, cost over time, and the replay evals as evaluations you can compare across engines. It is opt-in and local:

1. `docker compose --profile observe up -d` starts Laminar's lightweight stack beside the machine (its own Postgres, ClickHouse and Quickwit, bound to localhost; about 2 GB of images and a couple of GB of RAM while up). The UI is `http://localhost:5667`; anyone on this computer can sign in.
2. Create a project in the UI and copy its API key into `~/.config/hardness/lmnr-project-api-key` (`umask 077`), or set `LMNR_PROJECT_API_KEY`. `make integrations` does this for you.
3. Restart the machine (`pnpm start` or `pnpm dev`). It logs `traces metadata · Laminar at …`. `MACHINE_TRACES=full` also attaches transcripts.

The machine opens one root span per run (`application/telemetry.ts` is the port, `adapters/laminar/` the adapter, the machine's only importer of `@lmnr-ai/lmnr`, loaded only when a key is set). In `full` mode it also hands the stage container the key, Laminar's address and that span, serialized, as `LMNR_SPAN_CONTEXT`. Inside, the factory (`factory/src/core/telemetry.ts`) initializes Laminar from them and plugs in Laminar's integrations, so the model calls are children of the machine's span: the Claude Agent SDK's `query()` wrapped (every turn, tool call and subagent, with prompts, completions, tokens and cost), the AI SDK's telemetry registered before Jev's `experimental_decide`, and each built eve agent exporting through `LaminarSpanProcessor` (those spans are their own traces, joined to the run by the eve session id the run's `session` event names). The machine closes the root span after the container exits, with the run row's facts and, in `full`, the transcript. A Laminar that is down at boot leaves the machine running without traces, said once in the log; a span that cannot be sent is dropped with a warning; a container that cannot load the SDK runs untraced and says so on its transcript. The SDK runs dotenv on its working directory when it loads; the factory removes whatever that added, so a `.env` committed to a repo cannot change a run's environment. `pnpm eval` reports to the same Laminar from the same variables (see [evals/README.md](../evals/README.md)). Laminar's own AI features (chat with a trace, SQL with AI, Signals) need a provider key in its containers and are left off here; the `eval_judge` pack is the judge. Direct Anthropic or OpenAI SDK instrumentation does not apply: the factory never imports those SDKs.

## Runner image

The image carries Node 24, `gh`, Go, Python with a pinned Graphify (`GRAPHIFY_VERSION`; its headless code-only graph build is `/graph-tools/build.py`, run as an entrypoint override, and a stage reads the repo's graph read-only at `/graph`) and a pinned Rust toolchain (`RUST_VERSION` in `machine/runner/Dockerfile`, with clippy and rustfmt), so a repo whose suite is `cargo test` runs as is; the Codex CLI (`CODEX_VERSION`, pinned), which eve's `chatgpt()` asks for the login's token; and the factory with its three SDKs installed, plus an eve agent built for each pack that allows an eve engine (`triage`, `slack_triage`, `chat_triage`) and one generic `decide` app for the decision packs and for each helper on one (`verifying--second-opinion`). Every check container also gets your git identity, the `user.name` and `user.email` git resolves for the repo, so a suite that commits in a scratch repo runs as you; a repo with no identity escalates the verifying stage instead of committing as nobody.

`pnpm --filter @hardness/machine runner:build` runs `machine/runner/build.sh`, which builds the image from this checkout with the repository root as the build context: `factory/` and `contracts/` are copied in and installed with the workspace lockfile, so the image runs exactly what the checkout tests. Each image is labelled with a key over those files and the Dockerfile and skipped when that key is current, so `pnpm images` (run by `pnpm start` and `pnpm dev`) is instant when nothing changed; `REBUILD=1 pnpm images` builds anyway. The image is tagged `hardness-runner:dev` and `hardness-runner:<key>`. `runner-qa:build` runs the same script with `--qa`, then builds `hardness-runner-qa:dev` from `machine/runner-qa/Dockerfile` on top of it. `runner-video:build` runs it with `--video`, which builds the QA image first and then `hardness-runner-video:dev` from `machine/runner-video/Dockerfile` (repository root as the context); `pnpm images` builds all three.

The video image adds, on top of the QA image, the tools in `/video-tools`: `narrate.ts` (kokoro-js for the voice and whisper-tiny.en through transformers.js for word timestamps, both baked into `/models` at build and read offline), `cards.ts` (a time-driven card page rendered frame by frame through the QA image's chromium), `compose.ts` (ffmpeg cuts, narration, captions, chapters), `measure.ts` (frame statistics, loudness, contact sheets, a transcript) and `fixture.ts` (the demo fixture the recorder imports). The logic is in pure libraries beside them that the machine's test suite covers. Each tool reads and writes only under its job dir `/work`, and the machine runs it with no network and no credential. `pnpm --filter @hardness/machine runner-video:smoke` builds a 20-second synthetic job and runs all four tools inside the image. Size: measured at build, the video image is 6.55 GB on disk (1.79 GB compressed) against the QA image's 5.56 GB (1.49 GB), so about 1 GB more, of which the two models are 235 MB and the npm packages (onnxruntime among them) most of the rest.

Inside a stage container the runner sees `/in/stage.json`, `/out`, `/work` (the worktree) and `/session` (the task's SDK session dir, `CLAUDE_CONFIG_DIR`). `LUNA_FACTORY=1` marks the run; `LUNA_STAGE_DRY_RUN=1` renders the prompt and the SDK options without a model call (the sandbox smoke uses it); on an eve engine it prints the agent, model, tools and guard policy instead, and for a decision pack the questions and the state it would send to Jev. A repo may keep binding rules for every stage in `docs/agents/project-context.md`; the memory review proposes additions to it.

## Board

The board uses whichever machine answers: `http://127.0.0.1:4317` (`pnpm dev`) first, then `http://127.0.0.1:4318` (`pnpm start`), checked again on every reconnect. `HARDNESS_MACHINE_URL` pins one address instead. When `MACHINE_API_TOKEN` or `~/.config/hardness/machine-api-token` holds a token, the board sends it on every call. `HARDNESS_REPOS_DIR` is where the board's repo search (`R`) looks for repos (default `~/Developer`). `LUNA_APPROVER` names you on every approval and send-back the board makes (unset: no name is sent); a plan of High risk needs two distinct names, so without it the machine answers `approver_required`. The name is an attestation, not access control: the machine has one bearer token and no per-person identity, so the two-approver rule records who said they approved; it cannot stop one token holder from naming two people.
