// The stages that run as real agents in a sandbox: Triage (read-only) and Implementer.
import type { TaskState } from "@hardness/contracts";
import { join } from "node:path";

import type { ApprovalRow } from "../db/entities.ts";
import {
  type Workspace,
  commitAll,
  commonGitDir,
  diffNameStatus,
  ensureWorktree,
  headCommit,
  resetWorktree,
  workspaceFor,
} from "../git/worktree.ts";
import type { Watcher } from "../herdr/watch.ts";
import type { Credential } from "../sandbox/credentials.ts";
import { runSandbox } from "../sandbox/docker.ts";
import { lockedFilesTouched } from "./locked-files.ts";
import type { StageContext, StageResult, StageRunner } from "./runner.ts";

export interface AgentDeps {
  image: string;
  credential: Credential;
  worktreesDir: string;
  stateDir: string;
  watcher: Watcher;
}

interface AgentStage {
  tools: string[];
  writable: boolean;
  maxTurns: number;
  timeoutMs: number;
  /** JSON Schema the agent's final answer must match. */
  schema: Record<string, unknown>;
  prompt(context: StageContext, workspace: Workspace): string;
  /** Turns the agent's structured answer into a stage result. */
  finish(
    answer: Record<string, unknown>,
    context: StageContext,
    workspace: Workspace,
    inputCommit: string,
  ): Promise<StageResult>;
}

const MINUTE = 60_000;

const bullets = (items: unknown) =>
  Array.isArray(items) && items.length > 0 ? items.map((item) => `- ${String(item)}`).join("\n") : "(none)";

/** What you decided earlier on this task, as prompt context. */
function history(approvals: ApprovalRow[]): string {
  const lines: string[] = [];
  for (const approval of approvals) {
    if (approval.decision === "answered") {
      const answers = (approval.response?.answers ?? {}) as Record<string, string>;
      for (const [question, answer] of Object.entries(answers)) lines.push(`- Q: ${question}\n  A: ${answer}`);
    } else if (approval.reason) {
      const what = approval.decision === "sent_back" ? "sent back" : "guidance";
      lines.push(`- ${what} at ${approval.kind}: ${approval.reason}`);
    }
  }
  return lines.length > 0 ? `\nWhat the user decided so far:\n${lines.join("\n")}\n` : "";
}

/** The brief you approved at the plan gate, written by triage. */
function approvedPlan(approvals: ApprovalRow[]): Record<string, unknown> {
  const plan = approvals.findLast((a) => a.kind === "awaiting_approval" && a.decision === "approved");
  return plan?.requested ?? {};
}

const triage: AgentStage = {
  tools: ["Read", "Glob", "Grep"],
  writable: false,
  maxTurns: 30,
  timeoutMs: 10 * MINUTE,
  schema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["brief", "questions"] },
      summary: { type: "string", description: "The plan: what to change, where, and how to check it." },
      criteria: { type: "array", items: { type: "string" } },
      assumptions: { type: "array", items: { type: "string" } },
      questions: {
        type: "array",
        items: {
          type: "object",
          properties: { question: { type: "string" }, recommended: { type: "string" } },
          required: ["question", "recommended"],
        },
      },
    },
    required: ["kind", "summary"],
  },
  prompt: ({ task, approvals }) => `You are the triage stage of a development pipeline. The repository is at /work and is read-only for you.

Ticket: ${task.title}
Description: ${task.description || "(none)"}
Acceptance criteria from the ticket:
${bullets(task.criteria)}
${history(approvals)}
Read enough of the repository to know where this change belongs and how it can be tested. Then answer with one of:
- kind "brief": summary is a short plan (what to change, in which files, how to check it); criteria are the acceptance criteria to build and verify, refined from the ticket; assumptions lists anything you assumed.
- kind "questions": only when no reasonable default exists. Up to 3 questions, each with your recommended answer. Still give a one-line summary.
Prefer a brief with stated assumptions over asking.`,
  finish: async (answer) => {
    const questions = Array.isArray(answer.questions) ? answer.questions : [];
    if (answer.kind === "questions" && questions.length > 0) {
      return { outcome: "needs_input", detail: { summary: answer.summary, questions } };
    }
    return {
      outcome: "pass",
      detail: {
        brief: answer.summary,
        criteria: answer.criteria ?? [],
        assumptions: answer.assumptions ?? [],
      },
    };
  },
};

