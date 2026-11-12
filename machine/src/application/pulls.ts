// The PR inbox's poller: every open PR involving you, from `gh`, classified and kept as one
// snapshot the board reads over HTTP and follows on the event stream. Like GitHubIntake it
// speaks through the GitHub port (Octokit, one token). Merging and cloning
// live here too, since both change what the next poll shows.
import { isAbsolute, dirname } from "node:path";
import { realpath, stat } from "node:fs/promises";

import type { PrAction, PrSnapshot, PullRequest } from "@hardness/contracts";

import { HOST_GIT } from "../adapters/git/worktree.ts";
import { type ExecResult, exec as realExec } from "../adapters/process/exec.ts";
import { type PrNode, fromGraphQl, splitOf, summarizeChecks } from "../domain/pull-request.ts";
import { type GitHub, type PrSearchHit, messageOf } from "./github.ts";
import { PrBusyError } from "./pr-tasks.ts";

/** What the HTTP routes need from the poller; the real class and a test fake both fit. */
export interface PullsPort {
  /** The inbox: PRs you opened and PRs asking your review. */
  readonly snapshot: PrSnapshot;
  /** Every open PR in the repos you can reach. */
  readonly all: PrSnapshot;
  pollOnce(): Promise<PrSnapshot>;
  pollAllOnce(): Promise<PrSnapshot>;
  merge(repo: string, number: number): Promise<void>;
  close(repo: string, number: number): Promise<void>;
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
  /** How often the all-list polls: slower than the inbox, since it reads every repo you reach. */
  allIntervalMs: number;
  /** The checkout for `owner/name`, or null when the machine has none. */
  resolveRepo: (repo: string) => Promise<string | null>;
  /** A clone just landed at `path`: later polls resolve `repo` to it. */
  rememberRepo?: (repo: string, path: string) => void;
  /** The PR task running for this PR, if any. */
  findTask: (repo: string, number: number) => Promise<PrTaskRef | null>;
  /** Called with the new snapshot when its PRs or its error changed. */
  publish: (snapshot: PrSnapshot) => void;
  /** The same for the all-list. */
  publishAll: (snapshot: PrSnapshot) => void;
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

/** Close asked for a PR the snapshot does not hold. */
export class NoPullError extends Error {
  constructor(repo: string, number: number) {
    super(`${repo}#${number} is not an open PR of yours`);
    this.name = "NoPullError";
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
/** What GitHub says when a budget is spent (the primary limit, or the secondary one). */
const RATE_LIMITED = /rate limit|RATE_LIMITED/i;
const key = (repo: string, number: number) => `${repo.toLowerCase()}#${number}`;

/**
 * A PR's facts are reused while its `updatedAt` is unchanged, but for no longer than this:
 * a check finishing or the base branch moving does not bump `updatedAt`, so the cache must expire.
 */
const FACTS_MAX_AGE_MS = 30 * 60_000;

/** The two lists the poller keeps; they differ only in where the PRs come from. */
type Feed = "inbox" | "all";

export class GitHubPulls implements PullsPort {
  /** The inbox: PRs you opened and PRs asking your review. */
  snapshot: PrSnapshot = { prs: [], polledAt: null, error: null };
  /** Every open PR in the repos you can reach, built like the inbox. */
  all: PrSnapshot = { prs: [], polledAt: null, error: null };
  /** The clone in progress, if any; awaited by tests and by nobody else. */
  cloning: Promise<void> = Promise.resolve();
  /** How long until the next inbox poll: the interval, or the backoff after a rate limit. */
  nextDelayMs: number;
  /** The same for the all-list. */
  allNextDelayMs: number;

  private timer: NodeJS.Timeout | undefined;
  private allTimer: NodeJS.Timeout | undefined;
  private stopped = false;
  private polling: Promise<PrSnapshot> | null = null;
  private pollingAll: Promise<PrSnapshot> | null = null;
  private warnedAuth = false;
  private warnedCapped = "";
  private me: { login: string; teams: string[] } | null = null;
  /** The last GraphQL node of each PR, read at `updatedAt`; both lists read and fill it. */
  private readonly facts = new Map<string, { node: PrNode; updatedAt: string; at: number }>();
  private readonly now: () => Date;

  constructor(private readonly options: GitHubPullsOptions) {
    this.now = options.now ?? (() => new Date());
    this.nextDelayMs = options.intervalMs;
    this.allNextDelayMs = options.allIntervalMs;
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
    // The all-list waits for the inbox's first poll, so the PRs both lists share are read once.
    const tickAll = () => {
      void (this.polling ?? Promise.resolve())
        .then(() => this.pollAllOnce())
        .catch((error: unknown) => console.warn("github prs: poll of all failed", error))
        .finally(() => {
          if (this.stopped) return;
          this.allTimer = setTimeout(tickAll, this.allNextDelayMs);
          this.allTimer.unref();
        });
    };
    tickAll();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.allTimer) clearTimeout(this.allTimer);
    this.timer = undefined;
    this.allTimer = undefined;
  }

  /** One poll; a poll already running is shared rather than doubled. */
  pollOnce(): Promise<PrSnapshot> {
    if (!this.polling) {
      this.polling = this.poll("inbox").finally(() => {
        this.polling = null;
      });
    }
    return this.polling;
  }

  /** One poll of the all-list; a poll already running is shared rather than doubled. */
  pollAllOnce(): Promise<PrSnapshot> {
    if (!this.pollingAll) {
      this.pollingAll = this.poll("all").finally(() => {
        this.pollingAll = null;
      });
    }
    return this.pollingAll;
  }

  private async whoAmI(): Promise<{ login: string; teams: string[] }> {
    if (!this.me) this.me = await this.options.github.viewer();
    return this.me;
  }

  private async poll(feed: Feed): Promise<PrSnapshot> {
    const polledAt = this.now().toISOString();
    const label = feed === "inbox" ? "github prs" : "github prs (all)";
    let prs: PullRequest[];
    let error: string | null = null;
    let delay = feed === "inbox" ? this.options.intervalMs : this.options.allIntervalMs;
    try {
      prs = await this.fetchAll(feed);
    } catch (thrown) {
      error = messageOf(thrown);
      prs = this.listOf(feed).prs;
      if (/rate limit|RATE_LIMITED|\(403\)/i.test(error)) delay = RATE_LIMIT_BACKOFF_MS;
      if (/auth|credentials|token|401/i.test(error)) {
        if (!this.warnedAuth) console.warn(`${label}: ${error}`);
        this.warnedAuth = true;
      } else {
        console.warn(`${label}: ${error}`);
      }
    }
    if (feed === "inbox") this.nextDelayMs = delay;
    else this.allNextDelayMs = delay;
    return this.replace(feed, { prs, polledAt, error });
  }

  private listOf(feed: Feed): PrSnapshot {
    return feed === "inbox" ? this.snapshot : this.all;
  }

  /** Stores the snapshot and publishes it when the PRs or the error changed. */
  private replace(feed: Feed, next: PrSnapshot): PrSnapshot {
    const before = this.listOf(feed);
    const changed = JSON.stringify(next.prs) !== JSON.stringify(before.prs) || next.error !== before.error;
    if (feed === "inbox") this.snapshot = next;
    else this.all = next;
    if (changed) (feed === "inbox" ? this.options.publish : this.options.publishAll)(next);
    return next;
  }

  /** The PRs to list: yours (the search), or every one in the repos you reach. */
  private async hitsOf(feed: Feed): Promise<PrSearchHit[]> {
    if (feed === "inbox") return this.options.github.searchMyPrs();
    const { hits, capped } = await this.options.github.listOpenPrs();
    // One query reads a repo's newest 100 open PRs; say which repos have more instead of dropping them quietly.
    const note = capped.map((c) => `${c.repo} has ${c.open} open PRs, only the newest 100 are listed`).join("; ");
    if (note && note !== this.warnedCapped) console.warn(`github prs (all): ${note}`);
    this.warnedCapped = note;
    return hits;
  }

  /** The PR's node: the cached one while `updatedAt` stands, else read from GitHub (and kept when it has settled). */
  private async nodeOf(hit: PrSearchHit): Promise<PrNode | null> {
    const k = key(hit.repo, hit.number);
    const kept = this.facts.get(k);
    const at = this.now().getTime();
    if (kept && kept.updatedAt === hit.updatedAt && at - kept.at < FACTS_MAX_AGE_MS) return kept.node;
    const node = await this.options.github.prFacts(hit.repo, hit.number);
    // Running checks and a merge GitHub is still computing change without touching `updatedAt`, so those are read again next time.
    if (node && node.mergeable !== "UNKNOWN" && summarizeChecks(node.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? []).state !== "pending") {
      this.facts.set(k, { node, updatedAt: hit.updatedAt, at });
    } else {
      this.facts.delete(k);
    }
    return node;
  }

  private async fetchAll(feed: Feed): Promise<PullRequest[]> {
    const me = await this.whoAmI();
    const hits = await this.hitsOf(feed);
    // One GraphQL call per PR, a few at a time: a long list otherwise takes half a minute.
    let limited: string | null = null;
    const found = await mapLimit(hits, FETCH_AT_ONCE, async (hit): Promise<PullRequest | null> => {
      let node;
      try {
        node = await this.nodeOf(hit);
      } catch (error) {
        const said = messageOf(error);
        // A spent GraphQL budget fails every PR alike: that is the poll failing (below), not forty PRs gone.
        if (RATE_LIMITED.test(said)) limited ??= said;
        else console.warn(`github prs: ${hit.repo}#${hit.number}: ${said}`);
        return null;
      }
      if (!node) return null;
      const facts = fromGraphQl(node, hit.repo, me.login, me.teams);
      const [localPath, task] = await Promise.all([
        this.options.resolveRepo(hit.repo).catch(() => null),
        this.options.findTask(hit.repo, hit.number).catch(() => null),
      ]);
      return { ...facts, split: splitOf(facts), localPath, task };
    });
    this.dropStaleFacts();
    // The poll fails as a whole: the last list stays, the snapshot says why, and the next poll waits (`poll`), so the budget gets the quiet it needs.
    // Search and GraphQL have separate budgets, so the search can succeed while every PR's facts are refused.
    if (limited) throw new Error(limited);
    return found.filter((pr): pr is PullRequest => pr !== null);
  }

  /** The PR as the last poll saw it: the inbox first, then the all-list, so a PR the All repos tab shows can be acted on too. */
  find(repo: string, number: number): PullRequest | null {
    const wanted = key(repo, number);
    return this.snapshot.prs.find((p) => key(p.repo, p.number) === wanted) ?? this.all.prs.find((p) => key(p.repo, p.number) === wanted) ?? null;
  }

  /** Squash-merges a PR the snapshot shows as ready, then polls so it drops off the list. */
  async merge(repo: string, number: number): Promise<void> {
    const pr = this.find(repo, number);
    if (!pr || pr.split !== "ready_to_merge") throw new NotReadyError(repo, number);
    await this.options.github.mergePr(repo, number);
    await this.pollAfterChange();
  }

  /** Closes a PR without merging, unless a task is working on it, then polls so it drops off the list. */
  async close(repo: string, number: number): Promise<void> {
    const pr = this.find(repo, number);
    if (!pr) throw new NoPullError(repo, number);
    if (pr.task) throw new PrBusyError(repo, number, pr.task.id);
    await this.options.github.closePr(repo, number);
    await this.pollAfterChange();
  }

  /** A merge or a close changed GitHub: the inbox is read before answering, the all-list (if it was ever read) in the background, since it is slow. */
  private async pollAfterChange(): Promise<void> {
    if (this.all.polledAt !== null) void this.pollAllOnce();
    await this.pollOnce();
  }

  /** A clone landed: the inbox polls as before, and the all-list only re-resolves its checkouts, which needs no call to GitHub. */
  private async pollAfterClone(): Promise<void> {
    await Promise.all([this.pollOnce(), this.relinkAll()]);
  }

  private async relinkAll(): Promise<void> {
    const prs = await Promise.all(
      this.all.prs.map(async (pr) => ({ ...pr, localPath: await this.options.resolveRepo(pr.repo).catch(() => null) })),
    );
    this.replace("all", { ...this.all, prs });
  }

  /** Forgets facts older than they may be reused, so PRs that left both lists do not pile up. */
  private dropStaleFacts(): void {
    const at = this.now().getTime();
    for (const [k, kept] of this.facts) if (at - kept.at >= FACTS_MAX_AGE_MS) this.facts.delete(k);
  }

  /**
   * Clones `owner/name` into `dest` in the background: an absolute path whose parent exists
   * and which does not exist yet. Once it lands, both lists show the checkout.
   */
  async clone(repo: string, dest: string): Promise<void> {
    if (!isAbsolute(dest)) throw new CloneError(`dest must be an absolute path, got "${dest}"`);
    const parent = await stat(dirname(dest)).catch(() => null);
    if (!parent?.isDirectory()) throw new CloneError(`the parent of "${dest}" does not exist`);
    const exec = this.options.exec ?? realExec;
    if (await stat(dest).catch(() => null)) {
      // The folder you picked already holds the repo (a renamed remote, a checkout the scan
      // never looked in): link it rather than refuse, and never clone over it.
      if (!(await isCheckoutRoot(exec, dest))) throw new CloneError(`"${dest}" already exists and is not a git checkout`);
      this.options.rememberRepo?.(repo, dest);
      this.cloning = this.cloning.then(() => this.pollAfterClone());
      return;
    }
    this.cloning = this.cloning.then(async () => {
      // A clone is git with your own credentials, like every push the machine makes.
      const cloned = await exec("git", [...HOST_GIT, "clone", `https://github.com/${repo}.git`, dest]);
      if (cloned.code !== 0) {
        this.replace("inbox", { ...this.snapshot, error: `clone of ${repo} failed: ${(cloned.stderr || cloned.stdout).trim()}` });
        return;
      }
      this.options.rememberRepo?.(repo, dest);
      await this.pollAfterClone();
    });
  }
}

/** True when `dir` is itself the top of a git working tree (not just a folder inside one). */
async function isCheckoutRoot(exec: typeof realExec, dir: string): Promise<boolean> {
  const top = await exec("git", ["-C", dir, "rev-parse", "--show-toplevel"]);
  if (top.code !== 0) return false;
  const [a, b] = await Promise.all([realpath(top.stdout.trim()), realpath(dir)]).catch(() => [null, null]);
  return a !== null && a === b;
}

/** How many PRs are read from GitHub at once. */
const FETCH_AT_ONCE = 6;

/** `fn` over `items`, at most `limit` at a time, results in the order of `items`. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const at = next++;
      out[at] = await fn(items[at]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
