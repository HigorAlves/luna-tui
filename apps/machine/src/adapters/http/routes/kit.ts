// What the route modules share: the error helpers, the body parser, the id checks and the inputs only a route reads.
import type { GitHubError } from "../../../application/github.ts";
import { type ApiError, EngineId, TaskSource } from "@hardness/contracts";
import { TicketChatContext, ForemanContext } from "@hardness/contracts";
import { realpath } from "node:fs/promises";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { type ZodType, z } from "zod";
import type { TaskRow } from "../../../domain/task.ts";
import { EngineBudgetWatch } from "../../../application/engine-gates.ts";
import type { Credentials } from "../../credentials/index.ts";
import type { RepoSignals } from "../../../application/repo-signals.ts";
import { TaskNotFoundError } from "../../../application/pipeline.ts";
import { taskStagesProblem } from "../../../domain/engine-choice.ts";
import type { Task } from "@hardness/contracts";
import type { AppDeps } from "../app.ts";


export const PING_EVERY_MS = 15_000;
/** Every `source.kind` a task may carry, for `GET /events?source=`. */
export const SOURCE_KINDS: string[] = TaskSource.options.map((option) => option.shape.kind.value);
export const IDEMPOTENCY_KEY_MAX = 200;
/** Activity entries returned with one task. */
export const RECENT_EVENTS = 50;

/** `POST /foreman`: the question and the last turns of the talk. */
export const ForemanInput = z.object({ question: ForemanContext.shape.question, history: ForemanContext.shape.history.optional() });

/** Packs only their own route may run: `POST /runs` refuses them, since the route sets what the run reads and what its trusted prompt header says. */
export const ROUTE_ONLY_PACKS: readonly string[] = ["ticket_chat", "design_spec", "a11y_audit"];
/** The route that runs each of them. */
export const ROUTE_OF: Readonly<Record<string, string>> = { ticket_chat: "POST /ticket-chat", design_spec: "POST /design/spec", a11y_audit: "POST /design/audit" };

/** The real path of `path`, or null when it cannot be resolved. */
export const realOrNull = (path: string): Promise<string | null> => realpath(path).catch(() => null);

/** `POST /ticket-chat`: the repo (an absolute path the machine knows), the engine (the pack's default when left out), the message and the talk so far. */
export const TicketChatInput = z.object({
  repo: z.string().min(1),
  engine: EngineId.optional(),
  message: TicketChatContext.shape.message,
  history: TicketChatContext.shape.history.default([]),
  notes: TicketChatContext.shape.notes.default(""),
  draft: TicketChatContext.shape.draft.default(null),
});

export class BadRequest extends Error {}

/** The window of a repo's own runs that a config proposal reads. */
export const SIGNAL_DAYS = 30;
export const DAY_MS = 24 * 60 * 60 * 1000;

/** The client closed the request first (nginx's 499): nobody reads it, the log does. */
export const CLIENT_CLOSED = 499;

/** An error answer. The status stays its literal type, so an OpenAPI route's handler type-checks it against the statuses the route declares. */
export const fail = <S extends 400 | 404 | 409 | 422 | 429 | 500 | 502 | 503 | typeof CLIENT_CLOSED>(c: Context, status: S, error: string, message: string, extra: Record<string, unknown> = {}) =>
  c.json<ApiError, S & ContentfulStatusCode>({ error, message, ...extra }, status as S & ContentfulStatusCode);

/** GitHub refused (the error carries its status): a rate limit is 429 `github_rate_limited`, a refused token 502
 *  `github_unauthorized`, anything else 502 `github_failed`, each in GitHub's words. Never 500: the machine did not fail. */
export function githubRefusal(c: Context, { status, message }: GitHubError) {
  if (status === 429 || (status === 403 && /rate limit/i.test(message))) return fail(c, 429, "github_rate_limited", message);
  if (status === 401) return fail(c, 502, "github_unauthorized", message);
  return fail(c, 502, "github_failed", message);
}

/** `X-Luna-Client`: who calls `POST /runs` (`notch`), for its record. */
export const CLIENT_NAME = /^[\w.-]{1,64}$/;

export async function body<T>(c: Context, schema: ZodType<T>): Promise<T> {
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    throw new BadRequest("body must be JSON");
  }
  return schema.parse(json);
}

/** Task ids are UUIDs; anything else cannot exist, so it is a 404 rather than a SQL error. */
export function taskId(c: Context): string {
  const id = c.req.param("id") ?? "";
  if (!z.uuid().safeParse(id).success) throw new TaskNotFoundError(id);
  return id;
}

/** `owner`, `name` and a positive integer `number` from a `/github/prs/:owner/:name/:number/*` route. */
export function prParams(c: Context): { owner: string; name: string; number: number } {
  const owner = c.req.param("owner") ?? "";
  const name = c.req.param("name") ?? "";
  const number = Number(c.req.param("number"));
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(name) || !Number.isInteger(number) || number < 1) {
    throw new BadRequest("the PR must be /github/prs/<owner>/<name>/<number>");
  }
  return { owner, name, number };
}

/** A task's `stages` name only packs that run in a task, each on an engine it allows. */
export function checkStages(stages: Parameters<typeof taskStagesProblem>[0]): void {
  const problem = taskStagesProblem(stages);
  if (problem) throw new BadRequest(`stages.${problem}`);
}

/** A task row as the board reads it, clocks included. */
export type Serialize = (row: TaskRow, usage?: { spentUsd: number; workedMs: number } | null) => Promise<Task>;

/** What every route module gets: the app's dependencies with their defaults applied, and `serialize`. */
export type RouteDeps = Omit<AppDeps, "credentials" | "engineBudgets" | "repoSignals" | "knownRepos" | "chatRepos" | "clock" | "problems" | "access"> & {
  credentials: Pick<Credentials, "check">;
  engineBudgets: Pick<EngineBudgetWatch, "standings">;
  repoSignals: RepoSignals;
  knownRepos: () => Promise<string[]>;
  chatRepos: () => Promise<string[]>;
  clock: () => Date;
  problemsOf?: AppDeps["problems"];
  serialize: Serialize;
};
