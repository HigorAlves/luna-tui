# API

The machine's HTTP API, read straight from `machine/src/adapters/http/app.ts`. Shapes are defined in `contracts/src/api.ts`.

| Method | Path | Does |
|---|---|---|
| GET | `/health` | Liveness check; also the stage pool: `slots {max, active, draining}`. |
| POST | `/drain` | Take no new work: running stages finish, the queue waits. Answers with the pool. |
| POST | `/resume` | Carry on: the queue is picked up again at once. |
| PATCH | `/slots` | `{max}`: resize the pool at run time (at least 1). |
| GET | `/metrics` | Factory metrics over a window: `?since=7d\|30d\|<ISO timestamp>` (default `7d`). Cycle time, first-pass rate, escalations, cost, queue depth; also streamed as `task.metrics`. `&repo=<path>` limits the numbers to one checkout (`repo=` to the tasks with none); `&groupBy=repo` adds `byRepo`, one slim row per checkout (tasks, escalation rate, first-pass verifying, cost). |
| GET | `/tasks` | List every task with its state, column and `route` (`feature`, `setup`, or a PR task's `ci_fix`, `review` or `address`). |
| POST | `/tasks` | Create a task: title, description, criteria, repo path, source. |
| GET | `/tasks/:id` | One task with its stage runs, approvals, recent events and artifacts. |
| PATCH | `/tasks/:id` | Edit the ticket's text (title, description, criteria, repo path, source). |
| PATCH | `/tasks/:id/plan` | Edit triage's proposed plan while it awaits your approval: `{ "brief"?, "criteria"?, "assumptions"? }`, at least one field. Only the fields given change; slices stay as triage wrote them. 409 if there's no open plan to edit. |
| DELETE | `/tasks/:id` | Delete a task with its runs, approvals and events (blocked while a stage is running); closes its herdr watch tab (via `task.closed`). |
| POST | `/tasks/:id/start` | Start the pipeline. A repo with no `luna.yaml` gets the `setup` stage and its gate before triage. |
| POST | `/repos/setup` | `{ "repoPath" }`: a setup-only task (route `setup`) for that checkout, started at once; its one gate is the proposed `luna.yaml` with the proof per check. Approving writes the file and closes the task. |
| POST | `/tasks/:id/answers` | Answer triage questions: `{ "answers": { "<question>": "<answer>" } }`. |
| POST | `/tasks/:id/decision` | Approve or send back whatever the task waits on, including an escalation: `{ "decision": "approved" \| "sent_back", "reason"?, "applyRules"? }`. |
| POST | `/tasks/:id/abort` | Stop a running or queued stage; the task then waits for you. |
| POST | `/tasks/:id/resume` | Re-run the stage a task paused in after a usage limit. |
| POST | `/tasks/:id/worktree/remove` | Remove the task's worktree from disk. The task, its branch and commits stay. |
| GET | `/events` | SSE: `task.updated` (the whole task), `task.event` (one activity entry), `task.deleted`, `task.metrics`, `stage.started` (a stage container is running: task id, tab label, worktree, container name), `task.closed` (its watch tab can go), `budget.alert` (a spend passed 80, 90 or 100% of a task's, a repo's month's or the day's ceiling), plus `ready` and a `ping` every 15s. |
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
