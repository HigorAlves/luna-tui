// The PR inbox's poller: every open PR involving you, from `gh`, classified and kept as one
// snapshot the board reads over HTTP and follows on the event stream. Like GitHubIntake it
// speaks through the GitHub port (Octokit, one token). Merging and cloning
// live here too, since both change what the next poll shows.
import { isAbsolute, dirname } from "node:path";
import { stat } from "node:fs/promises";

import type { PrAction, PrSnapshot, PullRequest } from "@hardness/contracts";

import { HOST_GIT } from "../adapters/git/worktree.ts";
import { type ExecResult, exec as realExec } from "../adapters/process/exec.ts";
import { fromGraphQl, splitOf } from "../domain/pull-request.ts";
import { type GitHub, messageOf } from "./github.ts";

/** What the HTTP routes need from the poller; the real class and a test fake both fit. */
export interface PullsPort {
  readonly snapshot: PrSnapshot;
  pollOnce(): Promise<PrSnapshot>;
  merge(repo: string, number: number): Promise<void>;
  clone(repo: string, dest: string): Promise<void>;
}

/** The PR task in flight for a PR, as the snapshot shows it. */
export interface PrTaskRef {
  id: string;
  state: string;
  route: PrAction;
}

export interface GitHubPullsOptions {
  intervalMs: number;
  /** The checkout for `owner/name`, or null when the machine has none. */
  resolveRepo: (repo: string) => Promise<string | null>;
  /** A clone just landed at `path`: later polls resolve `repo` to it. */
  rememberRepo?: (repo: string, path: string) => void;
  /** The PR task running for this PR, if any. */
  findTask: (repo: string, number: number) => Promise<PrTaskRef | null>;
  /** Called with the new snapshot when its PRs or its error changed. */
  publish: (snapshot: PrSnapshot) => void;
  github: GitHub;
  /** Runs git for the clone; tests inject a fake. */
  exec?: (command: string, args: string[]) => Promise<ExecResult>;
  now?: () => Date;
}

/** Merge asked for a PR that is not in Ready to merge (or not in the snapshot at all). */
export class NotReadyError extends Error {
  constructor(repo: string, number: number) {
    super(`${repo}#${number} is not ready to merge`);
    this.name = "NotReadyError";
  }
}

/** Clone asked for a destination the machine will not write to. */
export class CloneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloneError";
  }
}

const RATE_LIMIT_BACKOFF_MS = 5 * 60_000;
const key = (repo: string, number: number) => `${repo.toLowerCase()}#${number}`;

export class GitHubPulls implements PullsPort {
  snapshot: PrSnapshot = { prs: [], polledAt: null, error: null };
  /** The clone in progress, if any; awaited by tests and by nobody else. */
  cloning: Promise<void> = Promise.resolve();
  /** How long until the next poll: the interval, or the backoff after a rate limit. */
  nextDelayMs: number;

  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private polling: Promise<PrSnapshot> | null = null;
  private warnedAuth = false;
  private me: { login: string; teams: string[] } | null = null;
  private readonly now: () => Date;

  constructor(private readonly options: GitHubPullsOptions) {
    this.now = options.now ?? (() => new Date());
    this.nextDelayMs = options.intervalMs;
  }

