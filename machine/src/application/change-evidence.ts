// The monthly change-management evidence (RFC 0008, wave 1). Once a month, for each repository, the previous month's merged
// PRs become a record each (facts from GitHub, computed by `changeRecord`) and one page, which waits as a draft for the person.
// The `change_exceptions` pack only explains the exceptions in the PRs' own words; a pack that fails never blocks the page.
// A cursor under `<stateDir>/compliance/` remembers the last month done per repo, so a daily tick does no work once it is.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ChangeExceptionsAnswer, type ChangeExceptionsContext, type ComplianceDraft } from "@hardness/contracts";
import { z } from "zod";

import { changeRecord, evidencePage, evidencePath, type ChangeRecord } from "../domain/change-evidence.ts";
import { postable } from "../domain/postable.ts";
import { COMPLIANCE_DIR, type ComplianceDrafts } from "./compliance-drafts.ts";
import type { GitHub } from "./github.ts";
import { findJiraKey } from "./jira.ts";

/** The controls the evidence answers, handed to the explainer. */
const CONTROLS = ["SOC2 CC8.1", "HIPAA 164.308(a)(1)(ii)(D)"];
/** The longest a PR body goes to the explainer: what `ChangeExceptionsContext` allows. */
const BODY_CAP = 2000;

const CursorSchema = z.object({ schema: z.literal(1), done: z.record(z.string(), z.string()) });
type Cursor = z.infer<typeof CursorSchema>;

/** The UTC month before `now`, as `YYYY-MM`. */
export function previousMonth(now: Date): string {
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return first.toISOString().slice(0, 7);
}

export interface ChangeEvidenceDeps {
  github: Pick<GitHub, "mergedPrs" | "ruleBypasses" | "prChecks">;
  drafts: Pick<ComplianceDrafts, "open">;
  /** The one run of the `change_exceptions` pack; its answer is validated here. */
  explain(context: ChangeExceptionsContext): Promise<unknown>;
  /** The `owner/name` of every repository the machine knows. */
  repos(): Promise<string[]>;
  stateDir: string;
  log?: (line: string) => void;
  now?: () => Date;
}

export class ChangeEvidence {
  private ticking: Promise<void> | null = null;
  private readonly log: (line: string) => void;
  private readonly now: () => Date;

  constructor(private readonly deps: ChangeEvidenceDeps) {
    this.log = deps.log ?? ((line) => console.warn(line));
    this.now = deps.now ?? (() => new Date());
  }

  /** The draft page for one repository and month (`YYYY-MM`, UTC), opened or refreshed. */
  async buildMonth(repo: string, period: string): Promise<ComplianceDraft> {
    const { github } = this.deps;
    const [year, month] = period.split("-").map(Number) as [number, number];
    const since = new Date(Date.UTC(year, month - 1, 1)).toISOString();
    const until = new Date(Date.UTC(year, month, 1) - 1).toISOString();
    const prs = await github.mergedPrs(repo, since, until);
    const bypasses = await github.ruleBypasses(repo, since, until);
    const records: ChangeRecord[] = [];
    const bodies = new Map<number, string>();
    for (const pr of prs) {
      const ref = pr.headSha ?? pr.mergeSha;
      const checks = ref ? await github.prChecks(repo, ref) : [];
      const jiraKey = findJiraKey(`${pr.title}\n${pr.body}\n${pr.headRef}`);
      records.push(changeRecord(pr, { checks, bypasses, jiraKey }));
      bodies.set(pr.number, pr.body);
    }
    const flagged = records.filter((r) => r.exceptions.length > 0);
    const { explanations, failed } = flagged.length > 0 ? await this.explain(repo, period, flagged, bodies) : { explanations: new Map<string, string>(), failed: false };
    const text = evidencePage({ repo, period, records, bypassUnknown: bypasses === "unknown", explanations, generatedAt: this.now().toISOString() });
    return this.deps.drafts.open({
      id: `change_evidence:${repo}:${period}`,
      kind: "change_evidence",
      repo,
      title: `Change management, ${repo}, ${period}`,
      period,
      summary: `${records.length} PRs, ${flagged.length} with exceptions${failed ? "; the explainer failed" : ""}`,
      text,
      targets: [{ kind: "wiki", repo, path: evidencePath(period) }],
    });
  }

  /** One pass: the previous month of `now` for each repo not done with it. A pass already running is joined, not doubled. */
  tick(now: Date = this.now()): Promise<void> {
    this.ticking ??= this.pass(previousMonth(now)).finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  private async pass(period: string): Promise<void> {
    const cursor = await this.loadCursor();
    for (const repo of await this.deps.repos()) {
      if (cursor.done[repo] === period) continue;
      try {
        await this.buildMonth(repo, period);
      } catch (error) {
        this.log(`compliance evidence: ${repo} ${period}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      cursor.done[repo] = period;
      await this.saveCursor(cursor);
    }
  }

  /** The explainer's text per `${pr}:${kind}`; empty, with `failed`, when the pack failed or its answer was not valid. */
  private async explain(repo: string, period: string, flagged: ChangeRecord[], bodies: Map<number, string>): Promise<{ explanations: Map<string, string>; failed: boolean }> {
    const explanations = new Map<string, string>();
    try {
      const context: ChangeExceptionsContext = {
        repo,
        period,
        controls: CONTROLS,
        exceptions: flagged.map((r) => ({
          pr: r.number,
          title: r.title,
          url: r.url,
          author: r.author,
          mergedBy: r.mergedBy,
          mergedAt: r.mergedAt,
          approvedBy: r.approvedBy,
          ticket: r.ticket,
          checks: r.checks,
          bypass: r.bypass,
          kinds: r.exceptions,
          body: (bodies.get(r.number) ?? "").slice(0, BODY_CAP),
        })),
      };
      const answer = ChangeExceptionsAnswer.parse(await this.deps.explain(context));
      const found = new Set(flagged.flatMap((r) => r.exceptions.map((kind) => `${r.number}:${kind}`)));
      for (const e of answer.explanations) {
        const key = `${e.pr}:${e.kind}`;
        const text = postable(e.text, 400);
        if (found.has(key) && text) explanations.set(key, text);
      }
      return { explanations, failed: false };
    } catch (error) {
      this.log(`compliance evidence: ${repo} ${period}: the explainer failed: ${error instanceof Error ? error.message : String(error)}`);
      return { explanations: new Map(), failed: true };
    }
  }

  private cursorFile(): string {
    return join(this.deps.stateDir, COMPLIANCE_DIR, "evidence-cursor.json");
  }

  /** A damaged or missing file is an empty cursor: every repo's month is built again. */
  private async loadCursor(): Promise<Cursor> {
    try {
      const parsed = CursorSchema.safeParse(JSON.parse(await readFile(this.cursorFile(), "utf8")));
      if (parsed.success) return parsed.data;
    } catch {
      // No file, or not JSON.
    }
    return { schema: 1, done: {} };
  }

  private async saveCursor(cursor: Cursor): Promise<void> {
    const file = this.cursorFile();
    await mkdir(join(this.deps.stateDir, COMPLIANCE_DIR), { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(cursor));
    await rename(tmp, file);
  }
}
