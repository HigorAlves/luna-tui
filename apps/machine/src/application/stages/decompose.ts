// The decomposition loop (wave 15): proposes the children of a split, checks them by script, then asks split_check.
// It makes nothing: no card, no ticket, no event. It ends in a list a person will read at the split gate, or in a
// reason a person will read instead. Limits (rounds, children) come from the repository's luna.yaml, by the caller.
import { type DecisionOverrides, DecomposeAnswer, PACKS, type SizeLimits, type SplitChild, type SplitContext, applyPolicy } from "@hardness/contracts";

import { safe } from "../../domain/evidence-markdown.ts";
import { splitFacts } from "../../domain/split.ts";
import { recordIdOf } from "../decision-truth.ts";

export interface DecomposeDeps {
  /** One agent run of `decompose` on the split context; its answer is read as a `DecomposeAnswer`. */
  decompose: (context: SplitContext) => Promise<Record<string, unknown>>;
  /** One `split_check` decision; null leaves the script alone to decide. */
  check: ((context: SplitContext) => Promise<Record<string, unknown>>) | null;
  /** The repository's bars for split_check. */
  bars: Record<string, DecisionOverrides[string]> | undefined;
}

export interface DecomposeInput {
  origin: { title: string; text: string; criteria: { id: string; text: string }[] };
  files: { path: string; role?: string }[];
  limits: Pick<SizeLimits, "target" | "hard" | "maxChildren" | "maxRounds">;
  /** A person's comment when the split was sent back, for a new set of rounds. */
  note?: string;
}

export type DecomposeResult =
  | { ok: true; children: SplitChild[]; rounds: number; judged: boolean; recordId?: string }
  | { ok: false; reason: string; children: SplitChild[]; issues: string[]; rounds: number };

/** What a "no" from split_check says to the next round: fixed words, never the model's own. */
const CHECK_SENTENCES: Record<string, string> = {
  covers: "the children together leave something out of the original",
  no_overlap: "a piece of the work is in more than one child",
  stand_alone: "a child cannot be merged and tested on its own",
};

const cap = (text: string, max: number): string => safe(text).slice(0, max);

export async function decompositionLoop(deps: DecomposeDeps, input: DecomposeInput): Promise<DecomposeResult> {
  const { limits } = input;
  const origin = {
    title: cap(input.origin.title, 500),
    text: cap(input.origin.text, 4000),
    criteria: input.origin.criteria.slice(0, 20).map((c) => ({ id: cap(c.id, 20), text: cap(c.text, 500) })),
  };
  const files = input.files.slice(0, 40).map((f) => ({ path: cap(f.path, 300), ...(f.role ? { role: cap(f.role, 100) } : {}) }));
  const note = input.note ? cap(input.note, 2000) : undefined;
  const limit = { target: limits.target, hard: limits.hard, maxChildren: limits.maxChildren };

  let children: SplitChild[] = [];
  let issues: string[] = [];
  for (let round = 1; round <= limits.maxRounds; round++) {
    const context: SplitContext = { origin, files, limit, children, round, ...(issues.length ? { issues } : {}), ...(note ? { note } : {}) };
    let parsed: ReturnType<typeof DecomposeAnswer.safeParse>;
    try {
      parsed = DecomposeAnswer.safeParse(await deps.decompose(context));
    } catch {
      parsed = DecomposeAnswer.safeParse(undefined);
    }
    if (!parsed.success) {
      issues = ["the last answer could not be read as a list of children"];
      continue;
    }
    const facts = splitFacts(parsed.data.children, origin, { hard: limits.hard, maxChildren: limits.maxChildren });
    children = facts.children;
    issues = facts.issues;
    if (issues.length > 0) continue;
    if (!deps.check) return { ok: true, children, rounds: round, judged: false };

    let checked: Record<string, unknown> | null = null;
    let verdicts: Record<string, string> = {};
    try {
      checked = await deps.check({ ...context, children, issues: [] });
      // An answer that leaves a question out cannot be judged: the script alone decides.
      verdicts = applyPolicy({ questions: PACKS.split_check.questions, policy: PACKS.split_check.policy }, checked, deps.bars).verdicts;
    } catch {
      checked = null;
    }
    if (!checked) return { ok: true, children, rounds: round, judged: false };
    const answered = checked;
    issues = Object.keys(PACKS.split_check.questions).flatMap((q) => {
      const value = (answered[q] as { value?: unknown } | undefined)?.value;
      return value !== true || verdicts[q] === "ask" ? [CHECK_SENTENCES[q] ?? `${q}: the check was not satisfied`] : [];
    });
    if (issues.length === 0) {
      const recordId = recordIdOf(answered);
      return { ok: true, children, rounds: round, judged: true, ...(recordId ? { recordId } : {}) };
    }
  }
  return { ok: false, reason: `no valid split after ${limits.maxRounds} rounds`, children, issues, rounds: limits.maxRounds };
}
