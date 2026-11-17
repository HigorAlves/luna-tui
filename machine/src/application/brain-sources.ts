// What the projector reads (RFC 0010): the machine's own records, never GitHub or a model. Built on stores injected by `main.ts`, so a test hands it plain functions.
import type { BrainClaim, DecisionRecord } from "@hardness/contracts";

import type { BrainPull, BrainRepo, RetroFacts } from "../domain/brain/rows.ts";
import type { Incident } from "../domain/incident.ts";
import type { EventRow, TaskRow } from "../domain/task.ts";
import type { BrainSources } from "./brain-projector.ts";

export interface BrainSourceDeps {
  /** Every task; the cursor is applied here. */
  tasks(): Promise<TaskRow[]>;
  events(taskId: string): Promise<EventRow[]>;
  /** The `detail` of the card's latest plan stage finish (the `test_design` stage), which carries the code map as `map`. */
  planDetail(taskId: string): Promise<Record<string, unknown> | undefined>;
  retro(taskId: string): Promise<RetroFacts | null>;
  /** The machine's `repoSlug()`. */
  repoSlug(repoPath: string): string;
  /** The decision records that have a truth, from the day folders at or after `fromDay` (`yyyy-mm-dd`); every folder when null. */
  decisions(fromDay: string | null): Promise<DecisionRecord[]>;
  /** The claims updated at or after `since`, oldest first; every claim when null. The store's own bound on a page is the binding's to handle. */
  claims(since: Date | null): Promise<BrainClaim[]>;
  /** The GitHub login the machine runs as; null or a throw when it is not known. */
  viewerLogin(): Promise<string | null>;
  /** The text of the repository's `docs/agents/project-context.md` on its default branch; null when it has none. */
  context(repoPath: string): Promise<string | null>;
  /** Every stored incident; empty when the machine has no incident job. */
  incidents(): Promise<Incident[]>;
  /** The `compliance` list of the repository's `luna.yaml`. */
  regimes(repoPath: string): Promise<string[]>;
  /** The wiki's pages under `prefix`; null when the repository has no GitHub slug the machine knows. A wiki that cannot be reached throws. */
  wikiPages(repoPath: string, prefix: string): Promise<{ path: string; text: string }[] | null>;
}

/** The wiki folders the brain points at. */
export const WIKI_FOLDERS = ["Compliance/Controls/", "Compliance/Policies/", "Compliance/Answers/"] as const;

/** How far back of its cursor a verdict sweep opens the decision log's day folders. A record is filed under the day it was decided, and its
 *  truth comes later: at the card's close, or when a person corrects it. A truth that comes later than this after its decision is not read. */
export const VERDICT_LOOKBACK_DAYS = 45;
const DAY_MS = 86_400_000;

/** One run takes at most this many verdicts, oldest first, so a first run over a long log does not stall. */
export const VERDICTS_PER_RUN = 2_000;

const PULL_URL = /^https?:\/\/[^/\s]+\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/;

/** `owner/name` and the number out of a pull request's url; null for anything else. */
function parsePullUrl(url: unknown): { repo: string; number: number } | null {
  const found = typeof url === "string" ? PULL_URL.exec(url) : null;
  return found ? { repo: found[1]!, number: Number(found[2]) } : null;
}

/** When a record was decided or its truth learned, whichever is later. */
const touched = (record: DecisionRecord): number => Math.max(new Date(record.at).getTime(), record.truth ? new Date(record.truth.at).getTime() || 0 : 0);

export function brainSources(deps: BrainSourceDeps): BrainSources {
  return {
    tasks: async (since) => (await deps.tasks()).filter((task) => since === null || task.updatedAt >= since).sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime()),

    repoOf: (repoPath): BrainRepo => ({ slug: deps.repoSlug(repoPath), name: repoPath.replace(/\/+$/, "").split("/").pop() || repoPath }),

    retroOf: async (task) => deps.retro(task.id).catch(() => null),

    pullsOf: async (task): Promise<BrainPull[]> => {
      const events = await deps.events(task.id);
      const merged = events.filter((event) => event.kind === "ship.merged");
      const ended = task.state === "closed" || task.state === "archived";
      const found = new Map<string, { url: string; repo: string; number: number; opened: boolean }>();
      for (const event of events) {
        if (event.kind !== "pr.opened") continue;
        const parsed = parsePullUrl(event.payload.url);
        if (parsed && typeof event.payload.url === "string") found.set(`${parsed.repo}#${parsed.number}`, { url: event.payload.url, ...parsed, opened: true });
      }
      const source = task.source;
      if (source?.kind === "github_pr") {
        const key = `${source.repo}#${source.number}`;
        found.set(key, { url: source.url, repo: source.repo, number: source.number, opened: found.get(key)?.opened ?? false });
      }
      return [...found.values()].map((pull) => {
        // A ship.merged that names another pull request is not this one's; one that names none is.
        const landed = merged.findLast((event) => event.payload.prUrl === undefined || event.payload.prUrl === pull.url);
        return {
          repo: pull.repo,
          number: pull.number,
          title: task.title,
          state: landed ? "merged" : ended ? "closed" : "open",
          url: pull.url,
          mergedAt: landed ? landed.at : null,
          author: null,
          opened: pull.opened,
        };
      });
    },

    componentsOf: async (task) => {
      const map = (await deps.planDetail(task.id))?.map;
      const components = map && typeof map === "object" ? (map as { components?: unknown }).components : undefined;
      return Array.isArray(components) ? components.filter((name): name is string => typeof name === "string") : [];
    },

    verdicts: async (since) =>
      (await deps.decisions(since === null ? null : new Date(since.getTime() - VERDICT_LOOKBACK_DAYS * DAY_MS).toISOString().slice(0, 10)))
        .filter((record) => record.truth && !record.private && (since === null || touched(record) >= since.getTime()))
        .sort((a, b) => touched(a) - touched(b))
        .slice(0, VERDICTS_PER_RUN),

    // A refused claim never reaches the graph; the store may or may not have left it out.
    claims: async (since) => (await deps.claims(since)).filter((claim) => claim.status !== "refused"),

    // A failure is not an empty file: it is null, which retires nothing.
    principlesOf: async (repoPath) => deps.context(repoPath).catch(() => null),

    incidents: async () => deps.incidents(),

    // A failure is not an empty list: it is null, which unlinks nothing.
    regimesOf: async (repoPath) => deps.regimes(repoPath).catch(() => null),

    // One failed folder is a failed pass: a half-read wiki must not look like a wiki that lost its pages.
    wikiPagesOf: async (repoPath) => {
      try {
        const pages: { path: string; text: string }[] = [];
        for (const folder of WIKI_FOLDERS) {
          const found = await deps.wikiPages(repoPath, folder);
          if (found === null) return null;
          pages.push(...found);
        }
        return pages;
      } catch {
        return null;
      }
    },

    owner: async () => {
      const login = await deps.viewerLogin().catch(() => null);
      return login ? { actor: "owner", login } : null;
    },
  };
}
