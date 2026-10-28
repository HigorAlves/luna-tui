// Polls Jira for the issues each repo's luna.yaml asks for (`jira.intake.jql`) and turns each
// new one into a ticket in Intake, after the jira_intake pack has read it: `ready` makes the
// ticket with the pack's title, description and criteria; `needs_brief` asks the questions back
// on the issue and waits for it to change; `not_for_agent` says why once and moves on. An
// issue already behind a ticket (by its key) is never imported twice; one the machine spoke
// last on is left alone until someone else writes. Like GitHubIntake, never throws.
import type { JiraIntakeAnswer } from "@hardness/contracts";

import type { Policy } from "../domain/policy.ts";
import type { TaskRow } from "../domain/task.ts";
import { parseChecklist } from "./intake.ts";
import { type Jira, JiraAuthError, type JiraIssue, type JiraMe, messageOf } from "./jira.ts";
import type { NewTask } from "./pipeline.ts";
import type { JiraTriager } from "./stages/jira-intake-runner.ts";

export interface JiraIntakeOptions {
  pipeline: {
    createTask(input: NewTask): Promise<TaskRow>;
    findByJiraKey(key: string): Promise<TaskRow | null>;
    record(id: string, kind: string, payload: Record<string, unknown>): Promise<void>;
  };
  jira: Jira;
  /** Each repo's luna.yaml, read on every pass so an edit applies at the next one. */
  policies: { for(repoPath: string | null): Promise<Policy> };
  /** The checkouts to look at: every repo the machine knows. */
  repos: () => Promise<string[]>;
  /** The jira_intake pack; null (agents off) imports every issue as it reads in Jira. */
  triager: JiraTriager | null;
  /** How often repos are checked for a due poll; each repo polls at its own `every`. */
  tickMs?: number;
  now?: () => Date;
  log?: (line: string) => void;
}

/** The most issues one pass reads per repo. */
export const INTAKE_PAGE = 50;
const DEFAULT_TICK_MS = 60_000;

/** The questions as the issue comment reads them. */
export function briefComment(answer: JiraIntakeAnswer): string {
  const lines = ["Before an agent starts on this, a few things need settling:", ""];
  for (const q of answer.questions ?? []) lines.push(`- ${q.question}${q.recommended ? ` (the agent would go with: ${q.recommended})` : ""}`);
  if (!answer.questions?.length) lines.push(`- ${answer.reason}`);
  lines.push("", "Edit the issue (or answer here) and it is picked up again.");
  return lines.join("\n");
}

export class JiraIntake {
  private timer: NodeJS.Timeout | undefined;
  private warnedAuth = false;
  private me: JiraMe | null = null;
  /** When each repo last polled. */
  private readonly lastPoll = new Map<string, number>();
  /** Issues answered with a brief or a refusal, by key, with the `updated` stamp they had; a changed issue is read again. */
  private readonly answered = new Map<string, string | null>();
  private readonly now: () => Date;
  private readonly log: (line: string) => void;

  constructor(private readonly options: JiraIntakeOptions) {
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? ((line) => console.log(line));
  }

