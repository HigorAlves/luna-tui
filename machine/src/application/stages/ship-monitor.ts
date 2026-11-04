// The ship monitor: after Ship publishes the pack and readies the PR, this watches the task's own
// PR until it merges. Each poll reads GitHub's facts, the Evidence Pack and the policy; merge
// readiness is a script (domain/merge-readiness.ts), and the merge is sha-guarded and never above
// the policy's risk. A PR a person merges ends the wait the same way. The cursor file lets a
// machine restart resume instead of escalate. Review activity and a red CI are recorded and noted
// here; acting on them is the maintenance loop's.
import type { EvidencePack, Risk } from "@hardness/contracts";

import { type Policy } from "../../domain/policy.ts";
import { ownerApprovals, parseCodeownersChecked, requiredOwners } from "../../domain/codeowners.ts";
import { MAX_DEPENDENCIES, mergeReadiness, parseDependencies } from "../../domain/merge-readiness.ts";
import { fromGraphQl } from "../../domain/pull-request.ts";
import { type GitHub, messageOf } from "../github.ts";
import type { StageContext, StageResult } from "../ports.ts";
import { type ShipCursor, SEEN_CAP, emptyCursor, loadCursor, saveCursor } from "../ship-cursor.ts";

const DAY_MS = 86_400_000;
/** Where GitHub reads CODEOWNERS; the monitor reads it at the PR's base branch, never from the PR's own head or the worktree. */
export const CODEOWNERS_PATHS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];
/** A team's members are asked again after this long: a member removed from the team stops counting. */
const TEAM_TTL_MS = 10 * 60_000;

export interface ShipMonitorDeps {
  github: GitHub;
  policies: { for: (repoPath: string | null) => Promise<Policy> };
  evidence: { load: (taskId: string) => Promise<EvidencePack | null> };
  stateDir: string;
  pollMs: number;
  /** The longest the monitor waits for a merge before asking a person (default 14 days). */
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** The CODEOWNERS text at the PR's base branch, or null; default: the first of the three places the port finds. Tests inject one. */
  readCodeowners?: (slug: string, baseRef: string) => Promise<string | null>;
  log?: (message: string) => void;
}

