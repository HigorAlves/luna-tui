// Ground truth for the plan stage: when a person approves the plan, what the machine proposed and
// what they approved (with every edit between) is kept as one file, so a later eval can learn from
// what a person changed. It lives under the machine's state dir, never in the repo the task works
// on: the machine runs for any repository and writes nothing of its own into one.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { EvidencePack } from "@hardness/contracts";

import { safe } from "../domain/evidence-markdown.ts";
import type { ApprovalRow, TaskRow } from "../domain/task.ts";

const PLAN_KEYS = ["brief", "criteria", "assumptions", "slices", "rollback", "cases", "risk", "map"] as const;

type Plan = Partial<Record<(typeof PLAN_KEYS)[number], unknown>>;
type Revision = { at?: unknown; before?: Record<string, unknown>; after?: Record<string, unknown> };

const pick = (from: Record<string, unknown>): Plan => Object.fromEntries(PLAN_KEYS.filter((key) => from[key] !== undefined).map((key) => [key, from[key]]));

export interface GroundTruth {
  schema: 1;
  task: { id: string; title: string; description: string; criteria: string[] };
  record: unknown;
  /** The plan as the machine proposed it: the approved plan with every revision undone, latest first. */
  proposed: Plan;
  approved: Plan;
  revisions: unknown[];
  verdicts: unknown;
  risk: unknown;
  /** A person's override of the risk level or the code map, each with its reason; the risk override says whether it applied (a lower one is kept, not applied). */
  overrides: unknown;
  approvers: string[];
  decidedAt: string | null;
}

/** The record of one approved plan gate. Pure. */
export function groundTruthOf(task: TaskRow, approval: ApprovalRow): GroundTruth {
  const requested = approval.requested;
  const approved = pick(requested);
  const revisions = (Array.isArray(requested.revisions) ? requested.revisions : []) as Revision[];
  const proposed: Plan = { ...approved };
  for (const revision of [...revisions].reverse()) {
    for (const key of Object.keys(revision.after ?? {})) {
      if (revision.before && key in revision.before) (proposed as Record<string, unknown>)[key] = revision.before[key];
      else delete (proposed as Record<string, unknown>)[key];
    }
  }
  const response = approval.response ?? {};
  const named = Array.isArray(response.approvers) ? response.approvers.map(String) : typeof response.approver === "string" ? [response.approver] : [];
  return {
    schema: 1,
    task: { id: task.id, title: task.title, description: task.description, criteria: task.criteria },
    record: task.record ?? null,
    proposed,
    approved,
    revisions,
    verdicts: requested.verdicts ?? null,
    risk: requested.risk ?? null,
    overrides: requested.overrides ?? null,
    approvers: named,
    decidedAt: approval.decidedAt ? approval.decidedAt.toISOString() : null,
  };
}

