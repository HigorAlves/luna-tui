// The machine's side of the `brain_query` luna tool (RFC 0010): an agent in a stage container cannot reach the brain, so it
// writes a request into the checks mailbox and the machine answers from the graph through `agentQuery`. The request is
// untrusted input; the answer is bounded; nothing is read unless the repository's `luna.yaml` says `brain.tell: "on"`; and
// only the queries `BRAIN_QUERIES` marks with a `tool` run, each confined to the task's own repository: what steers the
// agent's search may come from outside the org, and the graph holds every repository's cards, incidents and answers.
import { BRAIN_QUERIES, toolQuery } from "@hardness/contracts";

import { type Brain, type BrainValue, agentQuery, agentRefusal } from "./brain.ts";

export const MAX_BRAIN_ROWS = 20;
export const MAX_BRAIN_TEXT = 300;
const MAX_NAME = 80;
const MAX_PARAMS = 10;

export interface BrainQueryRequest {
  name: string;
  params: Record<string, string | number>;
}

export interface BrainQueryAnswer {
  verdict: "ok" | "refused" | "skipped";
  problems: string[];
  rows: Array<Record<string, BrainValue>>;
  note: string | null;
}

/** The request file's text as a request, or null when it is not one: the container writes it, so a wrong shape is skipped, never guessed at. */
export function parseBrainRequest(text: string): BrainQueryRequest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const { name, params } = parsed as { name?: unknown; params?: unknown };
  if (typeof name !== "string" || name.length === 0 || name.length > MAX_NAME) return null;
  if (params === undefined) return { name, params: {} };
  if (typeof params !== "object" || params === null || Array.isArray(params)) return null;
  const entries = Object.entries(params);
  if (entries.length > MAX_PARAMS) return null;
  const clean: Record<string, string | number> = {};
  for (const [key, value] of entries) {
    if (typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) clean[key] = value;
    else return null;
  }
  return { name, params: clean };
}

const skipped = (note: string): BrainQueryAnswer => ({ verdict: "skipped", problems: [], rows: [], note });
const NOT_TOLD = "the brain is not told to this repository";

const cut = (row: Record<string, BrainValue>): Record<string, BrainValue> =>
  Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === "string" ? value.slice(0, MAX_BRAIN_TEXT) : value]));

const toolNames = BRAIN_QUERIES.filter((query) => query.tool).map((query) => query.name).join(", ");
const refuse = (problem: string): BrainQueryAnswer => ({ verdict: "refused", problems: [problem], rows: [], note: problem });

/** Whether `card_repo` places the card in the repository; a lookup that fails or finds nothing says no. */
async function cardIsIn(brain: Brain, card: string, repo: string): Promise<boolean> {
  try {
    return (await brain.query("card_repo", { card })).rows[0]?.repo === repo;
  } catch {
    return false;
  }
}

/** What answers a request for a repository. */
export type BrainQueryAnswerer = (repoPath: string | null, request: BrainQueryRequest) => Promise<BrainQueryAnswer>;

/** One request answered for one repository. Off by default: without `tell` the brain is not even asked. */
export function brainQueryAnswerer(deps: {
  brain: Brain;
  /** Whether the repository's `luna.yaml` says `brain.tell: "on"`. */
  tell: (repoPath: string) => Promise<boolean>;
  /** The machine's `repoSlug()`: the repository's key in the graph is `repo:<slug>`. */
  repoSlug: (repoPath: string) => string;
}): BrainQueryAnswerer {
  return async (repoPath, request) => {
    if (!deps.brain.enabled || !repoPath) return skipped(NOT_TOLD);
    try {
      if (!(await deps.tell(repoPath))) return skipped(NOT_TOLD);
    } catch {
      // A file that cannot be read tells nothing.
      return skipped(NOT_TOLD);
    }
    const query = toolQuery(request.name);
    if (!query) return refuse(`${request.name} is not a query this tool runs; the queries are ${toolNames}`);
    const repo = `repo:${deps.repoSlug(repoPath)}`;
    const params = { ...request.params };
    if (query.tool === "repo") {
      // The task's repository, whatever the request names: the agent need not send one.
      params.repo = repo;
    } else if (query.tool === "card") {
      if (typeof params.card !== "string" || !(await cardIsIn(deps.brain, params.card, repo))) return refuse(`${request.name}: that card is not in this repository`);
    } else if (typeof params.component !== "string" || !params.component.startsWith(`component:${deps.repoSlug(repoPath)}/`)) {
      return refuse(`${request.name}: that component is not in this repository`);
    }
    const refusal = agentRefusal(request.name, params);
    if (refusal) return refuse(refusal);
    let answer;
    try {
      answer = await agentQuery(deps.brain, request.name, params);
    } catch {
      return skipped("the brain did not answer");
    }
    return { verdict: "ok", problems: [], rows: answer.rows.slice(0, MAX_BRAIN_ROWS).map(cut), note: answer.note };
  };
}
