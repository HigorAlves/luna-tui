// Memory's visibility rule (RFC 0007), as Cognee dataset names. Cognee's search takes a list of
// datasets, so the machine names one dataset per repository and source and passes only those the
// viewer may see: the rule dedup and card_search use, a GitHub card sees GitHub items, a Slack card
// its own channel, a Jira card its project, a card typed in the TUI everything of its repository.
// Docs and the code graph are the repository's, seen by all its cards. The company folder is seen by
// every repository but never by a pack whose answer is posted in public. Pure.
import type { MemorySourceKind } from "@hardness/contracts";

export const COMPANY_DATASET = "company";

/** Cognee refuses dots and spaces in a dataset name; a channel or project id is made safe. */
const safe = (ref: string): string => ref.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "none";

/** The dataset an item of this repository and source lives in. `repo` is `repoSlug()`'s value. */
export function datasetFor(repo: string | null, source: { kind: MemorySourceKind; ref: string | null }): string {
  if (source.kind === "doc" && repo === null) return COMPANY_DATASET;
  if (repo === null) throw new Error(`a ${source.kind} memory item needs a repository`);
  switch (source.kind) {
    case "github":
      return `${repo}:github`;
    case "slack":
      return `${repo}:slack:${safe(source.ref ?? "")}`;
    case "jira":
      return `${repo}:jira:${safe(source.ref ?? "")}`;
    case "tui":
      return `${repo}:tui`;
    case "doc":
      return `${repo}:docs`;
    case "code":
      return `code:${repo}`;
  }
}

/** Who is asking. `publicPost`: the pack's answer is posted to a public place (a GitHub issue or PR reply, triage questions to a public source). */
export type MemoryViewer =
  | { kind: "card"; repo: string; source: { kind: "github" | "slack" | "jira" | "tui"; ref: string | null }; publicPost: boolean }
  | { kind: "operator"; repo: string | null }
  | { kind: "slack"; repo: string | null; channel: string };

/** Whether a pack's answer is posted in public for a card of this source kind: always for `pr_reply`, and for any pack on a GitHub-sourced card; never for slack, jira, tui (no source) or notch. */
export function publicPostFor(pack: string, source: { kind: string }): boolean {
  return pack === "pr_reply" || source.kind === "github" || source.kind === "github_pr";
}

/** The datasets of `known` (the names Cognee holds) this viewer may read. */
export function datasetsFor(viewer: MemoryViewer, known: readonly string[]): string[] {
  const has = new Set(known);
  const pick = (names: string[]): string[] => [...new Set(names)].filter((n) => has.has(n));
  const shared = (repo: string): string[] => [`${repo}:docs`, `code:${repo}`];
  switch (viewer.kind) {
    case "operator":
      return viewer.repo === null ? [...has] : known.filter((n) => n.startsWith(`${viewer.repo}:`) || n === `code:${viewer.repo}` || n === COMPANY_DATASET);
    case "slack":
      return pick([...(viewer.repo ? [datasetFor(viewer.repo, { kind: "slack", ref: viewer.channel }), ...shared(viewer.repo)] : []), COMPANY_DATASET]);
    case "card": {
      const company = viewer.publicPost ? [] : [COMPANY_DATASET];
      if (viewer.source.kind === "tui") return known.filter((n) => n.startsWith(`${viewer.repo}:`) || n === `code:${viewer.repo}` || company.includes(n));
      return pick([datasetFor(viewer.repo, viewer.source), ...shared(viewer.repo), ...company]);
    }
  }
}

/** Whether the answer of this pack, for a card from this source, is posted in public: `pr_reply` always is (a reply on a shipped PR), and
 *  any pack on a GitHub issue or PR posts there (triage's questions to the reporter, a reply). Slack, Jira and the TUI are private places.
 *  The recall call sites build their viewer with this, never a literal `false`; the company dataset is dropped when it is true. */
export function publicPostFor(pack: string, source: { kind: string }): boolean {
  return pack === "pr_reply" || source.kind === "github" || source.kind === "github_pr";
}
