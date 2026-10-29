// The jira_intake pack as a runner: one Jira issue goes through the factory runner in the stage
// container, like every stage, with the same image and credential, before any ticket exists.
// /work is a clean checkout of the repo's default branch (`<worktrees>/<repo>/jira-intake`,
// fetched and reset before every run; never your live checkout, with whatever sits uncommitted
// in it), mounted read-only (the pack has Read, Glob and Grep, so it can check the ask against
// the code); with no repo, an empty folder. The issue rides in
// `context.jira`, the verdict comes back in /out/result.json. There is no row to record: the
// ticket it makes (or does not) is the record, and the line logged says the rest.
import { JiraIntakeAnswer, type JiraIntakeContext, PACKS, StageOutput } from "@hardness/contracts";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Credential } from "../../adapters/docker/credentials.ts";
import { type SandboxResult, type SandboxRun, runSandbox } from "../../adapters/docker/docker.ts";
import { ensureCleanCheckout, intakeCheckoutPath } from "../../adapters/git/worktree.ts";
import { buildJiraIntakeInput } from "../../domain/stage-input.ts";
import type { JiraIssue } from "../jira.ts";

export interface JiraIntakeDeps {
  /** The base stage image; the same one the packs run in. */
  image: string;
  credential: Credential;
  stateDir: string;
  /** Where the intake checkouts live, beside the task worktrees. */
  worktreesDir: string;
  /** Replaces the docker sandbox; tests pass a fake. */
  sandbox?: (run: SandboxRun) => Promise<SandboxResult>;
  /** Prepares the clean checkout of a repo and answers its path; tests pass a fake. */
  checkout?: (repoPath: string) => Promise<string>;
  now?: () => Date;
  /** One line per run; defaults to console.log. */
  log?: (line: string) => void;
}

/** The port JiraIntake triages through; null (agents off) imports every issue as it is. */
export interface JiraTriager {
  /** The pack's verdict on one issue, or null when the run failed (logged). */
  triage(issue: JiraIssue, repoPath: string | null): Promise<JiraIntakeAnswer | null>;
}

/** Where the runs live under the state dir; each run is a folder named by the issue and its start time. */
export const JIRA_INTAKE_DIR = "jira-intake";
const MINUTE = 60_000;

/** The pack's input block for one issue. */
export function jiraContext(issue: JiraIssue, repoPath: string | null): JiraIntakeContext {
  return {
    key: issue.key,
    url: issue.url,
    summary: issue.summary,
    description: issue.description,
    issueType: issue.issueType,
    priority: issue.priority,
    labels: issue.labels,
    dueAt: issue.dueAt,
    comments: issue.comments.map((c) => `${c.author}: ${c.text}`),
    repoPath,
  };
}

/** The JiraTriager that runs the jira_intake pack in the stage container, one run per issue. */
export function createJiraTriager(deps: JiraIntakeDeps): JiraTriager {
  const pack = PACKS.jira_intake;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((line: string) => console.log(line));
  const sandbox = deps.sandbox ?? runSandbox;
  const checkout = deps.checkout ?? ((repoPath: string) => ensureCleanCheckout(repoPath, intakeCheckoutPath(repoPath, deps.worktreesDir)));

  return {
    async triage(issue, repoPath) {
      const startedAt = now();
      const stamp = `${issue.key}-${startedAt.toISOString().replace(/[:.]/g, "-")}`;
      const runDir = join(deps.stateDir, JIRA_INTAKE_DIR, stamp);
      await mkdir(runDir, { recursive: true });
      const input = buildJiraIntakeInput(jiraContext(issue, repoPath));
      let answer: JiraIntakeAnswer | null = null;
      let error: string | null = null;
      let usage: { model: string; turns: number; costUsd: number | null } = { model: pack.model, turns: 0, costUsd: null };
      try {
        // The pack reads the repo through its own clean checkout, never the live one.
        let work: string;
        if (repoPath) {
          try {
            work = await checkout(repoPath);
          } catch (thrown) {
            throw new Error(`could not prepare the checkout of ${repoPath}: ${thrown instanceof Error ? thrown.message : String(thrown)}`);
          }
        } else {
          work = join(runDir, "work");
          await mkdir(work, { recursive: true });
        }
        const result = await sandbox({
          name: `hardness-jira-intake-${stamp.toLowerCase()}`,
          image: deps.image,
          runDir,
          worktree: work,
          writable: false,
          gitDir: null,
          input: input as unknown as Record<string, unknown>,
          timeoutMs: input.limits.timeoutMs,
          credential: deps.credential,
          labels: { luna: "jira-intake" },
        });
        if (result.aborted) error = "aborted";
        else if (result.timedOut) error = `timed out after ${input.limits.timeoutMs / MINUTE} minutes`;
        else {
          const raw = await readFile(join(runDir, "out", "result.json"), "utf8").catch(() => null);
          const output = raw === null ? null : StageOutput.safeParse(JSON.parse(raw));
          if (!output) error = `the container left no result (exit code ${result.exitCode})`;
          else if (!output.success) error = `unreadable result: ${output.error.issues.map((i) => i.message).join("; ")}`;
          else {
            const out = output.data;
            usage = { model: out.usage.model || pack.model, turns: out.usage.turns, costUsd: out.usage.costUsd };
            if (!out.ok) error = typeof out.error === "string" ? out.error : out.error ? JSON.stringify(out.error) : out.summary || "the stage failed";
            else {
              const parsed = JiraIntakeAnswer.safeParse(out.answer);
              if (!parsed.success) error = `the answer did not match the schema: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`;
              else answer = parsed.data;
            }
          }
        }
      } catch (thrown) {
        error = thrown instanceof Error ? thrown.message : String(thrown);
      }
      const cost = usage.costUsd === null ? "" : ` · $${usage.costUsd.toFixed(4)}`;
      log(answer ? `jira intake: ${issue.key} ${answer.verdict}: ${answer.reason} (${usage.turns} turn(s)${cost})` : `jira intake: ${issue.key} failed: ${error}`);
      return answer;
    },
  };
}
