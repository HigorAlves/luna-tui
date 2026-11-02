# RFC 0004 — luna-tui as the harness for Luna Notch

- **Author:** Higor Alves
- **Status:** Accepted (2026-11-02)
- **Created:** 2026-11-02
- **Discussion:** (open a PR with this file)
- **Related:** [RFC 0002](./0002-native-agent-runtimes.md) (the runtimes), [RFC 0003](./0003-upgradable-harness.md) (catalog, evals, rollout)

## Summary

Luna Notch (the macOS app) already has the product side: one board on the same eight stages as this machine, an Inbox, Slack, Microsoft Teams, Jira, GitHub, Vercel, an engine menu and approvals. This repository has what the notch lacks: the stage pipeline, packs, containers, guards and gates, and soon several engines and evals. This RFC reshapes the machine into the notch's harness. The notch owns the ticket; the machine owns the run. A notch ticket handed to "Luna Machine" runs every stage on the machine until Done, its card following the machine's stage on the notch's board. The notch keeps working alone when the machine is off. Once the two are tested together, the machine's own Slack, Jira and PR-inbox loops and their TUI views are retired, and the TUI becomes the operator's console.

## Goals

- From the notch, one Start runs a ticket on the machine until Done, stopping only at the person's gates.
- The notch's card moves through its stages as the machine's task does, with no sync through Jira or anything else.
- The engine is chosen per stage from either board.
- The notch can call one pack on data it already read (a Slack thread, a Teams post, a Jira issue) and get a typed answer.
- Retrying, sleeping and reconnecting never duplicate a task or lose an event.
- The notch works exactly as today with the machine off.

## Non-goals

- Retiring anything before the two have been tested together end to end. Until then the TUI and its integrations work as today.
- Merging the two boards' data. Each keeps its own store; the machine keeps a task per run, the notch a ticket.
- A remote, multi-user machine. It stays on `127.0.0.1` unless the token below is set.
- Running the notch's personal AI (Sessions, the island's chat, Write with Luna) on the machine.

## Background / Context

| | Luna Notch | This machine |
|---|---|---|
| Board | Eight fixed stages (`BoardStage`), projects, the Inbox | The same eight columns (`COLUMNS`), tasks in Postgres |
| Agents | One CLI session per ticket from a recipe (`luna-harness.json`), five engine choices | One pack per stage in a container, guards, ledger |
| Gates | Approve (into Approved), Looks right (into Ship), the Inbox | `awaiting_*` states answered through `/decision` and `/answers` |
| Integrations | Slack, Teams, Jira, GitHub, Vercel | Slack inbox, Jira sync and intake, PR inbox, GitHub issue intake |

The notch's Jira and Slack code is a Swift port of the machine's (`machine/src/adapters/jira/`, `adapters/slack/`, `application/slack-inbox.ts`). Running both on the same ticket would move and comment its Jira issue twice.

## Proposed design

### Who owns what

| Luna Notch | The machine |
|---|---|
| The ticket: title, description, acceptance, subtasks, labels, priority | Its own task, created from the work order at Start |
| Stages on its board, the timebox, projects, the Inbox | Stages, gates, engines, the slice ledger |
| Jira, Slack, Teams, Vercel | Worktree, branch, commits, the pull request, CI watch |
| Runs on the ticket (`BoardRun`), each holding the machine task's id and event cursor | Run records, cost, evals, metrics |

Rule: whoever created the ticket talks to the outside world about it. For a task whose `source.kind` is `notch`, the machine never calls Jira, Slack or Teams. GitHub is shared: the machine pushes and opens the PR for a task it builds; merge and close come from the client that was clicked.

### The work order

```http
POST /tasks
Idempotency-Key: <ticket uuid>:<run number>

{
  "title": "…", "description": "…", "criteria": ["…"], "repoPath": "/abs/path",
  "source": { "kind": "notch", "ref": "LUNA-14", "id": "<ticket uuid>", "jiraKey": "PLAT-123" },
  "stages": { "triage": "codex:sol" },
  "start": true
}
```

- The same key answers the same task (200) instead of making another; a different body under the same key is a 409.
- `jiraKey` only names the branch through the repo's pattern; the issue is never read or written.
- One machine task per Start: a ticket run again after Done gets a new run number and a new task.
- Text edits flow one way, `PATCH /tasks/:id`, while the task is not built yet. The machine never edits the notch's ticket.

### Events back

Every event the machine publishes gets a monotonically increasing `seq`, stored with it. `GET /events?since=<seq>&source=notch` replays what was missed, then streams live. The notch stores the last `seq` it handled on the run, so a closed lid or a restart loses nothing. `task.updated` carries the column, the state, the stage's summary, the pending gate's content and the PR.

### Board runs on Luna Machine

A switch in the notch's Settings → Harnesses → Defaults, offered while the machine answers `/health`. With it on:

| Goes to the machine | Stays on the notch |
|---|---|
| Start on any ticket: every stage until Done | Sessions in Luna's window |
| Create and triage, Import and triage: the triage stage | The island's chat, Ask Luna, Write with Luna, speech |
| A PR ticket in Verify: its job becomes `review`, `ci_fix` or `address` | Plan my day and the timebox (they read the calendar) |
| Labels and estimate (`issue_classify`), criteria (triage) | Everything, when the switch is off or the machine is down |
| Jira's Summarize comments; later Slack and Teams triage | |

