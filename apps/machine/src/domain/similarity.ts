// Intake's shortlist of "might be the same problem": a lexical similarity, no embeddings and no model. The judgement is a decision pack's.
export const SHORTLIST = 5;
/** Below this a candidate is not worth a model's attention. */
export const FLOOR = 0.2;
/** A ticket body is attacker-sized: only this many characters are read, and this many distinct words kept. */
const READ_CHARS = 4000;
const MAX_WORDS = 300;
const DAY = 86_400_000;
const STOP = new Set(["the", "and", "for", "with", "when", "this", "that", "from", "are", "was", "has", "not", "but", "its", "can", "you", "our"]);

function words(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.slice(0, READ_CHARS).toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (w.length < 3 || STOP.has(w)) continue;
    out.add(w);
    if (out.size >= MAX_WORDS) break;
  }
  return out;
}

const round = (n: number): number => Math.round(n * 1000) / 1000;

/** Words in common over words in all, in 0 to 1. */
export function similarity(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return round(shared / (x.size + y.size - shared));
}

export interface Candidate {
  id: string;
  kind: "open" | "closed" | "backlog";
  title: string;
  text: string;
  repo: string | null;
  closedAt: Date | null;
}

export interface Near {
  id: string;
  kind: Candidate["kind"];
  score: number;
}

export function similar(
  card: { title: string; text: string; repo: string | null },
  candidates: Candidate[],
  options: { now: Date; lookbackDays: number },
): Near[] {
  const since = options.now.getTime() - options.lookbackDays * DAY;
  return candidates
    .filter((c) => (c.kind === "closed" ? c.closedAt !== null && c.closedAt.getTime() >= since : true))
    .filter((c) => (c.kind === "backlog" ? c.repo === card.repo : true))
    .map((c) => ({ id: c.id, kind: c.kind, score: similarity(`${card.title} ${card.text}`, `${c.title} ${c.text}`) }))
    .filter((n) => n.score >= FLOOR)
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
    .slice(0, SHORTLIST);
}
