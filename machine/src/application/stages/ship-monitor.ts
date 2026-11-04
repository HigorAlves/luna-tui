// The ship monitor: after Ship publishes the pack and readies the PR, this watches the task's own
// PR until it merges. Each poll reads GitHub's facts, the Evidence Pack and the policy; merge
// readiness is a script (domain/merge-readiness.ts), and the merge is sha-guarded and never above
// the policy's risk. A PR a person merges ends the wait the same way. The cursor file lets a
// machine restart resume instead of escalate. Review activity and a red CI are recorded and noted
// here; acting on them is the maintenance loop's.
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import type { EvidencePack, Risk } from "@hardness/contracts";

import { type Policy } from "../../domain/policy.ts";
import { ownerApprovals, parseCodeowners, requiredOwners } from "../../domain/codeowners.ts";
import { mergeReadiness, parseDependencies } from "../../domain/merge-readiness.ts";
import { fromGraphQl } from "../../domain/pull-request.ts";
import { type GitHub, messageOf } from "../github.ts";
import type { StageContext, StageResult } from "../ports.ts";
import { type ShipCursor, SEEN_CAP, emptyCursor, loadCursor, saveCursor } from "../ship-cursor.ts";

const DAY_MS = 86_400_000;
/** CODEOWNERS is read from the worktree at one of these places; a file over this size is not read. */
const CODEOWNERS_PATHS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];
const CODEOWNERS_MAX_BYTES = 256 * 1024;

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
  /** The CODEOWNERS text of a worktree, or null; tests inject one. */
  readCodeowners?: (worktreePath: string) => Promise<string | null>;
  log?: (message: string) => void;
}

export type ShipMonitor = (context: StageContext, pr: { slug: string; number: number; url: string }) => Promise<StageResult>;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The repo's CODEOWNERS as text: a regular file under 256 KB at one of the three places GitHub reads. */
export async function readCodeownersFile(worktreePath: string): Promise<string | null> {
  for (const path of CODEOWNERS_PATHS) {
    const file = join(worktreePath, path);
    try {
      const info = await stat(file);
      if (!info.isFile() || info.size > CODEOWNERS_MAX_BYTES) continue;
      return await readFile(file, "utf8");
    } catch {
      // not there: the next place
    }
  }
  return null;
}

export function shipMonitor(deps: ShipMonitorDeps): ShipMonitor {
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? (() => new Date());
  const maxWaitMs = deps.maxWaitMs ?? 14 * DAY_MS;
  const readCodeowners = deps.readCodeowners ?? readCodeownersFile;
  const teamCache = new Map<string, string[] | null>();

  return async (context, ref) => {
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
    const ownersOf = async (head: string | null) => {
      const text = task.worktreePath ? await readCodeowners(task.worktreePath).catch(() => null) : null;
      if (!text) return null;
      const rules = parseCodeowners(text);
      const files = await deps.github.prFiles(slug, number);
      const required = requiredOwners(files.map((f) => f.path), rules);
      if (required.length === 0) return { missing: [], unresolved: [] };
      const reviews = await deps.github.prReviews(slug, number);
      const latest = new Map<string, (typeof reviews)[number]>();
      for (const r of reviews) if (r.author && (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED" || r.state === "DISMISSED")) latest.set(r.author.toLowerCase(), r);
      const approvers = [...latest.values()].filter((r) => r.state === "APPROVED" && (r.commitId === null || head === null || r.commitId === head)).map((r) => r.author!);
      const members: Record<string, string[]> = {};
      for (const team of new Set(required.flatMap((r) => r.owners).filter((o) => o.startsWith("@") && o.includes("/")).map((o) => o.slice(1).toLowerCase()))) {
        if (!teamCache.has(team)) {
          const [org = "", slugOfTeam = ""] = team.split("/");
          teamCache.set(team, await deps.github.teamMembers(org, slugOfTeam).catch(() => null));
        }
        const list = teamCache.get(team);
        if (list) members[team] = list;
      }
      const out = ownerApprovals(required, { approvers, members });
      return { missing: out.missing, unresolved: out.unresolved };
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
          return { outcome: "pass", detail: { merged: { sha: state.mergedSha, at: state.mergedAt, by: cursor.mergeRequested ? "machine" : "person" }, prUrl: url, number } };
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
          const risk: Risk = pack?.risk ?? "medium";
          const approver = context.approvals.findLast((a) => a.kind === "awaiting_ship" && a.decision === "approved")?.response?.approver;
          const dependencies = await Promise.all(
            parseDependencies(pr.body).map(async (n) => {
              const dep = await deps.github.prMerged(slug, n).catch(() => null);
              return { number: n, merged: dep?.merged ?? false, closed: dep ? dep.state === "closed" : false };
            }),
          );
          const owners = await ownersOf(head).catch((error: unknown) => ({ missing: [], unresolved: [`CODEOWNERS could not be checked: ${messageOf(error)}`] }));
          const readiness = mergeReadiness({
            pr,
            packSha: pack?.commitSha ?? null,
            policy: { autoMerge: policy.autoMerge, freeze: policy.freeze },
            risk,
            shipApprover: risk === "high" && typeof approver === "string" && approver ? approver : null,
            now: now(),
            dependencies,
            owners,
          });

          // Review activity: recorded (and noted) here; the maintenance loop acts on it.
          const activity = (await deps.github.prActivity(slug, number, cursor.since).catch(() => [])).filter((a) => !cursor.seen.includes(a.id));
          if (activity.length > 0) {
            cursor.seen = [...cursor.seen, ...activity.map((a) => a.id)].slice(-SEEN_CAP);
            cursor.since = activity.at(-1)!.at || cursor.since;
            await note(`${activity.length} new item${activity.length === 1 ? "" : "s"} on the PR: ${activity.map((a) => `${a.actor ?? "ghost"} ${a.kind}`).join(", ")}`);
          }

          if (readiness.canAutoMerge && head) {
            try {
              cursor.mergeRequested = true;
              await saveCursor(deps.stateDir, task.id, cursor);
              const result = await deps.github.mergePr(slug, number, { sha: head });
              mergeErrors = 0;
              if (result && "queued" in result) await note("the PR is in the merge queue");
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
