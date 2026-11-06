// Polls GitHub for labelled issues and turns each new one into a task in Intake, through the
// GitHub port. With a Jev credential, triage_signals reads each new issue first: a question Jev is
// sure of on every answer becomes no task, and the issue hears why once (once per run of the
// machine: it keeps no record of the comment); anything else becomes a task as before, with the
// classification kept on it.
import { classificationLine } from "@hardness/contracts";

import { type IssueClassifier, confidentQuestion } from "./classify.ts";
import type { GitHub } from "./github.ts";
import type { Pipeline } from "./pipeline.ts";

export interface GitHubIntakeOptions {
  pipeline: Pipeline;
  repos: string[];
  label: string;
  intervalMs: number;
  github: GitHub;
  /** The local checkout for `owner/name`, so an imported issue needs no hand edit; null when unknown. */
  resolveRepo?: (repo: string) => Promise<string | null>;
  /** triage_signals on Jev; absent or answering null, every new issue becomes a task as without it. */
  classifier?: IssueClassifier | null;
}

/** The items of an issue body's markdown checklist, e.g. `- [ ] text`. */
export function parseChecklist(body: string): string[] {
  const items: string[] = [];
  for (const line of body.split("\n")) {
    const match = /^\s*[-*]\s+\[[ xX]\]\s+(.*)$/.exec(line);
    const text = match?.[1]?.trim();
    if (text) items.push(text);
  }
  return items;
}

export class GitHubIntake {
  private timer: NodeJS.Timeout | undefined;
  private warnedAuth = false;
  /** Issues declined as questions, `owner/name#n`: not classified nor told again. */
  private readonly declined = new Set<string>();

  constructor(private readonly options: GitHubIntakeOptions) {}

  /** Polls now, then on every interval. Never throws. */
  start(): void {
    if (this.timer) return;
    const tick = () => void this.pollOnce().catch((error: unknown) => console.warn("github intake: poll failed", error));
    tick();
    this.timer = setInterval(tick, this.options.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async pollOnce(): Promise<void> {
    for (const repo of this.options.repos) {
      try {
        await this.pollRepo(repo);
      } catch (error) {
        console.warn(`github intake: ${repo}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private async pollRepo(repo: string): Promise<void> {
    let issues;
    try {
      issues = await this.options.github.listReadyIssues(repo, this.options.label);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/auth|token|401|403/i.test(message)) {
        if (this.warnedAuth) return;
        this.warnedAuth = true;
      }
      throw error;
    }
    let repoPath: string | null = null;
    if (issues.length > 0 && this.options.resolveRepo) {
      repoPath = await this.options.resolveRepo(repo).catch(() => null);
    }
    for (const issue of issues) {
      const ref = `${repo}#${issue.number}`;
      if (this.declined.has(ref) || (await this.options.pipeline.findBySource(repo, issue.number))) continue;
      const body = issue.body ?? "";
      const classification = (await this.options.classifier?.classify({ title: issue.title, description: body, labels: issue.labels ?? [], source: issue.url })) ?? null;
      if (confidentQuestion(classification)) {
        this.declined.add(ref);
        const line = classificationLine(classification);
        await this.options.github.commentOnIssue(repo, issue.number, `Not for an agent: it reads as a question, not a change (${line}).`).catch((error: unknown) => {
          console.warn(`github intake: comment on ${ref} failed: ${error instanceof Error ? error.message : String(error)}`);
        });
        console.log(`github intake: ${ref} not for an agent: classified as a question (${line})`);
        continue;
      }
      const task = await this.options.pipeline.createTask({
        title: issue.title,
        description: body,
        criteria: parseChecklist(body),
        repoPath,
        source: { kind: "github", repo, number: issue.number, url: issue.url, ...((issue.labels ?? []).length > 0 ? { labels: (issue.labels ?? []).slice(0, 50).map((l) => l.slice(0, 100)) } : {}) },
        ...(issue.author ? { reporter: { id: issue.author, channel: "github" } } : {}),
        // The card's classification is triage's: intake's reading only routed a report.
      });
      console.log(`github intake: ${repo}#${issue.number} -> task ${task.id}`);
    }
  }
}