  /** Checks every minute which repos are due, polls those. Never throws. */
  start(): void {
    if (this.timer) return;
    const tick = () => void this.tick().catch((error: unknown) => console.warn("jira intake: poll failed", error));
    tick();
    this.timer = setInterval(tick, this.options.tickMs ?? DEFAULT_TICK_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One pass: every repo whose `every` has elapsed since its last poll. */
  async tick(): Promise<void> {
    const repos = [...new Set(await this.options.repos())];
    for (const repoPath of repos) {
      let intake: NonNullable<Policy["jira"]>["intake"];
      let comments: NonNullable<Policy["jira"]>["comments"] = "milestones";
      try {
        const policy = (await this.options.policies.for(repoPath)).jira;
        intake = policy?.intake ?? null;
        comments = policy?.comments ?? "milestones";
      } catch {
        continue;
      }
      if (!intake) continue;
      const last = this.lastPoll.get(repoPath);
      const now = this.now().getTime();
      if (last !== undefined && now - last < intake.everySecs * 1000) continue;
      this.lastPoll.set(repoPath, now);
      try {
        await this.pollRepo(repoPath, intake.jql, comments);
      } catch (error) {
        if (error instanceof JiraAuthError) {
          if (!this.warnedAuth) console.warn(`jira intake: ${error.message}`);
          this.warnedAuth = true;
          return;
        }
        console.warn(`jira intake: ${repoPath}: ${messageOf(error)}`);
      }
    }
  }

  /** Polls one repo's JQL now, whatever its schedule says (tests, and a refresh). */
  async pollRepo(repoPath: string, jql: string, comments: "none" | "milestones" | "gates" = "milestones"): Promise<void> {
    const page = await this.options.jira.search(jql, { maxResults: INTAKE_PAGE });
    this.warnedAuth = false;
    for (const issue of page.issues) {
      if (await this.options.pipeline.findByJiraKey(issue.key)) continue;
      if (this.answered.has(issue.key) && this.answered.get(issue.key) === issue.updated) continue;
      if (await this.spokeLast(issue)) {
        this.answered.set(issue.key, issue.updated);
        continue;
      }
      try {
        await this.consider(issue, repoPath, comments);
      } catch (error) {
        if (error instanceof JiraAuthError) throw error;
        console.warn(`jira intake: ${issue.key}: ${messageOf(error)}`);
      }
    }
  }

  /** The issue's last comment is the machine's own: nothing has moved since it asked or declined. */
  private async spokeLast(issue: JiraIssue): Promise<boolean> {
    const last = issue.comments.at(-1);
    if (!last?.authorId) return false;
    this.me ??= await this.options.jira.me();
    return last.authorId === this.me.accountId;
  }

  private async consider(issue: JiraIssue, repoPath: string, comments: "none" | "milestones" | "gates"): Promise<void> {
    const answer: JiraIntakeAnswer = (await this.options.triager?.triage(issue, repoPath)) ?? { verdict: "ready", reason: "imported as written" };
    if (answer.verdict === "ready") {
      const task = await this.options.pipeline.createTask({
        title: answer.title?.trim() || issue.summary,
        description: answer.description?.trim() || issue.description,
        criteria: answer.criteria?.length ? answer.criteria : parseChecklist(issue.description),
        repoPath,
        source: { kind: "jira", key: issue.key, url: issue.url, issueType: issue.issueType },
      });
      await this.options.pipeline.record(task.id, "jira.intake", { key: issue.key, verdict: "ready", reason: answer.reason });
      if (comments !== "none") await this.comment(issue, `Picked up as task #${task.id.slice(0, 8)} on the Luna board. ${answer.reason}`.trim());
      this.log(`jira intake: ${issue.key} -> task ${task.id}`);
      return;
    }
    this.answered.set(issue.key, issue.updated);
    if (answer.verdict === "needs_brief") {
      await this.comment(issue, briefComment(answer));
      this.log(`jira intake: ${issue.key} needs a brief: ${answer.reason}`);
      return;
    }
    await this.comment(issue, `Not for an agent: ${answer.reason}`);
    this.log(`jira intake: ${issue.key} not for an agent: ${answer.reason}`);
  }

  private async comment(issue: JiraIssue, text: string): Promise<void> {
    try {
      await this.options.jira.comment(issue.key, text);
    } catch (error) {
      console.warn(`jira intake: comment on ${issue.key} failed: ${messageOf(error)}`);
    }
  }
}

/** The checkouts one level under `reposDir` that carry a luna.yaml, for intake to look at. */
export async function reposUnder(reposDir: string, deps: { readdir: (dir: string) => Promise<string[]>; exists: (path: string) => boolean }): Promise<string[]> {
  let names: string[];
  try {
    names = await deps.readdir(reposDir);
  } catch {
    return [];
  }
  return names.map((name) => `${reposDir.replace(/\/+$/, "")}/${name}`).filter((path) => deps.exists(`${path}/luna.yaml`));
}
