// The address PR task: the host fetches the unresolved review threads on your PR, the
// implementer answers each with a commit and a reply, and after the project's checks pass the
// follow-up runner (the route's `delivering`) pushes, posts the replies and resolves the
// threads the agent marked. A thread someone resolved meanwhile is skipped, not re-opened.
import { PrAddressAnswer, type ThreadsContext } from "@hardness/contracts";

import { type GitHub, messageOf } from "../github.ts";
import type { StageContext, StageResult, StageRunner } from "../ports.ts";
import { type ExecFn, pushBranch } from "./deliver.ts";
import { gatherPr, prOf } from "./pr-review.ts";

export interface PrAddressDeps {
  github: GitHub;
  /** Runs the addressing pack with the threads the host fetched. */
  runPack: (context: StageContext, threads: ThreadsContext) => Promise<StageResult>;
}

export function prAddressRunner(deps: PrAddressDeps): StageRunner {
  const { github } = deps;
  return async (context) => {
    const pr = prOf(context);
    if (!pr) return { outcome: "fail", detail: { error: "not a PR task" } };
    let threads: ThreadsContext;
    try {
      const [facts, open] = await Promise.all([gatherPr(github, pr.repo, pr.number), github.prThreads(pr.repo, pr.number)]);
      threads = { pr: facts, threads: open };
    } catch (error) {
      return { outcome: "fail", detail: { error: messageOf(error) } };
    }
    if (threads.threads.length === 0) return { outcome: "fail", detail: { error: `${pr.repo}#${pr.number} has no unresolved review threads` } };
    return deps.runPack(context, threads);
  };
}

export interface FollowUpDeps {
  github: GitHub;
  exec: ExecFn;
  /** The latest addressing run's answer for the task, where the replies live. */
  latestAnswer: (taskId: string) => Promise<unknown>;
}

/** The address route's `delivering`: push, then reply to and resolve the threads. */
export function prFollowUpRunner(deps: FollowUpDeps): StageRunner {
  const { github } = deps;
  return async (context) => {
    const { task } = context;
    const pr = prOf(context);
    if (!pr || !task.branch || !task.worktreePath) return { outcome: "fail", detail: { error: "not a PR task with a worktree" } };
    const pushError = await pushBranch(deps.exec, task.branch, task.worktreePath);
    if (pushError) return { outcome: "fail", detail: { error: pushError } };

    const parsed = PrAddressAnswer.safeParse(await deps.latestAnswer(task.id));
    const replies = parsed.success ? parsed.data.replies : [];
    let replied = 0;
    let resolved = 0;
    const skipped: string[] = [];
    for (const reply of replies) {
      if (await github.threadResolved(reply.threadId)) {
        skipped.push(reply.threadId);
        continue;
      }
      try {
        await github.replyToThread(reply.threadId, reply.body);
      } catch (error) {
        return { outcome: "fail", detail: { error: `reply to thread ${reply.threadId} failed: ${messageOf(error)}`, replied, resolved, skipped } };
      }
      replied++;
      if (!reply.resolve) continue;
      try {
        await github.resolveThread(reply.threadId);
      } catch (error) {
        return { outcome: "fail", detail: { error: `resolving thread ${reply.threadId} failed: ${messageOf(error)}`, replied, resolved, skipped } };
      }
      resolved++;
    }
    return {
      outcome: "pass",
      detail: { prUrl: pr.url, replied, resolved, skipped, ...(parsed.success ? {} : { note: "no addressing answer to reply from" }) },
      events: [{ at: new Date().toISOString(), kind: "pr.followed_up", payload: { url: pr.url, replied, resolved, skipped } }],
    };
  };
}