  /** Polls now, then again after each poll's delay. Never throws. */
  start(): void {
    if (this.timer || this.stopped) return;
    const tick = () => {
      void this.pollOnce()
        .catch((error: unknown) => console.warn("github prs: poll failed", error))
        .finally(() => {
          if (this.stopped) return;
          this.timer = setTimeout(tick, this.nextDelayMs);
          this.timer.unref();
        });
    };
    tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** One poll; a poll already running is shared rather than doubled. */
  pollOnce(): Promise<PrSnapshot> {
    if (!this.polling) {
      this.polling = this.poll().finally(() => {
        this.polling = null;
      });
    }
    return this.polling;
  }

  private async whoAmI(): Promise<{ login: string; teams: string[] }> {
    if (!this.me) this.me = await this.options.github.viewer();
    return this.me;
  }

  private async poll(): Promise<PrSnapshot> {
    const polledAt = this.now().toISOString();
    let prs: PullRequest[];
    let error: string | null = null;
    try {
      prs = await this.fetchAll();
      this.nextDelayMs = this.options.intervalMs;
    } catch (thrown) {
      error = messageOf(thrown);
      prs = this.snapshot.prs;
      if (/rate limit|RATE_LIMITED|\(403\)/i.test(error)) this.nextDelayMs = RATE_LIMIT_BACKOFF_MS;
      if (/auth|credentials|token|401/i.test(error)) {
        if (!this.warnedAuth) console.warn(`github prs: ${error}`);
        this.warnedAuth = true;
      } else {
        console.warn(`github prs: ${error}`);
      }
    }
    return this.replace({ prs, polledAt, error });
  }

  /** Stores the snapshot and publishes it when the PRs or the error changed. */
  private replace(next: PrSnapshot): PrSnapshot {
    const changed = JSON.stringify(next.prs) !== JSON.stringify(this.snapshot.prs) || next.error !== this.snapshot.error;
    this.snapshot = next;
    if (changed) this.options.publish(next);
    return next;
  }

  private async fetchAll(): Promise<PullRequest[]> {
    const me = await this.whoAmI();
    const hits = await this.options.github.searchMyPrs();
    const prs: PullRequest[] = [];
    for (const hit of hits) {
      let node;
      try {
        node = await this.options.github.prFacts(hit.repo, hit.number);
      } catch (error) {
        console.warn(`github prs: ${hit.repo}#${hit.number}: ${messageOf(error)}`);
        continue;
      }
      if (!node) continue;
      const facts = fromGraphQl(node, hit.repo, me.login, me.teams);
      const [localPath, task] = await Promise.all([
        this.options.resolveRepo(hit.repo).catch(() => null),
        this.options.findTask(hit.repo, hit.number).catch(() => null),
      ]);
      prs.push({ ...facts, split: splitOf(facts), localPath, task });
    }
    return prs;
  }

  /** The PR as the last poll saw it. */
  find(repo: string, number: number): PullRequest | null {
    return this.snapshot.prs.find((p) => key(p.repo, p.number) === key(repo, number)) ?? null;
  }

  /** Squash-merges a PR the snapshot shows as ready, then polls so it drops off the list. */
  async merge(repo: string, number: number): Promise<void> {
    const pr = this.find(repo, number);
    if (!pr || pr.split !== "ready_to_merge") throw new NotReadyError(repo, number);
    await this.options.github.mergePr(repo, number);
    await this.pollOnce();
  }

  /**
   * Clones `owner/name` into `dest` in the background: an absolute path whose parent exists
   * and which does not exist yet. The next poll after it lands shows the checkout.
   */
  async clone(repo: string, dest: string): Promise<void> {
    if (!isAbsolute(dest)) throw new CloneError(`dest must be an absolute path, got "${dest}"`);
    const parent = await stat(dirname(dest)).catch(() => null);
    if (!parent?.isDirectory()) throw new CloneError(`the parent of "${dest}" does not exist`);
    if (await stat(dest).catch(() => null)) throw new CloneError(`"${dest}" already exists`);
    const exec = this.options.exec ?? realExec;
    this.cloning = this.cloning.then(async () => {
      // A clone is git with your own credentials, like every push the machine makes.
      const cloned = await exec("git", [...HOST_GIT, "clone", `https://github.com/${repo}.git`, dest]);
      if (cloned.code !== 0) {
        this.replace({ ...this.snapshot, error: `clone of ${repo} failed: ${(cloned.stderr || cloned.stdout).trim()}` });
        return;
      }
      this.options.rememberRepo?.(repo, dest);
      await this.pollOnce();
    });
  }
}