A project can opt out. A machine that stops answering mid-run marks the card "Luna Machine unreachable"; the Inbox's Failed tab offers "Run on this Mac instead". Nothing falls back on its own.

### The card follows the machine

| Machine state | Notch stage | The person's click |
|---|---|---|
| `triage`, `awaiting_answers` | Triage | Answer → `POST /tasks/:id/answers` |
| `awaiting_approval` | Triage, in the Inbox's Approve | Approve → `POST /tasks/:id/decision` |
| `test_design`, `awaiting_test_check` | Approved | Approve the cases → `/decision` |
| `implementing`, `paused_rate_limit`, `escalated` | Build | an escalation is in Failed: Send back or Retry |
| `verifying`, `e2e`, `delivering`, `ci_watch` | Verify | none |
| `evidence`, `awaiting_ship` | Evidence, in the Inbox's Approve | Looks right → `/decision` |
| `shipping`, `reviewing_memory` | Ship | the memory rules: apply or skip |
| `closed`, or the PR merged | Done | none |

Two notch rules change for Luna Machine tickets only: the card moves forward by itself to the machine's stage (never backwards, never into Approved without Approve, never into Ship without Looks right), and one Start runs past the stage it was pressed in. Plan auto-approval stays the notch's (`AutoApproval` calls `/decision`); the machine's timer approval is off for notch tasks. Both boards see the same gate; the first answer wins and the other client gets a 409.

### The Luna Machine recipe

```json
{
  "schema": 2,
  "name": "Luna Machine",
  "agent": "luna-machine",
  "server": "http://127.0.0.1:4317",
  "stages": { "triage": "codex:sol", "verifying": "claude:opus" },
  "doneWhen": "prMerged"
}
```

Phases come from `GET /packs`, so a stage added here shows up in the notch without a notch release.

### API additions

| Route | Does |
|---|---|
| `GET /packs` | Each pack: id, stage, kind, engines `{default, allowed}`, description |
| `GET /engines` | Each engine: runtime, model, whether a credential is present, spend this month |
| `POST /tasks` | The work order above: `Idempotency-Key`, `stages`, `source.kind: notch`, `start` |
| `PATCH /tasks/:id/stages` | Change a stage's engine before that stage starts |
| `GET /events?since=&source=` | Replay from a sequence number, then live |
| `POST /runs` | One context-only pack on data the client sends: `{pack, engine?, context}` → `{answer, usage}` |
| `MACHINE_API_TOKEN` | Optional bearer token, required when the machine binds beyond loopback |

### The TUI

The TUI becomes the operator's console: the queue, slots, drain and resume, running stages and their logs, metrics and cost by engine, the per-stage engine picker, and gates when you are in the terminal. Notch tasks show tagged "from Luna Notch".

### Migration / rollout

1. **Machine API** (luna-tui): `GET /packs`, `GET /engines`, stage engines on a task, the work order with idempotency, event `seq` and replay, Jira/Slack skipped for notch tasks, the TUI's picker.
2. **The notch connects** (luna-notch): `Services/Machine/` (`MachineClient` HTTP and SSE, `MachineModels` tested on recorded fixtures), the address, token and status in Settings → Harnesses; machine tasks shown read-only.
3. **Luna Machine harness**: the recipe, Start through the work order, the card mapping, gates in the Inbox, catch-up after sleep.
4. **Engine per stage in the notch**: the stage table with `HarnessEngineMenu`, a per-ticket override.
5. **Packs on demand**: `POST /runs`, `slack_triage` → `chat_triage` for Slack and Teams, `issue_classify` and `jira_intake` for the notch's Jira intake.
6. **Tested together**: the person runs real tickets from the notch until Done.
7. **Retire** (only after 6, each its own PR): the machine's Slack inbox and thread-per-task, Jira sync, intake and watch, the PR inbox poller and GitHub issue intake, and the TUI's Slack, inbox and PR views. Packs (`jira_intake`, `chat_triage`) stay.

## Alternatives considered

### Sync the two boards through Jira

Both already talk to Jira. Rejected: every move and comment would happen twice, and a ticket with no Jira issue could not be shared at all.

### Make the notch the harness and the TUI its client

Rejected: the pipeline, containers, packs and evals are here, in TypeScript beside the Agent SDK; rebuilding them in Swift would duplicate the hardest part.

### Keep two separate products

Rejected: the integrations are already duplicated and would keep drifting.

## Open questions

- Plan my day and the timebox: keep them on Apple's on-device model, or send them to the machine too?
- Packs on demand keep the message text in the machine's run record; acceptable, or should `POST /runs` keep only the answer?
- Does the machine ever need to be reached from another host?

## Risks & unknowns

- **Two clients, one gate.** The first answer wins; the loser must refresh on 409 rather than show an error.
- **Lid closed mid-gate.** The event replay must be durable before the notch relies on it; until then the notch also refreshes the task on wake.
- **App Store build.** Start and harnesses are direct-build only today; a network-only harness may fit the App Store build with the network-client entitlement, which needs checking against App Review.

## Success criteria

- A ticket started from the notch reaches Done on the machine, its card passing Triage, Approved, Build, Verify, Evidence and Ship on the notch's board, with only Approve and Looks right clicked.
- Pressing Start twice, or closing the lid mid-run, leaves one task and a card in the right stage.
- No Jira call from the machine for a notch task.
- With the machine off, the notch behaves exactly as before.
