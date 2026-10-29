# API

The machine's HTTP API, read straight from `machine/src/adapters/http/app.ts`. Shapes are defined in `contracts/src/api.ts`.

| Method | Path | Does |
|---|---|---|
| GET | `/health` | Liveness check; also the stage pool: `slots {max, active, draining}`. |
| POST | `/drain` | Take no new work: running stages finish, the queue waits. Answers with the pool. |
| POST | `/resume` | Carry on: the queue is picked up again at once. |
| PATCH | `/slots` | `{max}`: resize the pool at run time (at least 1). |
| GET | `/metrics` | Factory metrics over a window: `?since=7d\|30d\|<ISO timestamp>` (default `7d`). Cycle time, first-pass rate, escalations, cost, queue depth, and `gates` (`answered`: gates you answered in the window, `withinSla`: the share answered inside the gate SLA, `waitMs`: median and p90 wait per gate state); also streamed as `task.metrics`. `&repo=<path>` limits the numbers to one checkout (`repo=` to the tasks with none); `&groupBy=repo` adds `byRepo`, one slim row per checkout (tasks, escalation rate, first-pass verifying, cost). |
| GET | `/tasks` | List every task with its state, column and `route` (`feature`, `setup`, or a PR task's `ci_fix`, `review` or `address`). Each task carries `jira` (the linked issue as last seen: `key`, `url`, `issueType`, `status`, `priority`, `dueAt`, `syncedAt`, `blocked` with `{wanted, current, why, at}` when the last declared transition was refused, `linkedAt` when the link was made by hand (null for one made with the ticket), `timeZone` the Jira site's zone once JiraWatch has read it; null when unlinked) and `sla` (the ticket's clocks, computed at answer time from the row's `state_since` and the running stage run: `gate {dueAt, overdue, targetSecs, since, state}` while waiting on you, `stage {dueAt, overdue, targetSecs, stage, warn}` for a running stage the repo gave a target, `cycle {dueAt, overdue, targetSecs}` and `jiraDue` for the issue's due date, which ends at 23:59:59 in the site's timezone (UTC until known) and whose `targetSecs` counts from the task's creation or its link time, whichever is later; each null when it does not apply, the whole thing null when none does). A minute tick republishes a task on `task.updated` when any clock goes overdue or a stage clock starts warning. |
| POST | `/tasks` | Create a task: title, description, criteria, repo path, source. |
| GET | `/tasks/:id` | One task with its stage runs, approvals, recent events and artifacts. Jira events: `jira.linked {key, url, created?}`, `jira.unlinked {key}`, `jira.transitioned {from, to, fields?}`, `jira.blocked {wanted, current, why}`, `jira.commented {url}` (the "PR opened" comment went out for that url; it is what stops a repeat after a restart), `jira.moved {status, key}` (the issue reached Done, Cancelled or Won't Do in Jira while the task is open), `jira.intake {key, verdict, reason}` (made by intake). A verifying run carries `cases: [{ title, ok }]` (one verdict per approved case, from the pack's `results[]`; null when it reported none). |
| PATCH | `/tasks/:id` | Edit the ticket's text (title, description, criteria, repo path, source). |
| PATCH | `/tasks/:id/plan` | Edit triage's plan while it awaits your approval, or later while the task is `awaiting_test_check` (nothing is built yet; the approved plan is edited and the ticket's criteria follow): `{ "brief"?, "criteria"?, "assumptions"? }`, at least one field. Only the fields given change; slices stay as triage wrote them. Each edit appends `{ at, before, after }` (changed fields only) to the approval's `requested.revisions` and logs a `plan.edited` event with the field names. 409 `no_plan` at any other state. |
| PATCH | `/tasks/:id/cases` | Replace test_design's cases while the task is `awaiting_test_check`: `{ "cases": [{ "title", "criterion", "approach" }] }`, at least one. The open test-check approval keeps its other fields; logs a `cases.edited` event. 409 `no_cases` at any other state. |
| GET | `/tasks/:id/diff` | The task branch against its merge base with the base branch (origin's default branch, else `main`, else the repo's HEAD): `{ base, head, files: [{ path, status: "A"\|"M"\|"D"\|"R", added, removed }] }`. `?file=<path>` adds `patch` (that file's unified diff). Read-only. 404 `no_worktree` when the task has no worktree or it is gone from disk. |
| DELETE | `/tasks/:id` | Delete a task with its runs, approvals and events (blocked while a stage is running); closes its herdr watch tab (via `task.closed`). |
| POST | `/tasks/:id/start` | Start the pipeline. A repo with no `luna.yaml` gets the `setup` stage and its gate before triage. |
| POST | `/repos/setup` | `{ "repoPath" }`: a setup-only task (route `setup`) for that checkout, started at once; its one gate is the proposed `luna.yaml` with the proof per check. Approving writes the file and closes the task. |
| POST | `/tasks/:id/answers` | Answer triage questions: `{ "answers": { "<question>": "<answer>" } }`. |
| POST | `/tasks/:id/decision` | Approve or send back whatever the task waits on, including an escalation: `{ "decision": "approved" \| "sent_back", "reason"?, "applyRules"? }`. |
| POST | `/tasks/:id/abort` | Stop a running or queued stage; the task then waits for you. |
| POST | `/tasks/:id/resume` | Re-run the stage a task paused in after a usage limit. |
| POST | `/tasks/:id/worktree/remove` | Remove the task's worktree from disk. The task, its branch and commits stay. |
| GET | `/github/prs` | The PR inbox: every open PR involving you, as the machine last polled it: `{ prs, polledAt, error }`. Each PR carries its `split` (`review_requested`, `ready_to_merge`, `ci_failed`, `ci_running`, `changes_requested`, `mine`), `checks` (`state`, `passed`, `total`, the `failed` checks and `all` of them as `{ name, state, url }`), `localPath` (the checkout the machine would act in; null until cloned) and `task` (the PR task in flight, if any). |
| POST | `/github/prs/refresh` | Poll GitHub now; answers the fresh snapshot. |
| POST | `/github/prs/:owner/:name/:number/actions` | `{ "action": "ci_fix" \| "review" \| "address" }`: creates and starts a PR task on the PR's own head branch; answers the task (201). 409 `pr_busy` while a task runs for that PR, `no_checkout` without a clone, `fork` for a fix or an address on a fork head, `own_pr` for a review of your own PR. |
| POST | `/github/prs/:owner/:name/:number/merge` | Squash-merges the PR and deletes its branch; 409 `not_ready` unless its split is `ready_to_merge`. Answers `{ "merged": true }`. |
| POST | `/github/clone` | `{ "repo": "owner/name", "dest": "/abs/path" }`: clones in the background (202); the next `github.prs` event shows the checkout. 400 for a relative `dest`, a missing parent or an existing target. |
| GET | `/slack/items` | The Slack inbox, as the machine last polled it: `{ items, watches, me, polledAt, error, socket, sla }`. Each item carries its `split` (`needs_reply`, `waiting_on_them`, `decide`, `fyi`, `snoozed`, `done`), `triage` (priority, category, `expectsReply`, summary, why, draft, refs, deadline; null until the `slack_triage` pack ran, which happens after the poll publishes), `matched` (why it is in the inbox), `count` (messages folded into it), `replies`, `youReplied`, `reopenedAt`, `dueAt` (ISO: the latest message plus the reply SLA of its priority, null when no reply is expected or the item is cleared or snoozed), `overdue` (`dueAt` passed with no reply from you; recomputed every minute, so the stream publishes when an item goes overdue with no Slack event) and `linked` (`pr` from the PR inbox, `taskId`). `sla` is the reply SLA in effect, seconds by priority, from the rules file's `## SLA` (0 means none). `socket` is `off` without an app token. |
| POST | `/slack/refresh` | Poll Slack now; answers the fresh snapshot. |
| PATCH | `/slack/items/:id` | `{ done?, snoozedUntil?, seen?, priority? }`: `done: true` clears the item on our side (and in Slack when `MACHINE_SLACK_MARK_READ=on`), `false` reopens it; `snoozedUntil` is ISO or null; `priority` overrides triage and survives a re-triage. Answers the item; 404 `no_item`. |
| POST | `/slack/items/:id/reply` | `{ "text" }`: posts in the item's thread as you with your user token, clears the item and records the response time. 409 `no_token` without `MACHINE_SLACK_USER_TOKEN`. |
| POST | `/slack/items/:id/task` | `{ title?, repoPath? }`: a Backlog task from the message and its thread, `source.kind = slack`; answers the task (201). 409 `already_task` when the item already became one. |
| GET | `/slack/watches` | The handles, broadcasts, keywords and channels the inbox treats as addressed to you. `@here`, `@channel` and `@everyone` are built in. |
| POST | `/slack/watches` | `{ kind: "usergroup" \| "broadcast" \| "keyword" \| "channel", value, label?, channels?, priority? }`: `value` is the usergroup id, the broadcast word, the keyword or the channel id; the label is resolved from Slack when absent (201). |
| PATCH | `/slack/watches/:id` | `{ label?, channels?, priority?, enabled? }`; 404 `no_watch`. |
| DELETE | `/slack/watches/:id` | Removes a watch (204); 409 `builtin` for the three broadcasts, which can only be switched off. |
| GET | `/slack/metrics?since=7d\|30d` | How fast you answer: items and replies by priority, the share answered within an hour, `withinSla` (of the replies, how many inside their priority's SLA, by priority; a priority with the SLA off counts none) with the `sla` in effect, median and p90 seconds from the message to your reply, and a per-day series. |
| GET | `/slack/triage-runs?since=7d\|30d` | What triage cost: `{ since, runs, items, costUsd }`, one row per `slack_triage` pack run (`id`, `startedAt`, `endedAt`, `items`, `model`, `turns`, `costUsd`, `ok`, `error`), newest first, with the items and dollars summed. |
| GET | `/slack/usergroups` | `[{ id, handle, name }]` from `usergroups.list`, cached ten minutes, for the watch popup's autocomplete. |
| GET | `/slack/channels` | `[{ id, name, kind }]`: the channels you are in, cached ten minutes. |
| GET | `/jira/status` | `{ configured, site, tokenExpiresAt, error }`: whether Jira is set up and the token works (`error` is Jira's words when not; `tokenExpiresAt` is `MACHINE_JIRA_TOKEN_EXPIRES` as set, or the date a 401 named once the token has gone, else null). Present only when `MACHINE_JIRA_SITE`, `MACHINE_JIRA_EMAIL` and `MACHINE_JIRA_TOKEN` are set, like every `/jira/*` and `/tasks/:id/jira*` route. |
| GET | `/jira/search?q=` | Issues to pick from: a key (`PLAT-123`) answers that issue; text searches `text ~ "q"`, your open issues first, at most 15. `[{ key, summary, status, issueType, url }]`. |
| POST | `/tasks/:id/jira` | `{ "key": "PLAT-123" }`: links the ticket to the issue (status, priority and due date read now; `J` on the board). Answers the task; 404 `no_issue` when Jira has no such issue, 409 `no_token` when Jira is unconfigured, 409 `already_linked_elsewhere` when another open task holds that issue (close or unlink it first), 409 `has_worktree` when the ticket already works on a branch named from another issue (the same key again only refreshes the link). |
| DELETE | `/tasks/:id/jira` | Unlinks the ticket. Answers the task; 409 `has_worktree` once the ticket works on a branch, since that branch was named from the link. |
| POST | `/tasks/:id/jira/create` | `{ project?, issueType? }`: creates an issue from the ticket (title; description plus the criteria as a checklist) in `project` or the repo's `luna.yaml` `jira.project`, with `issueType` (default `Task`), and links it (201). 409 `already_linked` when the ticket carries one, 409 `no_project` when neither names a project. |
| GET | `/events` | SSE: `task.updated` (the whole task), `task.event` (one activity entry), `task.deleted`, `task.metrics`, `stage.started` (a stage container is running: task id, tab label, worktree, container name), `task.closed` (its watch tab can go), `budget.alert` (a spend passed 80, 90 or 100% of a task's, a repo's month's or the day's ceiling), `github.prs` (the PR inbox changed; the whole snapshot), `slack.items` (the Slack inbox changed: items, watches, error or socket state; the whole snapshot), plus `ready` and a `ping` every 15s. `task.updated` also fires when a task's Jira link changes (an event starting `jira.`, or JiraWatch's refresh) and when one of its SLA clocks flips. |
| POST | `/dev/stubs` | Dev only, when stub stages are in use: queue results for a stage, e.g. three `fail`s for `verifying`. |

Errors use `{ "error", "message" }`: 400 for invalid input, 404 for an unknown task, 409 for an action that does not fit the task's state, 500 otherwise.

## Example session

```sh
curl -s -X POST 127.0.0.1:4317/tasks -H 'content-type: application/json' \
  -d '{"title":"Login page","criteria":["Bad password shows an error"]}'
curl -s -X POST 127.0.0.1:4317/tasks/<id>/start
curl -s -X POST 127.0.0.1:4317/tasks/<id>/decision -H 'content-type: application/json' \
  -d '{"decision":"approved"}'
curl -sN 127.0.0.1:4317/events      # live updates
curl -s '127.0.0.1:4317/metrics?since=7d'   # factory metrics (7d, 30d or ISO): cycle time, first-pass, escalations, cost; also streamed as task.metrics
curl -s '127.0.0.1:4317/metrics?groupBy=repo'   # the same, plus one row per repo
```

Give a task a `"repoPath"` so the agents have a repo to work on.
