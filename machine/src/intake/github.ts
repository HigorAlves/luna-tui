// Polls GitHub for labelled issues and turns each new one into a backlog task. The `gh`
// CLI does the talking, so auth is whatever `gh auth login` set up.
import { defaultGh, type Gh, listReadyIssues } from "../github/gh.ts";
import type { Pipeline } from "../pipeline/pipeline.ts";

export type { Gh } from "../github/gh.ts";

export interface GitHubIntakeOptions {
  pipeline: Pipeline;
  repos: string[];
  label: string;
  intervalMs: number;
  /** Runs the gh CLI. Tests inject a fake. */
  gh?: Gh;
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
  private readonly gh: Gh;

  constructor(private readonly options: GitHubIntakeOptions) {
    this.gh = options.gh ?? defaultGh;
  }

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
      issues = await listReadyIssues(this.gh, repo, this.options.label);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/auth/i.test(message)) {
        if (this.warnedAuth) return;
        this.warnedAuth = true;
      }
      throw error;
    }
    for (const issue of issues) {
      if (await this.options.pipeline.findBySource(repo, issue.number)) continue;
      const body = issue.body ?? "";
      const task = await this.options.pipeline.createTask({
        title: issue.title,
        description: body,
        criteria: parseChecklist(body),
        repoPath: null,
        source: { kind: "github", repo, number: issue.number, url: issue.url },
      });
      console.log(`github intake: ${repo}#${issue.number} -> task ${task.id}`);
    }
  }
}