const implementer: AgentStage = {
  tools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep"],
  writable: true,
  maxTurns: 80,
  timeoutMs: 30 * MINUTE,
  schema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["done", "test_change"] },
      summary: { type: "string", description: "What you changed and how you checked it." },
      request: { type: "string", description: "For test_change: which test is wrong and why." },
    },
    required: ["kind", "summary"],
  },
  prompt: ({ task, approvals, attempt }, workspace) => {
    const plan = approvedPlan(approvals);
    const criteria = Array.isArray(plan.criteria) && plan.criteria.length > 0 ? plan.criteria : task.criteria;
    return `You are the implementer stage of a development pipeline. The repository at /work is a git worktree on branch ${workspace.branch}. Change files there. Do not commit: the pipeline commits your changes when you finish.

Ticket: ${task.title}
Description: ${task.description || "(none)"}
Approved plan:
${typeof plan.brief === "string" ? plan.brief : "(no plan recorded)"}
Acceptance criteria:
${bullets(criteria)}
Assumptions:
${bullets(plan.assumptions)}
${history(approvals)}${attempt > 1 ? `\nThis is attempt ${attempt}; earlier attempts did not pass. Check the current state of the files before changing them.\n` : ""}
Make the smallest change that meets the criteria, and run the project's tests if it has any. Then answer kind "done" with a summary. If a test you were given is wrong and blocks you, answer kind "test_change" with the request instead of editing that test.`;
  },
  finish: async (answer, { task }, workspace, inputCommit) => {
    if (answer.kind === "test_change") {
      return { outcome: "test_change", detail: { request: answer.request ?? answer.summary } };
    }
    const summary = String(answer.summary ?? "");
    const commit = await commitAll(workspace.path, `${task.title}\n\n${summary}`.trim());
    if (commit) {
      const diff = await diffNameStatus(workspace.path, inputCommit, commit);
      const locked = lockedFilesTouched(diff);
      if (locked.length > 0) {
        return {
          outcome: "fail",
          detail: { error: `modified existing test file(s) without a test_change request: ${locked.join(", ")}` },
        };
      }
    }
    return {
      outcome: "pass",
      detail: { summary, commit },
      run: commit ? { outputCommit: commit } : {},
    };
  },
};

async function runAgent(deps: AgentDeps, context: StageContext, stage: AgentStage): Promise<StageResult> {
  const { task } = context;
  if (!task.repoPath) {
    throw new Error("the task has no repoPath; create it with a repo to run real stages");
  }
  const workspace: Workspace =
    task.branch && task.worktreePath
      ? { branch: task.branch, path: task.worktreePath }
      : workspaceFor(task, task.repoPath, deps.worktreesDir);
  await ensureWorktree(task.repoPath, workspace);
  const inputCommit = await headCommit(workspace.path);
  const container = `hardness-${task.id.slice(0, 8)}-${context.stage.replaceAll("_", "-")}-${context.attempt}`;

  const sandbox = await runSandbox({
    name: container,
    image: deps.image,
    runDir: join(deps.stateDir, "runs", context.runId),
    worktree: workspace.path,
    writable: stage.writable,
    gitDir: await commonGitDir(task.repoPath),
    input: {
      stage: context.stage,
      attempt: context.attempt,
      prompt: stage.prompt(context, workspace),
      tools: stage.tools,
      maxTurns: stage.maxTurns,
      schema: stage.schema,
    },
    timeoutMs: stage.timeoutMs,
    credential: deps.credential,
    labels: { "dev.hardness.task": task.id },
    signal: context.signal,
    onStarted: (name) =>
      void deps.watcher.follow(task.id, `#${task.id.slice(0, 8)} ${task.title}`, workspace.path, name),
  });

  const base: StageResult = {
    outcome: "fail",
    workspace: { branch: workspace.branch, worktreePath: workspace.path },
    run: { containerId: container, transcriptPath: sandbox.transcriptPath, inputCommit },
  };
  // However this run ends without a clean, committed answer, the next attempt should not
  // inherit whatever it left half-edited on disk.
  const dirty = async <T>(result: T): Promise<T> => {
    if (stage.writable) await resetWorktree(workspace.path);
    return result;
  };
  const failed = (error: string): Promise<StageResult> => dirty({ ...base, detail: { error } });
  const out = sandbox.output;

  if (out?.rateLimited) return dirty({ ...base, rateLimited: true, detail: { resetsAt: out.resetsAt } });
  if (sandbox.aborted) return failed("aborted");
  if (sandbox.timedOut) return failed(`timed out after ${stage.timeoutMs / MINUTE} minutes`);
  if (!out) return failed(`the container left no result (exit code ${sandbox.exitCode}); see the transcript`);
  if (!out.ok || typeof out.structured !== "object" || out.structured === null) {
    return failed(out.error ?? "the agent gave no structured answer");
  }

  const result = await stage.finish(out.structured as Record<string, unknown>, context, workspace, inputCommit);
  return {
    ...base,
    ...result,
    run: { ...base.run, ...result.run },
    detail: { ...result.detail, turns: out.turns, costUsd: out.costUsd },
  };
}

/** Runners for the stages that are real so far. Every other stage stays a stub. */
export function agentRunners(deps: AgentDeps): Partial<Record<TaskState, StageRunner>> {
  return {
    triage: (context) => runAgent(deps, context, triage),
    implementing: (context) => runAgent(deps, context, implementer),
  };
}
