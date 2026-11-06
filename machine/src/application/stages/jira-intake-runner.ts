// The jira_intake pack as a runner: one Jira issue goes through the factory runner in the stage
// container, like every stage, with the same image and its engine's credential, before any ticket exists.
// /work is a clean checkout of the repo's default branch (`<worktrees>/<repo>/jira-intake`,
// fetched and reset before every run; never your live checkout, with whatever sits uncommitted
// in it), mounted read-only (the pack has Read, Glob and Grep, so it can check the ask against
// the code); with no repo, an empty folder. The issue rides in
// `context.jira`, the verdict comes back in /out/result.json. There is no row to record: the
// ticket it makes (or does not) is the record, and the line logged says the rest. The run folder
// (`<stateDir>/jira-intake/<key>-<time>`: the issue's text, the transcript) goes once the run
// answered; a failed run's stays, so the transcript says why, until the retention sweep.
import type { EgressPolicy } from "../egress-policy.ts";
import { JiraIntakeAnswer, type JiraIntakeContext, PACKS, type TaskClassification, resolveEngine } from "@hardness/contracts";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import type { Credentials } from "../../adapters/credentials/index.ts";
import type { SandboxResult, SandboxRun } from "../../adapters/docker/docker.ts";
import { ensureCleanCheckout, intakeCheckoutPath } from "../../adapters/git/worktree.ts";
import { buildJiraIntakeInput } from "../../domain/stage-input.ts";
import type { JiraIssue } from "../jira.ts";
import { pickEngine } from "../engine.ts";
import { PolicyStore } from "../policy.ts";
import { outputError, runPackOnce } from "./run-once.ts";

export interface JiraIntakeDeps {
  /** The base stage image; the same one the packs run in. */
  image: string;
  /** Each engine's credential; a run gets only its own engine's. */
  credentials: Credentials;
  /** Each repo's luna.yaml, whose `engines.jira_intake` the run follows; defaults to a store of its own. */
  policies?: PolicyStore;
  stateDir: string;
  /** Where the intake checkouts live, beside the task worktrees. */
  worktreesDir: string;
  /** Replaces the docker sandbox; tests pass a fake. */
  sandbox?: (run: SandboxRun) => Promise<SandboxResult>;
  /** The list a pack run may reach; absent, the run joins an ordinary bridge as before. */
  egress?: EgressPolicy;
  /** Prepares the clean checkout of a repo and answers its path; tests pass a fake. */
  checkout?: (repoPath: string) => Promise<string>;
  now?: () => Date;
  /** One line per run; defaults to console.log. */
  log?: (line: string) => void;
}

/** The port JiraIntake triages through; null (agents off) imports every issue as it is. */
export interface JiraTriager {
  /** The pack's verdict on one issue, or null when the run failed (logged). `classification`,
   *  triage_signals's first read when intake ran it, rides in the pack's context as a hint. */
  triage(issue: JiraIssue, repoPath: string | null, classification?: TaskClassification | null): Promise<JiraIntakeAnswer | null>;
}

/** Where the runs live under the state dir; each run is a folder named by the issue and its start time. */
export const JIRA_INTAKE_DIR = "jira-intake";

/** The pack's input block for one issue. */
export function jiraContext(issue: JiraIssue, repoPath: string | null, classification: TaskClassification | null = null): JiraIntakeContext {
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
    ...(classification ? { classification } : {}),
  };
}

/** The JiraTriager that runs the jira_intake pack in the stage container, one run per issue. */
export function createJiraTriager(deps: JiraIntakeDeps): JiraTriager {
  const pack = PACKS.jira_intake;
  const policies = deps.policies ?? new PolicyStore();
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((line: string) => console.log(line));
  const checkout = deps.checkout ?? ((repoPath: string) => ensureCleanCheckout(repoPath, intakeCheckoutPath(repoPath, deps.worktreesDir)));

  return {
    async triage(issue, repoPath, classification = null) {
      const startedAt = now();
      const stamp = `${issue.key}-${startedAt.toISOString().replace(/[:.]/g, "-")}`;
      const runDir = join(deps.stateDir, JIRA_INTAKE_DIR, stamp);
      await mkdir(runDir, { recursive: true });
      // No task yet: the repo's luna.yaml, else the pack's default.
      const { engine } = await pickEngine(deps.credentials, pack, null, (await policies.for(repoPath)).engines);
      // What the run is recorded as when the result names no model: the pinned ID it was started on.
      const model = resolveEngine(engine).modelId;
      const input = buildJiraIntakeInput(jiraContext(issue, repoPath, classification), engine);
      let answer: JiraIntakeAnswer | null = null;
      let error: string | null = null;
      let usage: { model: string; turns: number; costUsd: number | null } = { model, turns: 0, costUsd: null };
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
        const run = await runPackOnce(
          { name: `hardness-jira-intake-${stamp.toLowerCase()}`, image: deps.image, runDir, worktree: work, input, engine, labels: { luna: "jira-intake" } },
          { credentials: deps.credentials, sandbox: deps.sandbox, ...(deps.egress ? { egress: deps.egress } : {}) },
        );
        if (run.error !== null) error = run.error;
        else {
          const out = run.output;
          usage = { model: out.usage.model || model, turns: out.usage.turns, costUsd: out.usage.costUsd };
          if (!out.ok) error = outputError(out);
          else {
            const parsed = JiraIntakeAnswer.safeParse(out.answer);
            if (!parsed.success) error = `the answer did not match the schema: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`;
            else answer = parsed.data;
          }
        }
      } catch (thrown) {
        error = thrown instanceof Error ? thrown.message : String(thrown);
      }
      const cost = usage.costUsd === null ? "" : ` · $${usage.costUsd.toFixed(4)}`;
      log(answer ? `jira intake: ${issue.key} ${answer.verdict}: ${answer.reason} (${usage.turns} turn(s)${cost})` : `jira intake: ${issue.key} failed: ${error}`);
      if (answer) await rm(runDir, { recursive: true, force: true }).catch(() => {});
      return answer;
    },
  };
}
