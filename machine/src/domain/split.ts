// The script that checks the decomposer's list of children (wave 15). Pure. Issues are fixed words with positions and
// numbers only, never a child's text: they go back to the model on the next round and to a person at the gate.
import { CONTEXT_MIN_WORDS, type SplitChild, isPlainRepoPath, oneLine } from "@hardness/contracts";

export interface SplitOrigin {
  criteria: { id: string }[];
}
export interface SplitLimitsIn {
  hard: number;
  maxChildren: number;
}

const wordCount = (text: string): number => text.split(/\s+/).filter(Boolean).length;

/** Child positions (0-based) in a topological order, ties by the given `order`, then position; null when the dependencies cycle. */
function topological(children: SplitChild[]): number[] | null {
  const deps = children.map((c, i) => new Set(c.depends_on.filter((p) => p >= 1 && p <= children.length && p !== i + 1).map((p) => p - 1)));
  const done: number[] = [];
  const placed = new Set<number>();
  while (done.length < children.length) {
    const ready = children.map((_, i) => i).filter((i) => !placed.has(i) && [...deps[i]!].every((d) => placed.has(d)));
    if (ready.length === 0) return null;
    ready.sort((a, b) => children[a]!.order - children[b]!.order || a - b);
    const next = ready[0]!;
    placed.add(next);
    done.push(next);
  }
  return done;
}

/** What is wrong with a proposed split, and the children cleaned for storage: `order` recomputed (the array keeps its positions, which `depends_on` names), file hints reduced to plain repository paths, every text one line inside the schema's cap. */
export function splitFacts(children: SplitChild[], origin: SplitOrigin, limits: SplitLimitsIn): { issues: string[]; children: SplitChild[] } {
  const issues: string[] = [];
  if (children.length < 2 || children.length > limits.maxChildren) {
    issues.push(`the split has ${children.length} ${children.length === 1 ? "child" : "children"}; it needs 2 to ${limits.maxChildren}`);
  }
  children.forEach((c, i) => {
    const n = i + 1;
    if (c.est_loc > limits.hard) issues.push(`child ${n} is estimated at ${c.est_loc} lines, over the hard limit of ${limits.hard}`);
    for (const p of new Set(c.depends_on)) {
      if (p === n) issues.push(`child ${n} depends on itself`);
      else if (p < 1 || p > children.length) issues.push(`child ${n} depends on position ${p}, which does not exist`);
    }
  });
  const order = topological(children);
  if (order === null) issues.push("the children depend on each other in a cycle");
  if (origin.criteria.length > 0) {
    const known = new Set(origin.criteria.map((c) => c.id));
    const covered = new Set<string>();
    children.forEach((c, i) => {
      for (const id of new Set(c.covers)) {
        if (known.has(id)) covered.add(id);
        else issues.push(`child ${i + 1} names criterion ${id}, which the origin does not have`);
      }
    });
    for (const c of origin.criteria) if (!covered.has(c.id)) issues.push(`criterion ${c.id} is covered by no child`);
  }
  children.forEach((c, i) => {
    if (wordCount([c.title, c.goal, ...c.acceptance_criteria].join(" ")) < CONTEXT_MIN_WORDS) issues.push(`child ${i + 1} has fewer than ${CONTEXT_MIN_WORDS} words to work from`);
  });

  const rank = new Map<number, number>((order ?? children.map((_, i) => i)).map((pos, r) => [pos, r + 1]));
  const clean = children.map((c, i): SplitChild => ({
    ...c,
    title: oneLine(c.title, 200),
    goal: oneLine(c.goal, 1000),
    acceptance_criteria: c.acceptance_criteria.map((a) => oneLine(a, 300)),
    files_hint: c.files_hint.filter(isPlainRepoPath).slice(0, 20),
    order: rank.get(i)!,
  }));
  return { issues, children: clean };
}
