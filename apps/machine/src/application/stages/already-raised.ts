// Before a review goes to the gate, each finding is set against the comments already on the PR (people and bots such
// as CodeRabbit): a finding that repeats one of them is dropped, with who said it first. Only comments by others on the
// same file near the line are compared, so the calls stay few. No decision, or an unsure one, keeps the finding.
import type { DecisionOverrides, Finding, ReviewContext } from "@hardness/contracts";

import { type Decide, judgeCheck } from "./check-decide.ts";

/** How far from a finding's line a comment still counts as the same place. */
export const NEAR_LINES = 15;
/** The most comments one finding is compared with, the nearest first. */
export const MAX_COMPARED = 4;
const BODY_MAX = 2000;

export interface RaisedDeps {
  decide: Decide | null;
  repoPath: string | null;
  decisions: Record<string, DecisionOverrides>;
  /** Our own login: its comments are our threads, never "already raised". */
  me: string | null;
  log?: (line: string) => void;
}

export interface AlreadyRaised {
  id: string;
  title: string;
  path: string;
  line: number;
  /** Who made the point first. */
  by: string;
}

/** How far a comment is from a line; a comment on the file as a whole counts as the edge of near. */
const gap = (comment: number | null, line: number): number => (comment === null ? NEAR_LINES : Math.abs(comment - line));

export async function dropAlreadyRaised(deps: RaisedDeps, findings: readonly Finding[], existing: ReviewContext["existingComments"]): Promise<{ kept: Finding[]; dropped: AlreadyRaised[] }> {
  if (!deps.decide || existing.length === 0) return { kept: [...findings], dropped: [] };
  const others = existing.filter((c) => c.author !== deps.me && c.path !== null);
  const judged = await Promise.all(
    findings.map(async (finding): Promise<AlreadyRaised | null> => {
      const candidates = others
        .filter((c) => c.path === finding.path && (c.line === null || Math.abs(c.line - finding.line) <= NEAR_LINES))
        .sort((a, b) => gap(a.line, finding.line) - gap(b.line, finding.line))
        .slice(0, MAX_COMPARED);
      for (const c of candidates) {
        const check = { kind: "finding" as const, finding, existing: { author: c.author, path: c.path, line: c.line, body: c.body.slice(0, BODY_MAX) } };
        const { verdict, answer } = await judgeCheck(deps.decide, "already_raised", check, deps.repoPath, deps.decisions, deps.log);
        const value = (answer?.same as { value?: unknown } | undefined)?.value;
        if (verdict === "proceed" && value === true) return { id: finding.id ?? "", title: finding.title, path: finding.path, line: finding.line, by: c.author };
      }
      return null;
    }),
  );
  return { kept: findings.filter((_, i) => judged[i] === null), dropped: judged.filter((j): j is AlreadyRaised => j !== null) };
}
