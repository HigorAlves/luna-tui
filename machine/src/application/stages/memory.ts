// The reviewing_memory stage: the retro pack reads the task's ledger and runs from its stage
// input and `git log` in the worktree, and proposes additions to `docs/agents/project-context.md`. This wrapper shapes the approval's
// `requested.rules` from the pack's answer and the host copy of its `rules.md` artifact, and
// owns the merge that the close step applies when the proposal is approved.
import { readFile } from "node:fs/promises";

import { type DecisionOverrides, type Ledger, PACKS, type ShipContext, applyPolicy } from "@hardness/contracts";

import { recordIdOf } from "../decision-truth.ts";
import type { EventRow, TaskRow } from "../../domain/task.ts";
import type { StageContext, StageResult, StageRunner } from "../ports.ts";
import { postable } from "./ship-fixes.ts";

export const CONTEXT_FILE = "docs/agents/project-context.md";
export const CAP_LINES = 150;
export const CAP_BYTES = 6144;

/** The facts the retro compares: what was predicted and what happened, computed by the machine. */
export type RetroFacts = NonNullable<ShipContext["retro"]>;

export interface MemoryDeps {
  /** Runs the reviewing_memory pack; with `ship`, the retro facts ride in its input as `context.ship`. */
  runPack: (context: StageContext, ship?: ShipContext) => Promise<StageResult>;
  stateDir: string;
  /** The task's predicted-against-actual facts; absent or null, the retro runs without them and without the worth_learning question. */
  facts?: (taskId: string) => Promise<RetroFacts | null>;
  /** Runs worth_learning on a retro context; bound late (once PackRuns exists), null asks nothing. */
  decide?: ((pack: "worth_learning", ship: ShipContext, repoPath: string | null) => Promise<Record<string, unknown>>) | null;
  /** The repo's own confidence bars for worth_learning (luna.yaml `policy.decisions`). */
  overrides?: (repoPath: string | null) => Promise<DecisionOverrides | undefined>;
}

const answerOf = (detail: Record<string, unknown> | undefined): Record<string, unknown> => {
  const answer = detail?.answer;
  return answer && typeof answer === "object" ? (answer as Record<string, unknown>) : {};
};

const countOf = (value: unknown): number => (Array.isArray(value) ? value.length : 0);

/** One line of what the facts say, for the note of a retro that was not worth running. */
const factsLine = (facts: RetroFacts): string =>
  `${facts.actual.retries.total} retries, ${facts.actual.escalations} escalations, ${facts.actual.added + facts.actual.removed} lines changed against ${facts.predicted.estLoc ?? "an unknown number of"} planned`;

/** True only for a confident "no": a failed, unsure or missing decision never skips the retro. */
async function notWorthLearning(deps: MemoryDeps, ship: ShipContext, repoPath: string | null, record: { id?: string }): Promise<boolean> {
  const decide = deps.decide;
  if (!decide) return false;
  try {
    const answer = await decide("worth_learning", ship, repoPath);
    record.id = recordIdOf(answer);
    const overall = applyPolicy(PACKS.worth_learning, answer, await deps.overrides?.(repoPath)).overall;
    const worth = (answer.worth ?? {}) as { value?: unknown };
    return overall === "proceed" && worth.value === false;
  } catch {
    return false;
  }
}

export function memoryReviewRunner(deps: MemoryDeps): StageRunner {
  return async (context) => {
    const facts = deps.facts ? await deps.facts(context.task.id).catch(() => null) : null;
    const ship: ShipContext | undefined = facts ? { kind: "retro", retro: facts } : undefined;
    // A task with nothing surprising in it teaches nothing: the question comes before the expensive pack.
    const worth: { id?: string } = {};
    if (facts && ship && (await notWorthLearning(deps, ship, context.task.repoPath ?? null, worth))) {
      return { outcome: "pass", detail: { rules: null, note: `no retro: ${factsLine(facts)}` } };
    }
    const result = await deps.runPack(context, ship);
    if (result.outcome !== "pass") return result;

    const answer = answerOf(result.detail);
    const artifact = result.artifacts?.find((a) => a.kind === "rules");
    let markdown = "";
    if (artifact) {
      try {
        markdown = await readFile(artifact.path, "utf8");
      } catch {
        markdown = "";
      }
    }
    const learned = {
      ...(Array.isArray(answer.recalibration) ? { recalibration: answer.recalibration } : {}),
      ...(Array.isArray(answer.graphMisses) ? { graphMisses: answer.graphMisses } : {}),
      ...(Array.isArray(answer.promptUpdates) ? { promptUpdates: answer.promptUpdates } : {}),
      ...(Array.isArray(answer.proposals) ? { proposals: answer.proposals } : {}),
    };
    const hasLearned = Object.values(learned).some((v) => (v as unknown[]).length > 0);
    if (markdown.trim() === "" && !hasLearned) {
      return {
        ...result,
        detail: { ...result.detail, rules: null, note: "no rules proposed: nothing repeated enough to be a pattern" },
      };
    }
    return {
      ...result,
      detail: {
        ...result.detail,
        ...(worth.id ? { decisions: { worth_learning: worth.id } } : {}),
        rules: {
          markdown,
          proposedRules: Array.isArray(answer.proposedRules) ? answer.proposedRules : [],
          calibration: answer.calibration ?? null,
          incidents: countOf(answer.incidents),
          patterns: countOf(answer.patterns),
          ...learned,
        },
      },
    };
  };
}

const SECTIONS = [
  "Stack & versions",
  "Commands",
  "Critical rules",
  "Patterns to follow",
  "Patterns to avoid",
  "Known landmines",
];
const DEFAULT_SECTION = "Critical rules";

