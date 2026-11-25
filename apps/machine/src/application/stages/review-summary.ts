// The body of a review read in parts. Each part's reviewer sees one slice of the PR, so their summaries describe a slice ("Shard 3 (…): …");
// glued together they read as noise. The machine writes this one instead, from what it knows of the whole: the PR's title, how many parts
// were read, the size, what was left out as generated, the findings by severity, what it was checked against, and what was not read, by folder.

const ORDER = ["security", "bug", "api-surface", "test", "suggestion", "question", "nit"];
const PLURAL: Record<string, string> = { bug: "bugs", test: "tests", suggestion: "suggestions", question: "questions", nit: "nits" };

const n = (count: number, one: string, many: string): string => `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;

/** "4 findings: 1 security, 2 suggestions, 1 nit." or "No findings." */
export function findingCounts(findings: ReadonlyArray<{ severity: string }>): string {
  if (findings.length === 0) return "No findings.";
  const by = new Map<string, number>();
  for (const f of findings) by.set(f.severity, (by.get(f.severity) ?? 0) + 1);
  const rank = (s: string): number => (ORDER.includes(s) ? ORDER.indexOf(s) : ORDER.length);
  const parts = [...by].sort((a, b) => rank(a[0]) - rank(b[0])).map(([s, c]) => `${c} ${c === 1 ? s : (PLURAL[s] ?? s)}`);
  return `${n(findings.length, "finding", "findings")}: ${parts.join(", ")}.`;
}

/** "gatherapi/services/ (8 files), migrations/versions/ (5) and 3 more folders": the biggest folders first, the rest folded. */
export function byDirectory(rows: ReadonlyArray<{ path: string }>, shown = 5): string {
  const by = new Map<string, number>();
  for (const r of rows) {
    const cut = r.path.lastIndexOf("/");
    const dir = cut < 0 ? "" : `${r.path.slice(0, cut)}/`;
    by.set(dir, (by.get(dir) ?? 0) + 1);
  }
  const sorted = [...by].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const head = sorted.slice(0, shown).map(([dir, count], i) => `${dir || "the root"} (${i === 0 ? n(count, "file", "files") : count})`);
  const rest = sorted.length - shown;
  if (rest > 0) return `${head.join(", ")} and ${rest} more ${rest === 1 ? "folder" : "folders"}`;
  return head.length > 1 ? `${head.slice(0, -1).join(", ")} and ${head.at(-1)}` : (head[0] ?? "");
}

export interface ShardedSummaryInput {
  title: string;
  parts: { reviewed: number; of: number };
  files: number;
  lines: number;
  /** Lock, generated, vendored and snapshot files left out before sharding. */
  skipped: number;
  findings: ReadonlyArray<{ severity: string }>;
  against: { tickets: readonly string[]; cards: readonly string[] };
  unreviewed: ReadonlyArray<{ path: string; lines: number }>;
  /** Parts not run because the PR had more than `review.max_shards`. */
  capped: number;
  /** Parts that ran and gave no answer. */
  failed: number;
}

export function shardedSummary(input: ShardedSummaryInput): string {
  const { parts } = input;
  const read = parts.reviewed === parts.of ? `reviewed in ${parts.of} parts by module` : `reviewed ${parts.reviewed} of ${parts.of} parts by module`;
  const skipped = input.skipped > 0 ? `; ${n(input.skipped, "lock or generated file", "lock or generated files")} skipped` : "";
  const size = `${n(input.files, "file", "files")}, ${n(input.lines, "line", "lines")}${skipped}`;
  const refs = [...input.against.tickets, ...input.against.cards.map((c) => `card ${c}`)];
  const against = refs.length > 0 ? `Reviewed against ${refs.length > 1 ? `${refs.slice(0, -1).join(", ")} and ${refs.at(-1)}` : refs[0]}.` : "No Jira ticket or board card linked; reviewed against the PR description.";
  const sentences = [`${input.title.trim().replace(/[.\s]+$/, "")}, ${read} (${size}).`, findingCounts(input.findings), against];
  if (input.unreviewed.length > 0) {
    const why = [input.failed > 0 ? `${n(input.failed, "part", "parts")} that did not finish` : "", input.capped > 0 ? `${n(input.capped, "part", "parts")} over the review.max_shards cap` : ""].filter(Boolean).join(" and ");
    sentences.push(`Not reviewed: ${n(input.unreviewed.length, "file", "files")}${why ? ` in ${why}` : ""}, in ${byDirectory(input.unreviewed)}.`);
  }
  return sentences.join(" ");
}
