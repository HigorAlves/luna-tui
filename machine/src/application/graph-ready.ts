// A card does not plan without its repository's code graph. When a card reaches triage or the plan stage for a repository whose graph
// is on, and the repository has no usable graph (none, built by another Graphify, or further behind than `graph.stale_commits`), the
// machine builds it and the stage waits, up to `graph.first_build_minutes`. A build that fails is retried once; a second failure is
// the caller's to escalate as an environment problem, with the reason. A person can let the card go on without a graph.
import { FACTORY_DEFAULTS } from "@hardness/contracts";

import { safe } from "../domain/evidence-markdown.ts";
import type { ApprovalRow } from "../domain/task.ts";
import type { Graph } from "./graph.ts";

export interface GraphReadyDeps {
  graph: Pick<Graph, "stampOf" | "build" | "isFresh"> & { behind?: (repoPath: string, commit: string) => Promise<number | null> };
  policies: { for(repoPath: string): Promise<{ graph?: boolean; factory?: { graph?: { stale_commits?: number; first_build_minutes?: number } } }> };
}

export type GraphReadiness = { state: "ready" } | { state: "off" } | { state: "skipped" } | { state: "failed"; reason: string };

const REASON_CAP = 400;

/** Cards waiting for one repository's graph wait for the same build and share its retry. The graph adapter itself runs one build per repository
 *  whoever asks (the watch and a rebuild on merge included); this map only keeps two cards from each starting their own wait. The entry goes when it settles. */
const inflight = new Map<string, Promise<unknown>>();
function buildOnce(deps: GraphReadyDeps, repoPath: string, signal: AbortSignal): Promise<unknown> {
  const running = inflight.get(repoPath);
  if (running) return running;
  const started = deps.graph.build(repoPath, signal);
  const entry = started.finally(() => {
    if (inflight.get(repoPath) === entry) inflight.delete(repoPath);
  });
  entry.catch(() => undefined);
  inflight.set(repoPath, entry);
  return entry;
}

/** A person's word on an escalated card: an approval whose response says `{ "graph": "skip" }` lets the card go on without a graph. */
export const graphSkipped = (approvals: readonly Pick<ApprovalRow, "response">[]): boolean => approvals.some((a) => a.response?.graph === "skip");

const flat = (text: string): string => {
  const one = safe(text);
  return one.length > REASON_CAP ? `${one.slice(0, REASON_CAP)}...` : one;
};

export async function ensureGraphReady(
  deps: GraphReadyDeps,
  input: { repoPath: string; signal: AbortSignal; skip: boolean; note?: (text: string) => Promise<void>; firstBuildMinutes?: number },
): Promise<GraphReadiness> {
  const policy = await deps.policies.for(input.repoPath);
  if (policy.graph === false) return { state: "off" };
  const bar = policy.factory?.graph?.stale_commits ?? FACTORY_DEFAULTS.graph.stale_commits;
  const minutes = input.firstBuildMinutes ?? policy.factory?.graph?.first_build_minutes ?? FACTORY_DEFAULTS.graph.first_build_minutes;

  const stamp = await deps.graph.stampOf(input.repoPath);
  let reason: string | null = null;
  if (!stamp) reason = "has no code graph yet";
  else if (!(await deps.graph.isFresh(input.repoPath, stamp, stamp.commit))) reason = "has a code graph built by another Graphify";
  else {
    const behind = await deps.graph.behind?.(input.repoPath, stamp.commit).catch(() => null);
    if (behind !== null && behind !== undefined && behind > bar) reason = `has a code graph ${behind} commits behind (more than ${bar})`;
  }
  if (reason === null) return { state: "ready" };
  if (input.skip) return { state: "skipped" };

  await input.note?.(`waiting for the code graph: the repository ${reason}; it is being built (up to ${minutes} minutes)`).catch(() => {});
  let last = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const inner = new AbortController();
    const stop = () => inner.abort();
    input.signal.addEventListener("abort", stop, { once: true });
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          inner.abort();
          reject(new Error(`the build did not finish in ${minutes} minutes`));
        }, minutes * 60_000);
      });
      await Promise.race([buildOnce(deps, input.repoPath, inner.signal), timeout]);
      await input.note?.("the code graph is built").catch(() => {});
      return { state: "ready" };
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
      if (input.signal.aborted) return { state: "failed", reason: "the card was stopped while it waited for the graph" };
      if (/did not finish in/.test(last)) {
        inflight.delete(input.repoPath); // a build that outlived its limit does not hold the repository: the next caller starts afresh
        return { state: "failed", reason: flat(last) };
      }
    } finally {
      clearTimeout(timer);
      input.signal.removeEventListener("abort", stop);
    }
  }
  return { state: "failed", reason: flat(`the code graph could not be built twice: ${last}`) };
}

/** The escalation a failed graph is: an environment problem, with the reason and how to go on. */
export const graphEscalation = (reason: string) => ({
  outcome: "escalated" as const,
  detail: {
    escalation: "env_broken",
    envBroken: true,
    step: "graph",
    reason: `the repository's code graph could not be built: ${reason}`,
    options: ['fix the build and resume, or approve with the response {"graph":"skip"} to let the card go on without a graph (the gate then says so)'],
  },
});
