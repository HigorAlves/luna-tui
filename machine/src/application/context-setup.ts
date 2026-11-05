// Context setup: when a card starts, the machine resolves by script what Intake needs: the repository,
// the project, the owners and the history of the card's sources. No model. Everything a stranger wrote
// (history) is flattened and bounded by `historyOf`; the ports are injected, so each source kind is read by its own adapter.
import type { CardFields, TaskSource } from "@hardness/contracts";

import { type HistoryEntry, type RawHistoryEntry, historyOf } from "../domain/card-history.ts";
import { cardOf } from "../domain/card-fields.ts";

const MAX_OWNERS = 20;
/** Text past this is not given to CODEOWNERS matching: a ticket body is attacker-sized. */
const LOCATE_CHARS = 4000;

export interface ContextDeps {
  /** `owner/name` to a checkout (the repository map). */
  resolveRepo(slug: string): Promise<string | null>;
  /** The repository configured for a Slack channel id, or for a Jira project key. */
  channelRepo(channel: string): string | null;
  projectRepo(project: string): Promise<string | null>;
  /** The Jira project `luna.yaml` of the repository names, if any. */
  configProject(repoPath: string): Promise<string | null>;
  /** CODEOWNERS at the default branch, through the graph port, for the files the card's text points at. */
  owners(repoPath: string, text: string): Promise<string[]>;
  /** The thread or ticket history of one source, through its port. */
  history(source: TaskSource): Promise<RawHistoryEntry[]>;
}

export type RepoFrom = "card" | "hint" | "config" | "map" | null;

export interface Resolved {
  repoPath: string | null;
  repoFrom: RepoFrom;
  project: string | null;
  owners: string[];
  history: HistoryEntry[];
}

interface CardInput {
  title: string;
  description: string;
  repoPath: string | null;
  source: TaskSource | null;
  card?: CardFields | null;
}

const jiraProject = (source: TaskSource): string | null => {
  const key = source.kind === "jira" ? source.key : null;
  const match = key ? /^([A-Z][A-Z0-9_]+)-\d+$/.exec(key) : null;
  return match ? match[1]! : null;
};

export async function contextSetup(deps: ContextDeps, row: CardInput): Promise<Resolved> {
  const stored = cardOf({ card: row.card ?? null, source: row.source });
  // A stored card is jsonb: read each field defensively.
  const card = { project: stored.project ?? null, links: stored.links ?? {} };
  // The diagram's own source shape (`type`) names no tracker the machine can read: only the machine's kinds count here.
  const sources = (stored.sources ?? (row.source ? [row.source] : [])).filter((s): s is TaskSource => "kind" in s);
  const project = card.project ?? sources.map(jiraProject).find((p) => p !== null) ?? null;

  let repoPath = row.repoPath;
  let repoFrom: RepoFrom = repoPath ? "card" : null;
  const hint = repoSlugOf(card.links.repo);
  if (!repoPath && hint) {
    repoPath = await deps.resolveRepo(hint).catch(() => null);
    if (repoPath) repoFrom = "hint";
  }
  if (!repoPath) {
    for (const source of sources) {
      const channel = source.kind === "slack" ? source.channel : null;
      const key = jiraProject(source);
      repoPath = (channel ? deps.channelRepo(channel) : null) ?? (key ? await deps.projectRepo(key).catch(() => null) : null);
      if (repoPath) break;
    }
    if (repoPath) repoFrom = "config";
  }
  if (!repoPath) {
    for (const source of sources) {
      if (source.kind !== "github" && source.kind !== "github_pr") continue;
      repoPath = await deps.resolveRepo(source.repo).catch(() => null);
      if (repoPath) break;
    }
    if (repoPath) repoFrom = "map";
  }

  const owners = repoPath
    ? (await deps.owners(repoPath, `${row.title}\n${row.description}`.slice(0, LOCATE_CHARS)).catch(() => [])).slice(0, MAX_OWNERS)
    : [];
  const resolvedProject = project ?? (repoPath ? await deps.configProject(repoPath).catch(() => null) : null);

  const raw: RawHistoryEntry[] = [];
  for (const source of sources) raw.push(...(await deps.history(source).catch(() => [] as RawHistoryEntry[])));
  return { repoPath: repoPath ?? null, repoFrom, project: resolvedProject, owners, history: historyOf(raw) };
}

export interface Correction {
  field: "repoPath" | "project";
  resolved: string | null;
  chosen: string | null;
}

/** What a person changed after the machine resolved it: kept as ground truth for the resolution rules. */
export function correctionsOf(resolved: { repoPath: string | null; project: string | null }, chosen: { repoPath: string | null; project: string | null }): Correction[] {
  return (["repoPath", "project"] as const)
    .filter((field) => resolved[field] !== chosen[field])
    .map((field) => ({ field, resolved: resolved[field], chosen: chosen[field] }));
}

/** The one repository among `repos` whose luna.yaml names Jira project `project`; two or none give null (a person picks). */
export async function uniqueRepoForProject(project: string, repos: string[], projectOf: (repoPath: string) => Promise<string | null>): Promise<string | null> {
  const matches: string[] = [];
  for (const repo of new Set(repos)) if ((await projectOf(repo).catch(() => null)) === project) matches.push(repo);
  return matches.length === 1 ? matches[0]! : null;
}

/** `owner/name` from a hint that is either that or a github.com URL (an issue, a PR, a `.git` remote); null for anything else. */
export function repoSlugOf(hint: string | undefined): string | null {
  if (!hint) return null;
  const text = hint.trim();
  const url = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#].*)?$/i.exec(text);
  if (url) return `${url[1]}/${url[2]}`;
  return /^[\w.-]+\/[\w.-]+$/.test(text) ? text : null;
}