/** Writes `<stateDir>/ground-truth/plan/<taskId>-<approvalId>.json` and answers its path. */
export function groundTruthWriter(stateDir: string): (task: TaskRow, approval: ApprovalRow) => Promise<string> {
  return async (task, approval) => {
    const dir = join(stateDir, "ground-truth", "plan");
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${task.id}-${approval.id}.json`);
    await writeFile(path, `${JSON.stringify(groundTruthOf(task, approval), null, 2)}\n`);
    return path;
  };
}

export interface CommitFact {
  sha: string;
  files: Array<{ path: string; added: number; removed: number }>;
}

/** What a person did after an escalation, kept beside the decision that labelled it: file names and counts, never content. */
export interface EscalationTruth {
  schema: 1;
  task: { id: string; title: string };
  decided: { reason: unknown; confidence: unknown; source: unknown; agentReason: unknown; recordId: unknown } | null;
  /** The reason a person corrected the decided one to (the enum only), or null. */
  corrected: string | null;
  commits: CommitFact[];
  escalatedAt: string;
  resumedAt: string | null;
}

/** The record of one escalated gate a person resumed. Pure. */
export function escalationTruthOf(task: TaskRow, approval: ApprovalRow, commits: readonly CommitFact[], corrected: string | null): EscalationTruth {
  const decision = (approval.requested.escalationDecision ?? null) as Record<string, unknown> | null;
  return {
    schema: 1,
    task: { id: task.id, title: task.title },
    decided: decision ? { reason: decision.reason ?? null, confidence: decision.confidence ?? null, source: decision.source ?? null, agentReason: decision.agentReason ?? null, recordId: decision.recordId ?? null } : null,
    corrected,
    commits: commits.map((c) => ({ sha: c.sha, files: c.files.map((f) => ({ path: f.path, added: f.added, removed: f.removed })) })),
    escalatedAt: approval.createdAt.toISOString(),
    resumedAt: approval.decidedAt ? approval.decidedAt.toISOString() : null,
  };
}

/** Writes `<stateDir>/ground-truth/escalation/<taskId>-<approvalId>.json` and answers its path. */
export function escalationTruthWriter(stateDir: string): (task: TaskRow, approval: ApprovalRow, commits: readonly CommitFact[], corrected: string | null) => Promise<string> {
  return async (task, approval, commits, corrected) => {
    const dir = join(stateDir, "ground-truth", "escalation");
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${task.id}-${approval.id}.json`);
    await writeFile(path, `${JSON.stringify(escalationTruthOf(task, approval, commits, corrected), null, 2)}\n`);
    return path;
  };
}

/** Writes `<stateDir>/ground-truth/ticket/<key>-<draft>-<at>.json`: what a person did to a ticket's draft (sent as drafted, edited with the text before and after, ignored). Answers its path. */
export function ticketTruthWriter(stateDir: string): (entry: { key: string; draft: string; kind: string; did: string; original: string; final: string | null; at: string }) => Promise<string> {
  return async (entry) => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const dir = join(stateDir, "ground-truth", "ticket");
    await mkdir(dir, { recursive: true });
    const safeName = `${entry.key}-${entry.draft}-${entry.at}`.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 160);
    const path = join(dir, `${safeName}.json`);
    await writeFile(path, `${JSON.stringify({ schema: 1, ...entry }, null, 2)}\n`);
    return path;
  };
}

export interface EvidenceFeedbackTruth {
  schema: 1;
  taskId: string;
  format: string;
  commit: string;
  revision: number | null;
  video: { verdict: string; scores: Record<string, number> } | null;
  useful: boolean;
  note: string | null;
  at: string;
}

const NOTE_CAP = 500;

/** What a person said about a pack, as one record. It labels no decision: a thumbs-down does not say which format would have been right. The note is flattened. */
export function evidenceFeedbackOf(task: TaskRow, pack: EvidencePack, feedback: { useful: boolean; note?: string | undefined }, at: Date): EvidenceFeedbackTruth {
  const note = feedback.note ? safe(feedback.note).slice(0, NOTE_CAP) : "";
  return {
    schema: 1,
    taskId: task.id,
    format: pack.format,
    commit: pack.commitSha,
    revision: pack.revision ?? null,
    video: pack.video ? { verdict: pack.video.verdict, scores: pack.video.scores } : null,
    useful: feedback.useful,
    note: note === "" ? null : note,
    at: at.toISOString(),
  };
}

/** Writes `<stateDir>/ground-truth/evidence/<taskId>-<sha 7>.json` (the last answer for a commit wins) and answers its path. */
export function evidenceFeedbackWriter(stateDir: string): (task: TaskRow, pack: EvidencePack, feedback: { useful: boolean; note?: string | undefined }, at: Date) => Promise<string> {
  return async (task, pack, feedback, at) => {
    const dir = join(stateDir, "ground-truth", "evidence");
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${task.id}-${pack.commitSha.slice(0, 7).replace(/[^A-Za-z0-9]/g, "_")}.json`);
    await writeFile(path, `${JSON.stringify(evidenceFeedbackOf(task, pack, feedback, at), null, 2)}\n`);
    return path;
  };
}