export type ShipMonitor = (context: StageContext, pr: { slug: string; number: number; url: string }) => Promise<StageResult>;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function shipMonitor(deps: ShipMonitorDeps): ShipMonitor {
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? (() => new Date());
  const maxWaitMs = deps.maxWaitMs ?? 14 * DAY_MS;
  const readCodeowners =
    deps.readCodeowners ??
    (async (slug: string, baseRef: string) => {
      for (const path of CODEOWNERS_PATHS) {
        const text = await deps.github.fileAtRef(slug, baseRef, path);
        if (text !== null) return text;
      }
      return null;
    });

  return async (context, ref) => {
    // Per run, so a member removed from a team stops counting after the TTL.
    const teamCache = new Map<string, { at: number; members: string[] | null }>();
    const { task, signal } = context;
    const { slug, number, url } = ref;
    const note = async (text: string) => {
      deps.log?.(text);
      await context.note?.(text).catch(() => {});
    };
    let cursor: ShipCursor = (await loadCursor(deps.stateDir, task.id)) ?? emptyCursor({ slug, number });
    if (cursor.pr.slug !== slug || cursor.pr.number !== number) cursor = { ...emptyCursor({ slug, number }), published: cursor.published };
    cursor.startedAt ??= now().toISOString();
    await saveCursor(deps.stateDir, task.id, cursor);
    let mergeErrors = 0;

    /** What the repo's CODEOWNERS still wants: null when it has none. A team the token cannot read stays unresolved. */
    const ownersOf = async (head: string | null, baseRef: string, paths: string[]) => {
      const text = await readCodeowners(slug, baseRef);
      if (!text) return null;
      const { rules, problems } = parseCodeownersChecked(text);
      const required = requiredOwners(paths, rules);
      if (required.length === 0) return { missing: [], unresolved: problems };
      const reviews = await deps.github.prReviews(slug, number);
      const latest = new Map<string, (typeof reviews)[number]>();
      for (const r of reviews) if (r.author && (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED" || r.state === "DISMISSED")) latest.set(r.author.toLowerCase(), r);
      const approvers = [...latest.values()].filter((r) => r.state === "APPROVED" && (r.commitId === null || head === null || r.commitId === head)).map((r) => r.author!);
      const members: Record<string, string[]> = {};
      for (const team of new Set(required.flatMap((r) => r.owners).filter((o) => o.startsWith("@") && o.includes("/")).map((o) => o.slice(1).toLowerCase()))) {
        const cached = teamCache.get(team);
        if (!cached || now().getTime() - cached.at > TEAM_TTL_MS) {
          const [org = "", slugOfTeam = ""] = team.split("/");
          teamCache.set(team, { at: now().getTime(), members: await deps.github.teamMembers(org, slugOfTeam).catch(() => null) });
        }
        const list = teamCache.get(team)!.members;
        if (list) members[team] = list;
      }
      const out = ownerApprovals(required, { approvers, members });
      return { missing: out.missing, unresolved: [...out.unresolved, ...problems] };
    };

    for (;;) {
      if (signal.aborted) return { outcome: "fail", detail: { error: "aborted" } };
      if (now().getTime() - Date.parse(cursor.startedAt!) > maxWaitMs) {
        const days = Math.round(maxWaitMs / DAY_MS);
        return { outcome: "escalated", detail: { escalation: "other", reason: `the PR has waited ${days} days`, options: [] } };
      }
      try {
        const state = await deps.github.prMerged(slug, number);
        if (state.merged) {
          return { outcome: "pass", detail: { merged: { sha: state.mergedSha, at: state.mergedAt, by: cursor.mergeRequested || cursor.queued ? "machine" : "person" }, prUrl: url, number } };
        }
        if (state.state === "closed") {
          return { outcome: "escalated", detail: { escalation: "other", reason: "the PR was closed without a merge", options: [] } };
        }
        const node = await deps.github.prFacts(slug, number);
        if (!node) {
          await note("GitHub shows no such PR right now; waiting");
        } else {
          const pr = fromGraphQl(node, slug, "", []);
          const head = pr.headSha ?? (await deps.github.prHeadSha(slug, number));
          const pack = await deps.evidence.load(task.id);
          if (pack && head && pack.commitSha !== head) {
            return {
              outcome: "escalated",
              detail: { escalation: "head_moved", reason: `the PR head moved after the evidence pack (${pack.commitSha.slice(0, 7)} → ${head.slice(0, 7)}): Evidence runs again`, options: [] },
            };
          }
          const policy = await deps.policies.for(task.repoPath);
          // No pack fails closed: the highest risk, and the readiness script names the missing pack.
          const risk: Risk = pack?.risk ?? "high";
          const approver = context.approvals.findLast((a) => a.kind === "awaiting_ship" && a.decision === "approved")?.response?.approver;
          const listed = parseDependencies(pr.body);
          const dependencies = await Promise.all(
            listed.slice(0, MAX_DEPENDENCIES).map(async (n) => {
              const dep = await deps.github.prMerged(slug, n).catch(() => null);
              return { number: n, merged: dep?.merged ?? false, closed: dep ? dep.state === "closed" : false };
            }),
          );
          const paths = (await deps.github.prFiles(slug, number)).map((f) => f.path);
          const changesCodeowners = paths.some((p) => CODEOWNERS_PATHS.includes(p));
          const owners = await ownersOf(head, pr.baseRef, paths).catch((error: unknown) => ({ missing: [], unresolved: [`CODEOWNERS could not be checked: ${messageOf(error)}`] }));
          const readiness = mergeReadiness({
            pr,
            packSha: pack?.commitSha ?? null,
            policy: { autoMerge: policy.autoMerge, freeze: policy.freeze },
            risk,
            shipApprover: risk === "high" && typeof approver === "string" && approver ? approver : null,
            now: now(),
            dependencies,
            owners,
            changesCodeowners,
            dependenciesListed: listed.length,
          });

          // Review activity: recorded (and noted) here; the maintenance loop acts on it.
          const activity = (await deps.github.prActivity(slug, number, cursor.since).catch(() => [])).filter((a) => !cursor.seen.includes(a.id));
          if (activity.length > 0) {
            cursor.seen = [...cursor.seen, ...activity.map((a) => a.id)].slice(-SEEN_CAP);
            cursor.since = activity.at(-1)!.at || cursor.since;
            await note(`${activity.length} new item${activity.length === 1 ? "" : "s"} on the PR: ${activity.map((a) => `${a.actor ?? "ghost"} ${a.kind}`).join(", ")}`);
          }

          if (cursor.queued) {
            // In the merge queue: the queue merges it. Asking again would only race it.
          } else if (readiness.canAutoMerge && head) {
            try {
              cursor.mergeRequested = true;
              await saveCursor(deps.stateDir, task.id, cursor);
              const result = await deps.github.mergePr(slug, number, { sha: head });
              mergeErrors = 0;
              if (result && "queued" in result) {
                cursor.queued = true;
                await note("the PR is in the merge queue");
              }
              else return { outcome: "pass", detail: { merged: { sha: head, at: now().toISOString(), by: "machine" }, prUrl: url, number } };
            } catch (error) {
              cursor.mergeRequested = false;
              mergeErrors++;
              await note(`the merge failed: ${messageOf(error)}`);
              if (mergeErrors >= 2) {
                return { outcome: "escalated", detail: { escalation: "other", reason: `the merge failed twice: ${messageOf(error)}`, options: [] } };
              }
            }
          } else if (!readiness.ready) {
            const text = readiness.blockers.join("; ");
            if (text !== cursor.lastBlockers) {
              cursor.lastBlockers = text;
              await note(`waiting: ${text}`);
            }
          } else if (cursor.lastBlockers !== readiness.reason) {
            cursor.lastBlockers = readiness.reason;
            await note(readiness.reason);
          }
          await saveCursor(deps.stateDir, task.id, cursor);
        }
      } catch (error) {
        await note(`could not read the PR: ${messageOf(error)}`);
      }
      await sleep(deps.pollMs);
    }
  };
}
