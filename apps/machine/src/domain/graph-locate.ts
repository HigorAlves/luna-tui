// Where in the code a ticket points: a lexical match of its words against the code graph's node labels and
// paths. No model, no embeddings; pure, and linear in the graph (each node is tokenised once). The graph is
// the same `graph.json` shape the blast radius reads.

type End = string | { id: string };

export interface LocateGraph {
  nodes?: Array<{ id: string; label?: string; source_file?: string; community?: number | string }>;
  links?: Array<{ source: End; target: End }>;
}

export interface Located {
  /** Files by their best node's score, best first, at most 20. */
  files: string[];
  /** Labels of the nodes that matched, best first, at most 20. */
  symbols: string[];
  /** The graph's communities of the top files' nodes, most matched first. */
  components: string[];
  /** 0 when nothing matched; otherwise from the top score and its margin over the runner-up, in (0, 1). */
  confidence: number;
}

export const MAX_LOCATED = 20;
/** Text past this is not read, and only this many distinct words are matched: a ticket body is attacker-sized. */
const MAX_TEXT_CHARS = 20_000;
const MAX_WORDS = 300;

const STOP = new Set(
  "the and for with that this from are was were when what where which while into onto over under not but can could would should will has have had been being its their there then than also just only any all some more most very you your our they them his her she him use uses used using get gets got set sets new add adds src lib app index test tests spec".split(" "),
);
const EXACT = 3;
const TOKEN = 1;
const PATH = 0.5;

/** Lower-case words of at least three characters, camelCase, snake_case, kebab-case and path separators split, stop words dropped. */
export function tokens(text: string): string[] {
  const split = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  return split
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOP.has(t));
}

const normal = (path: string): string => path.replace(/^(\.\/|\/work\/)/, "");

export function locate(graph: LocateGraph, text: string): Located {
  const clipped = text.slice(0, MAX_TEXT_CHARS);
  const words = new Set(tokens(clipped).slice(0, MAX_WORDS));
  // Whole identifiers as written ("applyCoupon" -> "applycoupon"), for an exact symbol match.
  const whole = new Set(
    clipped
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((w) => w.length >= 3)
      .slice(0, MAX_WORDS),
  );
  if (words.size === 0 && whole.size === 0) return { files: [], symbols: [], components: [], confidence: 0 };

  const files = new Map<string, number>();
  const bestNode = new Map<string, { label: string; score: number; community: string | null }[]>();
  const hits: { label: string; score: number; file: string | null; community: string | null }[] = [];
  for (const node of graph.nodes ?? []) {
    const file = node.source_file ? normal(node.source_file) : null;
    const label = node.label ?? "";
    let score = 0;
    const labelTokens = new Set(tokens(label));
    for (const t of labelTokens) if (words.has(t)) score += TOKEN;
    const exact = label.length >= 3 && whole.has(label.toLowerCase());
    if (exact) score += EXACT;
    let pathScore = 0;
    if (file) for (const t of new Set(tokens(file))) if (words.has(t)) pathScore += PATH;
    // A path alone names a file, but only a label match names a symbol.
    if (score === 0 && pathScore === 0) continue;
    const total = score + pathScore;
    const community = node.community === undefined ? null : String(node.community);
    if (score > 0) hits.push({ label, score: total, file, community });
    if (file) {
      files.set(file, Math.max(files.get(file) ?? 0, total));
      if (community !== null) {
        const list = bestNode.get(file) ?? [];
        list.push({ label, score: total, community });
        bestNode.set(file, list);
      }
    }
  }

  const ranked = [...files].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (ranked.length === 0) return { files: [], symbols: [], components: [], confidence: 0 };
  const topFiles = ranked.slice(0, MAX_LOCATED);
  const symbols: string[] = [];
  for (const hit of hits.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label))) {
    if (!symbols.includes(hit.label)) symbols.push(hit.label);
    if (symbols.length >= MAX_LOCATED) break;
  }
  const votes = new Map<string, number>();
  for (const [file] of topFiles.slice(0, 5)) for (const n of bestNode.get(file) ?? []) if (n.community) votes.set(n.community, (votes.get(n.community) ?? 0) + n.score);
  const components = [...votes].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([c]) => c).slice(0, 5);

  const top = topFiles[0]![1];
  const second = topFiles[1]?.[1] ?? 0;
  const margin = (top - second) / top;
  const confidence = Math.round((top / (top + 4)) * (0.5 + 0.5 * margin) * 100) / 100;
  return { files: topFiles.map(([f]) => f), symbols, components, confidence };
}
