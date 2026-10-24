# API

The machine's HTTP API, read straight from `machine/src/adapters/http/app.ts`. Shapes are defined in `contracts/src/api.ts`.

| Method | Path | Does |
|---|---|---|
| GET | `/health` | Liveness check. |
| GET | `/metrics` | Factory metrics over a window: `?since=7d\|30d\|<ISO timestamp>` (default `7d`). Cycle time, first-pass rate, escalations, cost, queue depth; also streamed as `task.metrics`. |
| GET | `/tasks` | List every task with its state and column. |
| POST | `/tasks` | Create a task: title, description, criteria, repo path, source. |
| GET | `/tasks/:id` | One task with its stage runs, approvals, recent events and artifacts. |
| PATCH | `/tasks/:id` | Edit the ticket's text (title, description, criteria, repo path, source). |
| DELETE | `/tasks/:id` | Delete a task with its runs, approvals and events (blocked while a stage is running); closes its herdr watch tab. |
| POST | `/tasks/:id/start` | Start the pipeline. |
| POST | `/tasks/:id/answers` | Answer triage questions: `{ "answers": { "<question>": "<answer>" } }`. |
| POST | `/tasks/:id/decision` | Approve or send back whatever the task waits on, including an escalation: `{ "decision": "approved" \| "sent_back", "reason"?, "applyRules"? }`. |
| POST | `/tasks/:id/abort` | Stop a running or queued stage; the task then waits for you. |
| POST | `/tasks/:id/resume` | Re-run the stage a task paused in after a usage limit. |
| POST | `/tasks/:id/worktree/remove` | Remove the task's worktree from disk. The task, its branch and commits stay. |
| GET | `/events` | SSE: `task.updated` (the whole task), `task.event` (one activity entry), `task.deleted`, `task.metrics`, plus `ready` and a `ping` every 15s. |
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
```

Give a task a `"repoPath"` so the agents have a repo to work on.