/** The rules in a proposal, keyed by section. Reads a fenced diff or a plain bullet list. */
export function parseRules(markdown: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  let section = DEFAULT_SECTION;
  for (const raw of markdown.split("\n")) {
    if (raw.startsWith("```") || raw.startsWith("+++") || raw.startsWith("---") || raw.startsWith("@@")) continue;
    const line = raw.startsWith("+") || raw.startsWith(" ") ? raw.slice(1) : raw;
    if (raw.startsWith("-") && !raw.startsWith("- ")) continue; // a removed diff line
    const heading = /^##\s+(.+?)\s*$/.exec(line.trim());
    if (heading) {
      const known = SECTIONS.find((s) => s.toLowerCase() === heading[1]!.toLowerCase());
      section = known ?? DEFAULT_SECTION;
      continue;
    }
    const bullet = /^[-*]\s+(.+?)\s*$/.exec(raw.startsWith("+") ? line : raw.trim());
    if (!bullet) continue;
    found.set(section, [...(found.get(section) ?? []), `- ${bullet[1]}`]);
  }
  return found;
}

const SKELETON = `# Project context

<!-- Agent directives. Cap: 150 lines / 6 KB. Critical rules are binding: a slice that needs to break one escalates. -->
`;

/** Merges the proposed rules into the file's text, skipping rules it already holds. */
export function mergeRules(existing: string | null, markdown: string): string {
  const rules = parseRules(markdown);
  let lines = (existing ?? SKELETON).replace(/\n+$/, "").split("\n");
  for (const [section, bullets] of rules) {
    const fresh = bullets.filter((b) => !lines.some((l) => l.trim() === b));
    if (fresh.length === 0) continue;
    const at = lines.findIndex((l) => l.trim().toLowerCase() === `## ${section}`.toLowerCase());
    if (at === -1) {
      lines.push("", `## ${section}`, "", ...fresh);
      continue;
    }
    let end = lines.length;
    for (let i = at + 1; i < lines.length; i++) {
      if (lines[i]!.startsWith("## ")) {
        end = i;
        break;
      }
    }
    while (end > at + 1 && lines[end - 1]!.trim() === "") end--;
    const tail = lines.slice(end);
    lines = [...lines.slice(0, end), ...(end === at + 1 ? [""] : []), ...fresh, ...(tail.length && tail[0]!.trim() !== "" ? [""] : []), ...tail];
  }
  return `${lines.join("\n")}\n`;
}

const OVERRIDE_KINDS: ReadonlySet<string> = new Set(["task.edited", "plan.edited", "cases.edited", "escalation.corrected", "ship.override"]);
const TIMELINE_MAX = 300;
const COMMENTS_MAX = 20;

/** The retro's facts for a finished task, from the machine's own records: predicted (the triage record, the plan's estimates) against actual (the diff, retries, escalations, format, wall time, a person's overrides, the review's rounds). The timeline holds event names and states only. */
export function retroFactsOf(input: {
  task: Pick<TaskRow, "record" | "diffAdded" | "diffRemoved" | "retries" | "evidence" | "createdAt" | "updatedAt">;
  ledger: Ledger | null;
  events: Array<Pick<EventRow, "kind" | "payload"> & { at?: Date }>;
  runs: number;
  /** The ship cursor's review counts and the fix rounds' summaries. */
  cursor?: { fixRounds: number; threads: Record<string, unknown>; fixes?: Array<{ summary: string }> } | null;
  costUsd?: number;
  declaredFiles?: number;
}): RetroFacts {
  const { task } = input;
  const est = (input.ledger?.slices ?? []).map((s) => s.estLoc).filter((n): n is number => typeof n === "number");
  const urgency = (task.record as { urgency?: unknown } | null)?.urgency;
  const nameOf = (e: { kind: string; payload: Record<string, unknown> }): string => (e.kind === "transition" ? `${String(e.payload.from ?? "?").slice(0, 40)}->${String(e.payload.to ?? "?").slice(0, 40)}` : e.kind.slice(0, 80));
  const timeline = input.events.slice(0, TIMELINE_MAX).map((e) => `${e.at ? e.at.toISOString() : "?"} ${nameOf(e)}`);
  const reviewComments = (input.cursor?.fixes ?? []).slice(0, COMMENTS_MAX).map((f) => postable(f.summary, 200)).filter(Boolean);
  return {
    predicted: { size: task.record?.size ?? null, risk: task.record?.risk ?? null, estLoc: est.length > 0 ? est.reduce((a, b) => a + b, 0) : null, ...(typeof urgency === "string" ? { urgency } : {}) },
    actual: {
      added: task.diffAdded ?? 0,
      removed: task.diffRemoved ?? 0,
      retries: { verify: task.retries.verify, e2e: task.retries.e2e, ci: task.retries.ci, total: task.retries.total },
      escalations: input.events.filter((e) => e.kind === "transition" && e.payload.to === "escalated").length,
      format: task.evidence?.format ?? null,
      durationMin: Math.max(0, Math.round((task.updatedAt.getTime() - task.createdAt.getTime()) / 60_000)),
      overrides: input.events.filter((e) => OVERRIDE_KINDS.has(e.kind)).length,
      ...(input.cursor ? { reviewRounds: input.cursor.fixRounds, reviewThreads: Object.keys(input.cursor.threads).length } : {}),
      ...(input.costUsd !== undefined ? { costUsd: input.costUsd } : {}),
      ...(input.declaredFiles !== undefined ? { declaredFiles: input.declaredFiles } : {}),
    },
    runs: input.runs,
    timeline,
    ...(reviewComments.length > 0 ? { reviewComments } : {}),
  };
}
