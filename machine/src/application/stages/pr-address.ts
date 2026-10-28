// The address PR task: the host fetches the unresolved review threads on your PR, the
// implementer answers each with a commit and a reply, and after the project's checks pass the
// follow-up runner (the route's `delivering`) pushes, posts the replies and resolves the
// threads the agent marked. A thread someone resolved meanwhile is skipped, not re-opened.
import { PrAddressAnswer, type ThreadsContext } from "@hardness/contracts";

import { type ExecFn, type Gh, defaultGh, prThreads, pushBranch, replyToThread, resolveThread, threadResolved } from "../../adapters/github/gh.ts";
import type { StageContext, StageResult, StageRunner } from "../ports.ts";
import { gatherPr, prOf } from "./pr-review.ts";

export interface PrAddressDeps {
  gh?: Gh;
  /** Runs the addressing pack with the threads the host fetched. */
  runPack: (context: StageContext, threads: ThreadsContext) => Promise<StageResult>;
}

export function prAddressRunner(deps: PrAddressDeps): StageRunner {
  const gh = deps.gh ?? defaultGh;
  return async (context) => {
    const pr = prOf(context);
    if (!pr) return { outcome: "fail", detail: { error: "not a PR task" } };
    let threads: ThreadsContext;
    try {
      const [facts, open] = await Promise.all([gatherPr(gh, pr.repo, pr.number), prThreads(gh, pr.repo, pr.number)]);
      threads = { pr: facts, threads: open };
    } catch (error) {
      return { outcome: "fail", detail: { error: error instanceof Error ? error.message : String(error) } };
    }
    if (threads.threads.length === 0) return { outcome: "fail", detail: { error: `${pr.repo}#${pr.number} has no unresolved review threads` } };
    return deps.runPack(context, threads);
  };
}

export interface FollowUpDeps {
  gh?: Gh;
  exec: ExecFn;
  /** The latest addressing run's answer for the task, where the replies live. */
  latestAnswer: (taskId: string) => Promise<unknown>;
}

/** The address route's `delivering`: push, then reply to and resolve the threads. */
export function prFollowUpRunner(deps: FollowUpDeps): StageRunner {
  const gh = deps.gh ?? defaultGh;
  return async (context) => {
    const { task } = context;
    const pr = prOf(context);
    if (!pr || !task.branch || !task.worktreePath) return { outcome: "fail", detail: { error: "not a PR task with a worktree" } };
    const pushError = await pushBranch({ exec: deps.exec }, task.branch, task.worktreePath);
    if (pushError) return { outcome: "fail", detail: { error: pushError } };

    const parsed = PrAddressAnswer.safeParse(await deps.latestAnswer(task.id));
    const replies = parsed.success ? parsed.data.replies : [];
    let replied = 0;
    let resolved = 0;
    const skipped: string[] = [];
    for (const reply of replies) {
      if (await threadResolved(gh, reply.threadId)) {
        skipped.push(reply.threadId);
        continue;
      }
      const replyError = await replyToThread(gh, reply.threadId, reply.body);
      if (replyError) return { outcome: "fail", detail: { error: `reply to thread ${reply.threadId} failed: ${replyError}`, replied, resolved, skipped } };
      replied++;
      if (!reply.resolve) continue;
      const resolveError = await resolveThread(gh, reply.threadId);
      if (resolveError) return { outcome: "fail", detail: { error: `resolving thread ${reply.threadId} failed: ${resolveError}`, replied, resolved, skipped } };
      resolved++;
    }
    return {
      outcome: "pass",
      detail: { prUrl: pr.url, replied, resolved, skipped, ...(parsed.success ? {} : { note: "no addressing answer to reply from" }) },
      events: [{ at: new Date().toISOString(), kind: "pr.followed_up", payload: { url: pr.url, replied, resolved, skipped } }],
    };
  };
}
