// The implementer's Diff Summary, as the machine stores it: the agent's words flattened and capped, the files it lists checked against the diff,
// and what git knows put over what the agent said (`in_code_map`, `deps_added`, `todos`). A file in the diff that the summary does not list is
// added with no reason. Pure.
import { safe } from "./evidence-markdown.ts";
import { DiffSummaryAnswer, type DiffSummary, isPlainRepoPath, oneLine } from "@hardness/contracts";

const FIELD_CAP = 300;
const MAX_FILES = 50;
const MAX_LIST = 10;

export interface DiffFacts {
  /** Every file the change touched, from git. */
  changed: readonly string[];
  newDependencies: readonly string[];
  todos: readonly string[];
  /** The code map's files: what is in the map. */
  mapFiles: readonly string[];
}

const line = (text: unknown): string => (typeof text === "string" ? safe(oneLine(text, FIELD_CAP)).slice(0, FIELD_CAP) : "");
const list = (items: readonly string[] | undefined): string[] => (items ?? []).map(line).filter(Boolean).slice(0, MAX_LIST);

export function diffSummaryOf(answer: unknown, facts: DiffFacts): DiffSummary {
  const parsed = DiffSummaryAnswer.safeParse(answer);
  const said = parsed.success ? parsed.data : {};
  const changed = new Set(facts.changed);
  const inMap = new Set(facts.mapFiles);
  const reasons = new Map<string, string | null>();
  for (const f of said.files ?? []) {
    // A path the agent named is the diff's or it is dropped; a path that is not a plain repository path is never kept.
    if (isPlainRepoPath(f.path) && changed.has(f.path) && !reasons.has(f.path)) reasons.set(f.path, f.reason ? line(f.reason) || null : null);
  }
  const files = [...reasons.keys(), ...facts.changed.filter((p) => !reasons.has(p))].slice(0, MAX_FILES).map((path) => ({ path, reason: reasons.get(path) ?? null, in_code_map: inMap.has(path) }));
  return {
    what: line(said.what),
    why: line(said.why),
    files,
    flags_added: list(said.flags_added),
    migrations: list(said.migrations),
    risks_noticed: list(said.risks_noticed),
    deps_added: facts.newDependencies.map(line).filter(Boolean).slice(0, MAX_LIST),
    todos: facts.todos.map(line).filter(Boolean).slice(0, MAX_LIST),
  };
}
