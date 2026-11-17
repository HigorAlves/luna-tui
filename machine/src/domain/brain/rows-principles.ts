// Rows of the company brain for a repository's principles (RFC 0010, "How facts get in"): the rules of its
// docs/agents/project-context.md on the default branch, copied so a search can find them. The file stays the truth. Pure: the caller
// reads the file and the journal's rows. A rule that left the file comes back retired, never deleted.
import { createHash } from "node:crypto";
import { brainEdge, brainNode, brainSlug, brainTime, type BrainNodeRow, type BrainRow } from "@hardness/contracts";

import { repoRows, type BrainRepo } from "./rows.ts";

/** The longest statement and section a row keeps. */
export const STATEMENT_MAX = 500;
export const SECTION_MAX = 120;
const NO_SECTION = "(no section)";

const oneLine = (text: string): string => text.replace(/<!--[\s\S]*?-->/g, " ").replace(/[\p{Cc}\p{Zl}\p{Zp}\s]+/gu, " ").trim();

interface Rule {
  statement: string;
  section: string;
}

/** The top-level `- ` items under each `## ` heading, in file order, one per distinct statement. */
function rulesOf(text: string): Rule[] {
  const rules: Rule[] = [];
  const seen = new Set<string>();
  let section = NO_SECTION;
  let open: string[] | null = null;
  const close = () => {
    if (open) {
      const statement = oneLine(open.join(" ")).slice(0, STATEMENT_MAX).trim();
      if (statement && !seen.has(statement)) {
        seen.add(statement);
        rules.push({ statement, section });
      }
    }
    open = null;
  };
  for (const line of text.split(/\r?\n/)) {
    const heading = /^##\s+(.*)$/.exec(line);
    if (heading || /^#{1,6}\s/.test(line)) {
      close();
      if (heading) section = oneLine(heading[1]!).slice(0, SECTION_MAX).trim() || NO_SECTION;
      continue;
    }
    const item = /^-(?:\s+(.*))?$/.exec(line);
    if (item) {
      close();
      open = [item[1] ?? ""];
    } else if (open && /^\s+\S/.test(line)) open.push(line);
    else close();
  }
  close();
  return rules;
}

const principleSlug = (repo: BrainRepo, statement: string): string => brainSlug("principle", `${repo.slug}/${createHash("sha256").update(statement).digest("hex").slice(0, 12)}`);

export function principleRows(text: string | null, repo: BrainRepo, context: { at: Date; /** The Principle rows of this repository the journal holds. */ held: readonly BrainNodeRow[] }): BrainRow[] {
  if (text === null) return [];
  const heldBy = new Map(context.held.map((row) => [String(row.data.slug), row]));
  const rows: BrainRow[] = [...repoRows(repo)];
  const inFile = new Set<string>();
  const repoSlug = brainSlug("repo", repo.slug);
  for (const rule of rulesOf(text)) {
    const slug = principleSlug(repo, rule.statement);
    inFile.add(slug);
    const recorded = heldBy.get(slug)?.data.recorded_at;
    rows.push(
      brainNode("Principle", { slug, statement: rule.statement, section: rule.section, status: "active", recorded_at: typeof recorded === "string" ? recorded : brainTime(context.at) }),
      brainEdge("PrincipleOfRepo", slug, repoSlug),
    );
  }
  for (const [slug, row] of heldBy) {
    if (inFile.has(slug)) continue;
    rows.push({ ...row, data: { ...row.data, status: "retired" } }, brainEdge("PrincipleOfRepo", slug, repoSlug));
  }
  return rows;
}
