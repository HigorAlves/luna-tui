// The company brain's port (RFC 0010): a typed graph the machine writes to and reads from. Writes
// are loads of rows; reads are named queries only, so no caller composes a query of its own.
import { BRAIN_QUERIES, type BrainEdgeName, type BrainRow } from "@hardness/contracts";

export type BrainLoadMode = "merge" | "append" | "overwrite";
/** Which token a load carries, so the commit history says who wrote. */
export type BrainWriter = "facts" | "memories";
export type BrainValue = string | number | boolean | null;

export interface BrainAnswer {
  rows: Array<Record<string, BrainValue>>;
  /** Why the list is empty or short; null when there is nothing to say. */
  note: string | null;
}

export class BrainError extends Error {
  readonly code: string;
  readonly status: number | null;
  /** "unknown" when the write may have landed. */
  readonly effects: "none" | "unknown";
  constructor(message: string, code: string, status: number | null = null, effects: "none" | "unknown" = "none") {
    super(message);
    this.name = "BrainError";
    this.code = code;
    this.status = status;
    this.effects = effects;
  }
}

export interface Brain {
  readonly enabled: boolean;
  health(): Promise<{ ok: boolean; version: string | null; note: string | null }>;
  /** One HTTP load, one commit. Throws BrainError when the server refuses it or the outcome is unknown. */
  load(rows: BrainRow[], options?: { mode?: BrainLoadMode; actor?: BrainWriter }): Promise<{ entities: number; commit: string | null }>;
  /** A named query. Never throws: a failure is no rows and a note. */
  query(name: string, params?: Record<string, string | number>): Promise<BrainAnswer>;
  /** Removes one edge, or every edge of that name that starts at `from` when `to` is left out: a load only adds edges, so an edge that moved or went away is removed first. Returns how many went. Throws BrainError. */
  unlink(edge: BrainEdgeName, from: string, to?: string): Promise<number>;
  /** Empties the graph, for a rebuild. Throws BrainError. */
  reset(): Promise<void>;
}

/** The note of a query that ran and found no row: an empty answer, as opposed to one that failed. */
export const foundNothing = (name: string): string => `${name} found nothing`;

/** Whether the brain answered the query: no note, or only the note of an empty answer. A failed read and a brain that is off are not answers. */
export const answered = (name: string, answer: BrainAnswer): boolean => answer.note === null || answer.note === foundNothing(name);

const OFF = "the brain is off";

export function noBrain(): Brain {
  return {
    enabled: false,
    health: async () => ({ ok: false, version: null, note: OFF }),
    load: async () => ({ entities: 0, commit: null }),
    query: async () => ({ rows: [], note: OFF }),
    unlink: async () => 0,
    reset: async () => {},
  };
}

const refused = (note: string): BrainAnswer => ({ rows: [], note });

/** Why an agent may not run this query with these parameters, or null when it may: only the names `BRAIN_QUERIES` lists for agents, with the parameters they declare. */
export function agentRefusal(name: string, params: Record<string, string | number> = {}): string | null {
  const query = BRAIN_QUERIES.find((candidate) => candidate.name === name);
  if (!query || !query.agent) return `${name} is not a query an agent may run`;
  for (const key of Object.keys(params)) {
    if (!(key in query.params)) return `${name} has no parameter ${key}`;
  }
  for (const [key, type] of Object.entries(query.params)) {
    const value = params[key];
    const fits = type === "String" ? typeof value === "string" : typeof value === "number" && Number.isInteger(value);
    if (!fits) return `${name} needs ${key} as ${type === "String" ? "a string" : "an integer"}`;
  }
  return null;
}

/** Runs a query on behalf of a pack or an agent, once `agentRefusal` has nothing against it. */
export async function agentQuery(brain: Brain, name: string, params: Record<string, string | number> = {}): Promise<BrainAnswer> {
  const refusal = agentRefusal(name, params);
  return refusal ? refused(refusal) : brain.query(name, params);
}
