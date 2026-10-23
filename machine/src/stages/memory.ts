// The reviewing_memory stage: the retro pack reads `.orc/` and `git log` in the worktree and
// proposes additions to `docs/agents/project-context.md`. This wrapper shapes the approval's
// `requested.rules` from the pack's answer and the host copy of its `rules.md` artifact, and
// owns the merge that the close step applies when the proposal is approved.
import { readFile } from "node:fs/promises";

import type { StageContext, StageResult, StageRunner } from "./runner.ts";

export const CONTEXT_FILE = "docs/agents/project-context.md";
export const CAP_LINES = 150;
export const CAP_BYTES = 6144;

export interface MemoryDeps {
  /** Runs the reviewing_memory pack. */
  runPack: (context: StageContext) => Promise<StageResult>;
  stateDir: string;
}

const answerOf = (detail: Record<string, unknown> | undefined): Record<string, unknown> => {
  const answer = detail?.answer;
  return answer && typeof answer === "object" ? (answer as Record<string, unknown>) : {};
};

const countOf = (value: unknown): number => (Array.isArray(value) ? value.length : 0);

export function memoryReviewRunner(deps: MemoryDeps): StageRunner {
  return async (context) => {
    const result = await deps.runPack(context);
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
    if (markdown.trim() === "") {
      return {
        ...result,
        detail: { ...result.detail, rules: null, note: "no rules proposed: nothing repeated enough to be a pattern" },
      };
    }
    return {
      ...result,
      detail: {
        ...result.detail,
        rules: {
          markdown,
          proposedRules: Array.isArray(answer.proposedRules) ? answer.proposedRules : [],
          calibration: answer.calibration ?? null,
          incidents: countOf(answer.incidents),
          patterns: countOf(answer.patterns),
        },
      },
    };
  };
}

/**
 * `reviewing_memory` is a gate, not a stage, so the retro rides on the stage before it: after
 * shipping passes, the retro pack runs and its rules join the shipping detail the gate shows.
 * A retro that fails never fails the ship; the gate opens with `rules: null` and a note.
 */
export function withMemoryReview(ship: StageRunner, memory: StageRunner): StageRunner {
  return async (context) => {
    const shipped = await ship(context);
    if (shipped.outcome !== "pass") return shipped;
    let review: StageResult;
    try {
      review = await memory({ ...context, stage: "reviewing_memory" });
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      return { ...shipped, detail: { ...shipped.detail, rules: null, note: `memory review failed: ${why}` } };
    }
    const rules = review.detail?.rules ?? null;
    const note = review.outcome === "pass" ? review.detail?.note : `memory review failed: ${String(review.detail?.error ?? "unknown")}`;
    return {
      ...shipped,
      detail: { ...shipped.detail, rules: review.outcome === "pass" ? rules : null, ...(note ? { note } : {}) },
      artifacts: [...(shipped.artifacts ?? []), ...(review.artifacts ?? [])],
      events: [...(shipped.events ?? []), ...(review.events ?? [])],
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
